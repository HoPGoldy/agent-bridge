/**
 * Per-channel scheduler for scheduled tasks (spec D8/D9, ticket T3).
 *
 * One instance per channel, owned by the channel runner. It owns:
 *
 * - the tick loop (default 30 s; spec D8 hot reload by polling) that
 *   re-scans the flat schedules directory through `loadAllTasks` and
 *   re-syncs the in-memory task table, so added/edited/deleted/disabled tasks
 *   take effect on the next tick;
 * - ownership filtering (T2): every scheduler scans all task files, but the
 *   tick fires only tasks whose front-matter `channel` equals this channel's
 *   config name. Tasks owned by other channels and unbound tasks (no
 *   `channel`) are never fired on schedule. The in-memory table still
 *   mirrors every task because target-claiming must resolve any task by
 *   name; fire-time validation additionally refuses tasks bound to another
 *   channel for `/schedule-run` and the timed tick alike;
 * - due-time evaluation (`now >= nextRun`, at most one fire per task per
 *   tick, no bursting) and next-run recomputation (spec D4/D8);
 * - the run registry: one record per run, keyed by the run-unique synthetic
 *   session id, each with its own timeout timer; a run ends when the
 *   scheduler receives its completion signal through
 *   {@link Scheduler.handleOutput} or when the timer fires (spec D5);
 * - firing: a synthetic `command.session.new` (canonical working directory,
 *   `workingDirectorySource: "default"`) followed by a `user.message`, both
 *   carrying a run-unique synthetic `schedule:<task-name>:<run-seq>`
 *   clientSessionId (spec D1), plus fire-time validation of the target and
 *   working directory (spec D6/D7).
 *
 * All external interaction goes through the injected callbacks:
 * `dispatchClientEvent` (synthetic client-output events — the runner wires
 * it to the core's input path), `deliver` (egress events to a task's
 * `target` chat) and `t` (the per-channel translator). The runner diverts
 * `schedule:*` agent output into {@link Scheduler.handleOutput}. This module
 * deliberately knows nothing about the agent adapter or the core; T4/T5 wire
 * it up.
 */

import type {
  ClientInputEvent,
  ClientOutputEvent,
  IngressResult,
  ScheduleHereResult,
} from "../../types";
import type { Translator } from "../../i18n";
import { createLogger, type Logger } from "../../core/logger";
import { validateWorkingDirectory } from "../client/utils/working-directory";
import { nextRun } from "./grammar";
import {
  buildProbeMessage,
  buildTaskPrompt,
  classifyMessage,
  createRunAccumulator,
  createSilenceProbe,
  type RunAccumulator,
  type SilenceProbe,
} from "../run-completion";
import {
  bindTask,
  loadAllTasks,
  type LoadedTask,
  type ScheduleTask,
} from "./task-file";

/** Default tick interval: 30 s (spec D8). */
export const DEFAULT_TICK_MS = 30_000;

/** Synthetic clientSessionId prefix for task runs (spec D1). Shared with the core. */
export const SYNTHETIC_SESSION_PREFIX = "schedule:";

/** Outcome of a fire: `{ ok: true }` or a caller-facing English reason. */
export type FireResult = { ok: true } | { ok: false; reason: string };

export interface SchedulerOptions {
  channelName: string;
  tickMs?: number;
  now?: () => Date;
  /**
   * Dispatches a synthetic client-output event (`session.new` +
   * `user.message`) into the core's ingress during a fire, returning the
   * ingress result. The core never rejects: a failed session creation
   * resolves `{ ok: false, reason }`, and the fire must stop right there
   * instead of letting the follow-up `user.message` auto-create a model-less
   * session (T6).
   */
  dispatchClientEvent: (event: ClientOutputEvent) => Promise<IngressResult>;
  /** Egress events delivered to a task's `target` chat (result/failure/notice). */
  deliver: (event: ClientInputEvent) => Promise<void>;
  /** Per-channel translator, e.g. `getTranslatorForCommon(common)`. */
  t: Translator;
  /**
   * Optional target validator (the client module's session-id parser). When
   * provided, a task whose `target` fails the check is skipped and only
   * logged — there is nowhere to deliver an error to (spec D7).
   */
  validateTarget?: (clientSessionId: string) => boolean;
  logger?: Logger;
  /**
   * Task loader override, defaults to `loadAllTasks` from `./task-file`.
   * Tests inject a fake, or point {@link SchedulerOptions.schedulesRoot} at a
   * temporary directory.
   */
  loadTasks?: (schedulesRoot?: string) => Promise<LoadedTask[]>;
  /** Overridable schedules root (defaults to the shared `SCHEDULES_DIR`). */
  schedulesRoot?: string;
  /** Overridable run-outputs root for the per-run accumulator (tests). */
  outputsDir?: string;
}

interface TaskRow {
  task: ScheduleTask;
  /** Next trigger time, or `null` when the task has no valid schedule. */
  nextRun: Date | null;
}

interface RunRecord {
  /** The run-unique synthetic clientSessionId (`schedule:<task>:<seq>`). */
  sessionId: string;
  task: ScheduleTask;
  startedAt: number;
  timer: NodeJS.Timeout;
  /** Per-run output accumulator (T3): every assistant message is appended here. */
  accumulator: RunAccumulator;
  /** Per-run silence probe (T3): fires a probing user.message after inactivity. */
  probe: SilenceProbe;
}

export class Scheduler {
  readonly #channelName: string;
  readonly #tickMs: number;
  readonly #now: () => Date;
  readonly #dispatchClientEvent: (event: ClientOutputEvent) => Promise<IngressResult>;
  readonly #deliver: (event: ClientInputEvent) => Promise<void>;
  readonly #t: Translator;
  readonly #validateTarget?: (clientSessionId: string) => boolean;
  readonly #logger: Logger;
  readonly #loadTasks: (schedulesRoot?: string) => Promise<LoadedTask[]>;
  readonly #schedulesRoot?: string;
  readonly #outputsDir?: string;

  /** In-memory task table, re-synced from disk on every tick (spec D8). */
  readonly #tasks = new Map<string, TaskRow>();
  /**
   * Active runs keyed by their run-unique synthetic session id. Concurrent
   * runs of the same task coexist as independent records (spec D5).
   */
  readonly #runs = new Map<string, RunRecord>();

  /** Monotonically increasing run sequence, making every run id unique. */
  #runSeq = 0;

  #started = false;
  #tickTimer: NodeJS.Timeout | null = null;

  constructor(options: SchedulerOptions) {
    this.#channelName = options.channelName;
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.#now = options.now ?? (() => new Date());
    this.#dispatchClientEvent = options.dispatchClientEvent;
    this.#deliver = options.deliver;
    this.#t = options.t;
    this.#validateTarget = options.validateTarget;
    this.#logger = options.logger ?? createLogger("schedule");
    // T1: the task-file layer is channel-agnostic; the loader scans the flat
    // shared directory (ownership lives in each task's `channel` front-matter
    // field, not in the directory layout).
    this.#loadTasks = options.loadTasks ?? ((schedulesRoot) => loadAllTasks(schedulesRoot));
    this.#schedulesRoot = options.schedulesRoot;
    this.#outputsDir = options.outputsDir;
  }

  /**
   * Starts the tick loop and performs the initial task-table sync. A missed
   * fire while stopped is never made up (spec D9): next runs are computed
   * from the current clock.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#tick();
    this.#scheduleNextTick();
  }

  /**
   * Stops the tick loop and clears every timer (including run timeout
   * timers). In-flight task sessions are left alone: the core teardown shuts
   * them down like any ordinary session (spec D9).
   */
  async stop(): Promise<void> {
    this.#started = false;
    if (this.#tickTimer) {
      clearTimeout(this.#tickTimer);
      this.#tickTimer = null;
    }
    for (const record of this.#runs.values()) {
      clearTimeout(record.timer);
      record.probe.stop();
      // Stop contract (T3, unchanged): nothing is delivered after stop, and
      // the accumulation file is KEPT — it may hold partial work that is
      // still readable at run-outputs/<run-id>.md.
    }
    this.#runs.clear();
  }

  /**
   * Routes a diverted agent-output event for a `schedule:*` session (T3,
   * three-layer completion protocol per qa-log 2026-08-19（二）).
   *
   * `assistant.message` no longer ends the run: it is classified against the
   * DONE-marker protocol, appended to the run's accumulator and pokes the
   * silence probe. When DONE is detected the run ends and the LAST assistant
   * message (with all attachments collected across the run) is delivered
   * once; the full transcript stays in the kept accumulation file that the
   * suffix references. Every other live-run event merely pokes the probe
   * (activity resets the silence window). A terminal `error` ends the run
   * with a localized failure notice (the partial transcript is not inlined).
   * Events whose run-unique id has no active run are orphaned: dropped and
   * logged.
   */
  async handleOutput(event: ClientInputEvent): Promise<void> {
    const parsed = parseSyntheticSessionId(event.clientSessionId);
    if (parsed === null) return;

    // Attribution is by the exact run id: a late event from an already
    // ended run can never hit a newer run of the same task (spec D5).
    const record = this.#runs.get(event.clientSessionId);
    if (record === undefined) {
      this.#logger.info(`[schedule] dropping orphan output for run "${event.clientSessionId}"`);
      return;
    }

    if (event.type === "assistant.message") {
      await this.#handleAssistantMessage(record, event);
      return;
    }

    if (event.type === "error") {
      await this.#handleError(record, event);
      return;
    }

    // Every other event for a live run counts as activity: it resets the
    // silence window so the probe does not fire while work is observable.
    record.probe.poke();
  }

  /** Classifies, accumulates and (on DONE) finishes an assistant message. */
  async #handleAssistantMessage(
    record: RunRecord,
    event: Extract<ClientInputEvent, { type: "assistant.message" }>,
  ): Promise<void> {
    const text = event.text ?? "";
    // An intermediate message (no marker) is accumulated and does NOT end
    // the run; a message carrying the DONE marker is stripped and ends it.
    const { done, content } = classifyMessage(text);
    await record.accumulator.append(content, event.attachments);
    record.probe.poke();
    if (!done) {
      return;
    }
    this.#endRun(record.sessionId);
    await this.#deliverDone(record);
  }

  /**
   * Delivers the run's LAST assistant message (marker stripped) plus an
   * italic suffix referencing the kept accumulation file (or a no-output
   * notice when the last message is empty). Attachments collected across the
   * whole run still go with the delivery.
   */
  async #deliverDone(record: RunRecord): Promise<void> {
    const { task } = record;
    const target = task.target;
    if (target === undefined) {
      this.#logger.warn(`[schedule] task "${task.name}" has no target to deliver its result to`);
      return;
    }
    const filePath = record.accumulator.filePath;
    const lastMessage = record.accumulator.lastMessage.trim();
    const attachments = record.accumulator.collectedAttachments.map((a) => ({
      kind: "file" as const,
      filePath: a.filePath,
      ...(a.fileName !== undefined ? { fileName: a.fileName } : {}),
    }));
    // The accumulation file is kept: the suffix points recipients at it.
    if (lastMessage === "") {
      // Spec edge case: never deliver silence. Attachments collected across
      // the whole run still go with the delivery (same as the non-empty
      // branch): the no-output notice is the text payload when they exist.
      const suffix = this.#t("schedule.taskNoOutputSuffix", { name: task.name, path: filePath });
      if (attachments.length === 0) {
        void this.#deliverToTarget(target, suffix);
      } else {
        void this.#deliverToTarget(target, {
          type: "assistant.message",
          clientSessionId: target,
          text: suffix,
          attachments,
        });
      }
    } else {
      const suffix = this.#t("schedule.taskCompletedSuffix", { name: task.name, path: filePath });
      void this.#deliverToTarget(target, {
        type: "assistant.message",
        clientSessionId: target,
        text: `${lastMessage}\n\n${suffix}`,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    }
  }

  /** Ends a run on a terminal error, delivering the reason (no inlined transcript). */
  async #handleError(
    record: RunRecord,
    event: Extract<ClientInputEvent, { type: "error" }>,
  ): Promise<void> {
    const { task } = record;
    const target = task.target;
    this.#endRun(record.sessionId);
    if (target === undefined) {
      this.#logger.warn(`[schedule] task "${task.name}" has no target to deliver its failure to`);
      return;
    }
    // The reason stays visible; the partial transcript is NOT inlined — it
    // lives in the kept accumulation file that the suffix references.
    const suffix = this.#t("schedule.taskFailedSuffix", {
      name: task.name,
      path: record.accumulator.filePath,
    });
    const detail = (event.detail ?? "").trim();
    const notice = detail === "" ? suffix : `${detail}\n\n${suffix}`;
    void this.#deliverToTarget(target, notice);
  }

  /**
   * Runs the task through the exact same path as a scheduled fire (spec
   * D7a): reloads the task file, validates target/directory/prompt,
   * dispatches the two synthetic events and registers a timeout-bounded run.
   * The localized error reply for the triggering chat is the caller's job.
   */
  async runNow(taskName: string): Promise<FireResult> {
    return this.#fire(taskName);
  }

  /** The shared fire path; `runNow` is an alias (spec D7a). */
  async fire(taskName: string): Promise<FireResult> {
    return this.#fire(taskName);
  }

  /**
   * Binds a chat as the task's delivery target (spec D7, `/schedule-here`):
   * writes the sending chat's `clientSessionId` and this channel's config
   * name into the task file's `target`/`channel` front-matter lines in a
   * single atomic write. The task must exist — resolved from the in-memory
   * task table, falling back to an immediate directory load so a file
   * written after the last tick is still claimable. A task that is already
   * bound (`target` or `channel` set, judged against the latest file
   * content) is refused with "task already bound": unbinding is a manual/AI
   * file edit — there is no command for it. Unknown task or a write failure
   * returns `{ ok: false, reason }`; the localized reply for the triggering
   * chat is the caller's job.
   */
  async claimTarget(taskName: string, clientSessionId: string): Promise<ScheduleHereResult> {
    let exists = this.#tasks.has(taskName);
    if (!exists) {
      try {
        const loaded = await this.#loadTasks(this.#schedulesRoot);
        exists = loaded.some((entry) => entry.task.name === taskName);
      } catch (error) {
        this.#logger.error(
          `[schedule] failed to load tasks while claiming target for "${taskName}":`,
          error,
        );
        return { ok: false, reason: "task not found" };
      }
    }
    if (!exists) {
      this.#logger.warn(`[schedule] task "${taskName}" not found; nothing to claim`);
      return { ok: false, reason: "task not found" };
    }
    // Binding check against the latest file content (T2): a task is bound
    // when its front matter carries a `target` or a `channel` (either line
    // is written at bind time). Bound tasks must be unbound — by editing
    // the file manually — before they can be claimed again.
    const latest = await this.#loadTaskFresh(taskName);
    if (latest !== undefined && (latest.target !== undefined || latest.channel !== undefined)) {
      this.#logger.warn(`[schedule] task "${taskName}" is already bound; refusing to rebind`);
      return { ok: false, reason: "task already bound" };
    }
    return bindTask(
      taskName,
      { target: clientSessionId, channel: this.#channelName },
      this.#schedulesRoot,
    );
  }

  async #fire(taskName: string): Promise<FireResult> {
    // SF-2: never start work (and never register a run/timer) once stopped.
    if (!this.#started) {
      this.#logger.warn(`[schedule] scheduler is not running; skipping fire of "${taskName}"`);
      return { ok: false, reason: "scheduler is not running" };
    }
    const task = await this.#loadTaskFresh(taskName);
    if (task === undefined) {
      this.#logger.warn(`[schedule] task "${taskName}" not found; skipping fire`);
      return { ok: false, reason: "task not found" };
    }
    if (!task.enabled) {
      this.#logger.warn(`[schedule] task "${taskName}" is disabled; skipping fire`);
      return { ok: false, reason: "task is disabled" };
    }

    // Ownership check (T2): a task bound to another channel is refused here
    // — this adapter cannot deliver to its target chat, so injecting would
    // only start a run with nowhere for the result to go. `runNow` and the
    // timed tick share this path, so both get the same rejection. A task
    // with no `channel` field (legacy/manual binding) is not refused here:
    // it keeps the existing target validation below, and the tick loop
    // already excludes it from scheduled firing.
    if (task.channel !== undefined && task.channel !== this.#channelName) {
      this.#logger.warn(
        `[schedule] task "${taskName}" belongs to channel "${task.channel}"; skipping fire`,
      );
      return { ok: false, reason: `task belongs to channel "${task.channel}"` };
    }

    const target = task.target;
    if (
      target === undefined ||
      (this.#validateTarget !== undefined && !this.#validateTarget(target))
    ) {
      // Nowhere to deliver an error to: skip and log only (spec D7).
      this.#logger.warn(`[schedule] task "${taskName}" has no valid target; skipping fire`);
      return { ok: false, reason: "task has no valid target" };
    }

    // Fire-time directory validation (spec D6): nothing is injected on
    // failure; the localized error goes to the (valid) target chat.
    const directoryValidation = await validateWorkingDirectory(task.directory ?? process.cwd());
    if (!directoryValidation.ok) {
      this.#logger.warn(
        `[schedule] task "${taskName}" has an invalid working directory "${directoryValidation.directory}": ${directoryValidation.detail}`,
      );
      await this.#deliverToTarget(
        target,
        this.#t("schedule.fireError", { name: taskName, detail: directoryValidation.detail }),
      );
      return { ok: false, reason: `invalid working directory: ${directoryValidation.detail}` };
    }

    if (task.prompt.trim() === "") {
      this.#logger.warn(`[schedule] task "${taskName}" has an empty prompt; skipping fire`);
      await this.#deliverToTarget(
        target,
        this.#t("schedule.fireError", { name: taskName, detail: "task body is empty" }),
      );
      return { ok: false, reason: "task body is empty" };
    }

    // Register the run (with its own timeout timer) BEFORE dispatching: the
    // run id must exist before any output can arrive, so a failure that
    // surfaces during the dispatch window is still attributed to this run.
    // SF-2: if stop() landed while we were awaiting validation, no run and
    // no timer may be created.
    const sessionId = this.#registerRun(task);
    if (sessionId === null) {
      this.#logger.warn(`[schedule] scheduler stopped during fire of "${taskName}"; run not registered`);
      return { ok: false, reason: "scheduler is not running" };
    }

    // Dispatch the two synthetic events in order (spec D1). The core's
    // ingress never rejects: a session-creation failure (for example an
    // invalid/unavailable task `model`) resolves `{ ok: false, reason }`, and
    // the fire must stop right there — the follow-up `user.message` would
    // otherwise auto-create a session without the task's model override (the
    // pre-T6 silent fallback). The try/catch stays as defensive handling for
    // mocked or future dispatchers that throw.
    try {
      const sessionResult = await this.#dispatchClientEvent({
        type: "command.session.new",
        clientSessionId: sessionId,
        workingDirectory: directoryValidation.directory,
        workingDirectorySource: "default",
        // Per-task model override (design spec `docs/scheduled-task-model-spec.md`):
        // only present when the task pins one; absent stays undefined so the
        // channel config model resolution is unchanged.
        ...(task.model !== undefined ? { model: task.model } : {}),
      });
      if (!sessionResult.ok) {
        return await this.#failFire(task, sessionId, sessionResult.reason);
      }

      const messageResult = await this.#dispatchClientEvent({
        type: "user.message",
        clientSessionId: sessionId,
        // T3: wrap the task prompt with the fixed completion-protocol block.
        // The schedule task's whole file body IS its prompt (`task.prompt`),
        // so it is supplied as the shared context/body with no extra prompt.
        text: buildTaskPrompt(task.prompt, ""),
      });
      if (!messageResult.ok) {
        return await this.#failFire(task, sessionId, messageResult.reason);
      }
    } catch (error) {
      // The session may or may not exist at this point; either way the run
      // record must not outlive a failed fire (no stale timeout timer, no
      // post-failure result delivery). If session.new had landed, the core
      // idle timeout reclaims the orphaned session.
      this.#endRun(sessionId);
      this.#logger.error(`[schedule] failed to dispatch synthetic events for "${taskName}":`, error);
      return { ok: false, reason: "failed to dispatch synthetic events" };
    }

    return { ok: true };
  }

  /**
   * Ends a run whose synthetic dispatch failed (T6): clears the run record
   * and delivers a localized task-failed notice with the real reason to the
   * task's `target` when bound — mirroring handleOutput's error branch. The
   * returned reason carries the underlying message so `/schedule-run`
   * invokers see the real cause (`scheduleRunFailed` prints `{{reason}}`).
   */
  async #failFire(task: ScheduleTask, sessionId: string, reason: string): Promise<FireResult> {
    // Capture the accumulation-file path before the run record is cleared.
    const filePath = this.#runs.get(sessionId)?.accumulator.filePath;
    this.#endRun(sessionId);
    this.#logger.warn(`[schedule] fire of "${task.name}" failed: ${reason}`);
    // Stop-race (SF-2): a dispatch that was in flight across a stop resolves
    // `{ ok: false, reason: "gateway is not running" }` — the core ingress
    // never rejects, even after teardown. That is not a task failure: the
    // "stop ⇒ no delivery" contract means nothing may be delivered to the
    // target chat after stop(), so the notice is skipped and only the run ends.
    if (!this.#started) {
      return { ok: false, reason };
    }
    const target = task.target;
    if (target === undefined) {
      // Nowhere to deliver to (defensive: #fire validates the target before
      // dispatching, so this is unreachable through the public API).
      this.#logger.warn(`[schedule] task "${task.name}" has no target to deliver its failure to`);
      return { ok: false, reason };
    }
    const suffix = this.#t("schedule.taskFailedSuffix", {
      name: task.name,
      ...(filePath !== undefined ? { path: filePath } : {}),
    });
    // T1: the real reason stays visible in the content part, the italic
    // one-liner (with the kept accumulation-file reference) trails it.
    await this.#deliverToTarget(target, `${reason}\n\n${suffix}`);
    return { ok: false, reason };
  }

  async #tick(): Promise<void> {
    if (!this.#started) return;
    const now = this.#now();
    let loaded: LoadedTask[];
    try {
      loaded = await this.#loadTasks(this.#schedulesRoot);
    } catch (error) {
      this.#logger.error("[schedule] failed to load scheduled tasks:", error);
      return;
    }
    this.#syncTasks(loaded, now);

    for (const [taskName, row] of this.#tasks) {
      // SF-2: a stop() that landed mid-tick must not start new fires.
      if (!this.#started) return;
      const { task } = row;
      // Ownership filter (T2): only tasks bound to this channel fire on
      // schedule. Tasks owned by other channels and unbound tasks (no
      // `channel`) are skipped, nextRun untouched. The table still mirrors
      // every task because `claimTarget`'s existence check needs it.
      if (task.channel !== this.#channelName) continue;
      if (!task.enabled || task.schedule === null || row.nextRun === null) continue;
      if (now.getTime() >= row.nextRun.getTime()) {
        const result = await this.#fire(taskName);
        if (!result.ok) {
          this.#logger.warn(`[schedule] fire of "${taskName}" failed: ${result.reason}`);
        }
        // Recompute from the current clock: a delayed tick fires at most once
        // (no bursting) and a failing task does not retry every tick.
        row.nextRun = nextRun(task.schedule, this.#now());
      }
    }
  }

  #scheduleNextTick(): void {
    if (!this.#started) return;
    this.#tickTimer = setTimeout(() => {
      void this.#tick().finally(() => this.#scheduleNextTick());
    }, this.#tickMs);
    this.#tickTimer.unref?.();
  }

  #syncTasks(loaded: LoadedTask[], now: Date): void {
    const seen = new Set<string>();
    for (const { task } of loaded) {
      seen.add(task.name);
      const existing = this.#tasks.get(task.name);
      if (existing === undefined) {
        this.#tasks.set(task.name, {
          task,
          nextRun: task.schedule !== null ? nextRun(task.schedule, now) : null,
        });
        continue;
      }
      const scheduleChanged = !sameSchedule(existing.task.schedule, task.schedule);
      const enabledChanged = existing.task.enabled !== task.enabled;
      if (scheduleChanged || enabledChanged) {
        // Recompute from the current clock: a schedule edit re-anchors the
        // task, and re-enabling never catches up a paused task.
        existing.task = task;
        existing.nextRun = task.schedule !== null ? nextRun(task.schedule, now) : null;
      } else {
        // Body/front-matter edits keep the scheduled nextRun.
        existing.task = task;
      }
    }
    for (const taskName of [...this.#tasks.keys()]) {
      if (!seen.has(taskName)) {
        this.#tasks.delete(taskName);
      }
    }
  }

  /** Re-reads the task file at fire time so the latest prompt is used (spec D8). */
  async #loadTaskFresh(taskName: string): Promise<ScheduleTask | undefined> {
    let loaded: LoadedTask[];
    try {
      loaded = await this.#loadTasks(this.#schedulesRoot);
    } catch (error) {
      this.#logger.error(`[schedule] failed to load task "${taskName}":`, error);
      return undefined;
    }
    return loaded.find((entry) => entry.task.name === taskName)?.task;
  }

  #registerRun(task: ScheduleTask): string | null {
    // SF-2: never register a run (and therefore never create a timer) once
    // stopped — a stop() landing mid-fire must not leave a timer that
    // nobody will clear.
    if (!this.#started) return null;
    const sessionId = syntheticSessionId(task.name, ++this.#runSeq);
    // T3: per-run output accumulator and silence probe, alongside the
    // existing wall-clock timeout (the layer-3 backstop). The probe is armed
    // (poked) at run start so its silence window opens as soon as the run
    // registers.
    const probe = createSilenceProbe({
      silentMs: task.silenceMs,
      onProbe: () => {
        void this.#handleProbe(sessionId);
      },
    });
    probe.poke();
    const record: RunRecord = {
      sessionId,
      task,
      startedAt: this.#now().getTime(),
      accumulator: createRunAccumulator({
        sessionId,
        ...(this.#outputsDir !== undefined ? { outputsDir: this.#outputsDir } : {}),
      }),
      probe,
      timer: setTimeout(() => {
        void this.#handleTimeout(sessionId);
      }, task.timeoutMs),
    };
    record.timer.unref?.();
    this.#runs.set(sessionId, record);
    return sessionId;
  }

  /**
   * Layer-2 probe (T3): the silence window elapsed with no run event, so a
   * probing `user.message` is dispatched into the run session asking it to
   * either report DONE or keep working. The wall-clock timeout (layer 3)
   * remains the only backstop — a failed probe dispatch is logged, with no
   * force-close added.
   */
  async #handleProbe(sessionId: string): Promise<void> {
    const record = this.#runs.get(sessionId);
    if (record === undefined) return; // run ended before the probe fired
    const silentMinutes = Math.max(1, Math.round(record.task.silenceMs / 60_000));
    const result = await this.#dispatchClientEvent({
      type: "user.message",
      clientSessionId: sessionId,
      text: buildProbeMessage(silentMinutes),
    });
    if (!result.ok) {
      this.#logger.warn(`[schedule] probe dispatch failed for run "${sessionId}": ${result.reason}`);
    }
  }

  async #handleTimeout(sessionId: string): Promise<void> {
    const record = this.#runs.get(sessionId);
    if (record === undefined) return; // run already ended
    this.#runs.delete(sessionId);
    record.probe.stop();
    const { task } = record;
    this.#logger.warn(`[schedule] task "${task.name}" timed out after ${task.timeoutMs}ms`);

    const target = task.target;
    if (target === undefined) {
      this.#logger.warn(`[schedule] task "${task.name}" has no target to deliver its timeout notice to`);
      return;
    }

    // Abort this run's own session. NOTE: the shared event type has no
    // `command.session.abort`; `command.session.stop` is the equivalent core
    // command (it calls agentAdapter.abort()).
    await this.#dispatchSafe({
      type: "command.session.stop",
      clientSessionId: sessionId,
    });

    // The partial transcript is NOT inlined — the kept accumulation file is
    // referenced by the trailing italic one-liner.
    const suffix = this.#t("schedule.taskTimedOutSuffix", {
      name: task.name,
      path: record.accumulator.filePath,
    });
    await this.#deliverToTarget(target, suffix);
  }

  #endRun(sessionId: string): void {
    const record = this.#runs.get(sessionId);
    if (record === undefined) return;
    clearTimeout(record.timer);
    record.probe.stop();
    this.#runs.delete(sessionId);
  }

  async #dispatchSafe(event: ClientOutputEvent): Promise<void> {
    try {
      await this.#dispatchClientEvent(event);
    } catch (error) {
      this.#logger.error("[schedule] failed to dispatch synthetic event:", error);
    }
  }

  async #deliverToTarget(target: string, textOrEvent: string | ClientInputEvent): Promise<void> {
    const event: ClientInputEvent =
      typeof textOrEvent === "string"
        ? { type: "assistant.message", clientSessionId: target, text: textOrEvent }
        : textOrEvent;
    try {
      await this.#deliver(event);
    } catch (error) {
      this.#logger.error(`[schedule] failed to deliver event to target "${target}":`, error);
    }
  }
}

/** A parsed synthetic clientSessionId: task name plus its run sequence. */
export interface ParsedSyntheticId {
  taskName: string;
  runSeq: number;
}

/**
 * Returns the run-unique synthetic clientSessionId for a task run
 * (`schedule:<task-name>:<run-seq>`, spec D1). The run sequence guarantees
 * that concurrent runs of the same task have distinct ids.
 */
export function syntheticSessionId(taskName: string, runSeq: number): string {
  return `${SYNTHETIC_SESSION_PREFIX}${taskName}:${runSeq}`;
}

/**
 * Parses a `schedule:<task-name>:<run-seq>` clientSessionId; `null` when it
 * is not a well-formed synthetic schedule session id.
 */
export function parseSyntheticSessionId(clientSessionId: string): ParsedSyntheticId | null {
  if (!clientSessionId.startsWith(SYNTHETIC_SESSION_PREFIX)) return null;
  const rest = clientSessionId.slice(SYNTHETIC_SESSION_PREFIX.length);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  const taskName = rest.slice(0, colon);
  const runSeq = Number(rest.slice(colon + 1));
  if (!Number.isInteger(runSeq) || runSeq < 1) return null;
  return { taskName, runSeq };
}

function sameSchedule(a: ScheduleTask["schedule"], b: ScheduleTask["schedule"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
