/**
 * Per-channel queue controller (design spec `docs/event-queue-spec.md` D2,
 * ticket T3).
 *
 * One instance per channel, owned by the channel runner next to the
 * scheduler. It owns:
 *
 * - the tick loop (default 30 s, spec D2) that reloads queue definitions on
 *   every tick, so definition edits (`workers`, `model`, `target`) and newly
 *   added queues take effect on the next tick;
 * - ownership filtering: only queues whose front-matter `channel` equals this
 *   channel's config name are consumed; queues owned by other channels (and
 *   their task files) are never touched;
 * - the run registry: one record per run, keyed by the run-unique synthetic
 *   session id `queue:<queue-name>:<task-id>` (spec D1), each with its own
 *   timeout timer set from the queue's `timeout` front matter (5-hour
 *   default, same as scheduled tasks); a run ends when the controller
 *   receives its completion/failure signal through
 *   {@link QueueController.handleOutput} or when the timer fires;
 * - firing: a synthetic `command.session.new` (carrying the queue's pinned
 *   `model` when it has one) followed by a `user.message` whose text is the
 *   queue body plus the task prompt (spec D2). Runtime failures — after the
 *   session was created — dead-letter the task (`state: failed`, the file is
 *   kept for tracing and `queue retry`); the only fail-and-drop path left is
 *   a task-level `directory:` that fails validation before the session even
 *   exists.
 *
 * All external interaction goes through the injected callbacks:
 * `dispatchClientEvent` (synthetic client-output events — the runner wires
 * it to the core's input path), `deliver` (egress events to a queue's
 * `target` chat) and `t` (the per-channel translator). The runner diverts
 * `queue:*` agent output into {@link QueueController.handleOutput}. This
 * module deliberately knows nothing about the agent adapter or the core.
 */

import type { ClientInputEvent, ClientOutputEvent, IngressResult } from "../../types";
import type { Translator } from "../../i18n";
import { createLogger, type Logger } from "../../core/logger";
import { appendRunHistory, type RunHistoryOutcome } from "../run-completion/history";
import { DEFAULT_TIMEOUT_MS } from "../schedule/task-file";
import { validateWorkingDirectory } from "../client/utils/working-directory";
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
  QUEUE_SESSION_PREFIX,
  bindQueue,
  deleteQueueTask,
  failQueueTask,
  listQueueDefinitions,
  listQueueTasks,
  loadQueueDefinition,
  setQueueTaskState,
  type QueueDefinition,
  type QueueTask,
} from "./queue-file";
import type { QueueHereResult } from "../../types";

/** Default tick interval: 30 s (spec D2). */
export const DEFAULT_TICK_MS = 30_000;

export interface QueueControllerOptions {
  channelName: string;
  tickMs?: number;
  /**
   * Fallback max run duration in ms before a task times out; a queue
   * definition's `timeout:` front matter takes precedence over this
   * (spec D2). Defaults to the same 5-hour constant as scheduled
   * tasks.
   */
  runTimeoutMs?: number;
  /** Dispatches synthetic client-output events into the core's ingress (spec D2). */
  dispatchClientEvent: (event: ClientOutputEvent) => Promise<IngressResult>;
  /** Egress events delivered to a queue's `target` chat (result/failure notice). */
  deliver: (event: ClientInputEvent) => Promise<void>;
  /** Per-channel translator, e.g. `getTranslatorForCommon(common)`. */
  t: Translator;
  /** Overridable queues root (defaults to the shared `QUEUES_DIR`). */
  queuesRoot?: string;
  /** Overridable run-outputs root for the per-run accumulator (tests). */
  outputsDir?: string;
  /**
   * Overridable run-history root (tests): each finished run appends one
   * line to `run-history/queue.jsonl` under it (run-history spec D1/D3).
   */
  historyRoot?: string;
  logger?: Logger;
}

/** Fire-time resolved run parameters (the unified override chain, T03). */
interface RunParams {
  /**
   * Model override (task level > definition level; the last rung is the
   * channel agent config's model, reached by leaving this undefined — no
   * built-in default participates).
   */
  model: string | undefined;
  /** Wall-clock run timeout in ms (task level > definition level > default). */
  timeoutMs: number;
  /** Silence-probe window in ms (task level > definition level > default). */
  silenceMs: number;
}

interface RunRecord {
  /** The run-unique synthetic clientSessionId (`queue:<queue>:<taskId>`). */
  sessionId: string;
  queueName: string;
  taskId: string;
  /** Delivery address captured at fire time (spec D2). */
  target: string;
  /** Silence window for the probe, from the queue definition (T4). */
  silentMs: number;
  /** Wall-clock run timeout captured at fire time, from the queue definition. */
  timeoutMs: number;
  /** Registration time (epoch ms); the history line's duration base (D2). */
  startedAt: number;
  timer: NodeJS.Timeout;
  /** Per-run output accumulator (T4): every assistant message is appended here. */
  accumulator: RunAccumulator;
  /** Per-run silence probe (T4): fires a probing user.message after inactivity. */
  probe: SilenceProbe;
  /** Captured from the fire's session.new result (run-history spec D5). */
  agentSessionId?: string;
}

export class QueueController {
  readonly #channelName: string;
  readonly #tickMs: number;
  readonly #runTimeoutMs: number;
  readonly #dispatchClientEvent: (event: ClientOutputEvent) => Promise<IngressResult>;
  readonly #deliver: (event: ClientInputEvent) => Promise<void>;
  readonly #t: Translator;
  readonly #logger: Logger;
  readonly #queuesRoot?: string;
  readonly #outputsDir?: string;
  readonly #historyRoot?: string;

  /** Active runs keyed by their run-unique synthetic session id. */
  readonly #runs = new Map<string, RunRecord>();

  /**
   * Tombstones (timeout teardown spec D4): the epoch-ms time each run ended,
   * keyed by session id. While a tombstone is fresher than 2×tickMs the tick
   * reconciliation treats a leftover `running` task file as possibly still in
   * its normal cleanup chain instead of a zombie — a tick can interleave with
   * the timeout chain (independent timer chains). Pruned each tick and each
   * end (see {@link #pruneEndedTombstones}), so it cannot grow unbounded.
   */
  readonly #endedAt = new Map<string, number>();

  #started = false;
  #tickTimer: NodeJS.Timeout | null = null;

  constructor(options: QueueControllerOptions) {
    this.#channelName = options.channelName;
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.#runTimeoutMs = options.runTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#dispatchClientEvent = options.dispatchClientEvent;
    this.#deliver = options.deliver;
    this.#t = options.t;
    this.#queuesRoot = options.queuesRoot;
    this.#outputsDir = options.outputsDir;
    this.#historyRoot = options.historyRoot;
    this.#logger = options.logger ?? createLogger("queue");
  }

  /**
   * Effective run timeout for a task (T03 unified override chain: task
   * level > queue definition level > built-in default): the task-level
   * `timeout:` when set, else the definition's, else the controller-level
   * fallback (`runTimeoutMs` option, tests use it to shorten runs; default
   * {@link DEFAULT_TIMEOUT_MS}).
   */
  #effectiveRunTimeout(task: QueueTask, definition: QueueDefinition): number {
    return task.timeoutMs ?? definition.timeoutMs ?? this.#runTimeoutMs;
  }

  /**
   * Starts the controller: first re-enqueues every `running` task of owned
   * queues back to `pending` (at-least-once restart, spec D2 — a task in
   * flight at shutdown is re-executed, no interruption notice is sent), then
   * the initial tick runs and the tick loop begins.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#resetRunningTasks();
    await this.#tick();
    this.#scheduleNextTick();
  }

  /**
   * Stops the tick loop and clears every timer (including run timeout
   * timers). In-flight runs are forgotten; their task files stay `running`
   * and are re-enqueued at the next start (spec D2). No delivery happens
   * after stop (same contract as the scheduler, T6); probe timers are
   * stopped and the accumulation files are KEPT (they may hold partial work).
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
      // Stop contract (T4, unchanged): nothing is delivered after stop, and
      // the accumulation file is KEPT — it may hold partial work that is
      // still readable at run-outputs/<run-id>.md.
    }
    this.#runs.clear();
  }

  /**
   * Binds a chat as the queue's delivery target (spec D4, `/queue-here`):
   * writes BOTH this channel's config name and the sending chat's
   * `clientSessionId` into the queue file's `channel`/`target` front-matter
   * lines in one atomic write (`bindQueue`); the controller picks the binding
   * up on its next tick reload — no direct coupling. The queue must exist —
   * resolved with an immediate directory load so a file written after the
   * last tick is still claimable. A queue that is already bound (`target`
   * set) is refused with "queue already bound": rebinding is a manual/AI file
   * edit — there is no command for it. A missing channel context (the runner
   * always passes `channelName`, so this is defensive only) is refused like
   * the core's old path. Unknown queue or a write failure returns
   * `{ ok: false, reason }`; the localized reply for the triggering chat is
   * the caller's job (the adapter, via `formatQueueHereReply`).
   */
  async claimTarget(queueName: string, clientSessionId: string): Promise<QueueHereResult> {
    let definition: QueueDefinition | null;
    try {
      definition = await loadQueueDefinition(queueName, this.#queuesRoot);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger.error(
        `[queue] failed to load queue "${queueName}" while claiming target:`,
        error,
      );
      return { ok: false, reason: detail };
    }
    if (definition === null) {
      this.#logger.warn(`[queue] queue "${queueName}" not found; nothing to claim`);
      return { ok: false, reason: "queue not found" };
    }
    // Already-bound check: a queue whose `target` is set is refused — the
    // channel is always rewritten to the current one at bind time, so the
    // only way to move a queue is to unbind it first (edit the file with AI).
    if (definition.target !== undefined) {
      this.#logger.warn(`[queue] queue "${queueName}" is already bound; refusing to rebind`);
      return { ok: false, reason: "queue already bound" };
    }
    const channelName = this.#channelName;
    if (channelName === undefined || channelName === "") {
      return { ok: false, reason: "no channel context to bind the queue to" };
    }
    return bindQueue(queueName, channelName, clientSessionId, this.#queuesRoot);
  }

  /**
   * Routes a diverted agent-output event for a `queue:*` session (T4,
   * three-layer completion protocol per the 2026-08-19（二）grill).
   *
   * `assistant.message` no longer ends the run: it is classified against the
   * DONE-marker protocol, appended to the run's accumulator and pokes the
   * silence probe. When DONE is detected the run ends, ONE delivery (content
   * plus a trailing italic one-liner via `queue.taskCompletedSuffix`) with the
   * full accumulated text (plus all attachments) is delivered, the task file
   * is deleted and the worker slot is freed — the
   * slot is held until DONE/failure/timeout (WAITING, decided), so with
   * `workers=1` a second task cannot fire between the first message and DONE.
   * A terminal `error` dead-letters the task (state: failed, spec D2/T02)
   * and delivers a localized failure notice with any accumulated partial
   * content.
   * Events whose run-unique id has no active run are dropped and logged
   * (orphan).
   */
  async handleOutput(event: ClientInputEvent): Promise<void> {
    if (!event.clientSessionId.startsWith(QUEUE_SESSION_PREFIX)) return;
    const record = this.#runs.get(event.clientSessionId);
    if (record === undefined) {
      this.#logger.info(`[queue] dropping orphan output for run "${event.clientSessionId}"`);
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
    await this.#completeTask(record);
  }

  /** Ends a run on a terminal error, appending any accumulated partial content. */
  async #handleError(
    record: RunRecord,
    event: Extract<ClientInputEvent, { type: "error" }>,
  ): Promise<void> {
    this.#endRun(record.sessionId);
    const reason = event.detail ?? "agent run failed";
    await this.#failTask(record, reason);
  }

  async #tick(): Promise<void> {
    if (!this.#started) return;
    // Drop tombstones past their grace window before deciding anything about
    // task files (timeout teardown spec D4).
    this.#pruneEndedTombstones();
    let definitions: QueueDefinition[];
    try {
      definitions = await listQueueDefinitions(this.#queuesRoot);
    } catch (error) {
      this.#logger.error("[queue] failed to load queue definitions:", error);
      return;
    }

    for (const definition of definitions) {
      // SF-2: a stop() that landed mid-tick must not start new fires.
      if (!this.#started) return;
      // Ownership filter: only queues bound to this channel are consumed
      // (spec D2). Queues owned by other channels are never touched.
      if (definition.channel !== this.#channelName) continue;
      // Disabled queue (persistent disable switch): never consumed — its
      // pending tasks pile up untouched until the queue is re-enabled, then
      // the backlog drains automatically on a later tick.
      if (!definition.enabled) continue;
      // Unbound queue (empty `target`): never consumed; tasks pile up until
      // `/queue-here` binds a chat (spec D2).
      if (definition.target === undefined) continue;

      let tasks: QueueTask[];
      try {
        tasks = await listQueueTasks(definition.name, this.#queuesRoot);
      } catch (error) {
        this.#logger.error(`[queue] failed to load tasks of queue "${definition.name}":`, error);
        continue;
      }

      // Zombie reconciliation (timeout teardown spec D4) BEFORE the capacity
      // math: files orphaned by a broken cleanup chain must not wedge the
      // queue forever.
      await this.#reconcileZombieTasks(definition.name, tasks);

      const pendingAll = tasks.filter((task) => task.state === "pending");
      if (pendingAll.length === 0) continue;

      const capacity = definition.workers - this.#inFlight(definition.name);
      if (capacity <= 0) continue;

      // Fire-time working-directory validation (scheduler spec D6 style): the
      // queue-level `directory:` is validated once per tick, only when there
      // is work to fire. An invalid value is a configuration error — tasks
      // without their own `directory:` override stay pending with a warn log
      // (same "pile up until fixed" semantics as an unbound/disabled queue),
      // while override tasks are unaffected: they are validated individually
      // in #fire and stay eligible for the capacity slice below.
      let queueDirectory: string | undefined;
      let queueDirectoryInvalid = false;
      if (definition.directory !== undefined) {
        const validation = await validateWorkingDirectory(definition.directory);
        if (validation.ok) {
          queueDirectory = validation.directory;
        } else {
          queueDirectoryInvalid = true;
          this.#logger.warn(
            `[queue] queue "${definition.name}" has an invalid working directory "${validation.directory}": ${validation.detail}; tasks without their own directory stay pending`,
          );
        }
      }

      // Oldest pending tasks up to capacity (lexicographic file order IS the
      // FIFO order, spec D1). Stalled tasks (broken queue-level directory, no
      // override) are filtered BEFORE the capacity slice: they cannot run
      // until the definition is fixed, so they must not hold slots that
      // runnable override tasks could use.
      const pending = pendingAll
        .filter((task) => !(queueDirectoryInvalid && task.directory === undefined))
        .slice(0, capacity);
      for (const task of pending) {
        if (!this.#started) return;
        await this.#fire(definition, task, queueDirectory);
      }
    }
  }

  /**
   * Fires one task (spec D2): resolves the working directory (task
   * `directory:` > queue `directory:` > bridge process cwd — the queue-level
   * value arrives already validated/canonical from #tick; an invalid
   * task-level override is a pre-session configuration error: the task is
   * dropped with a notice, the only remaining fail-and-drop path),
   * marks the task `running`, registers the run with its timeout timer
   * BEFORE dispatching (the run id must exist before any output can
   * arrive), then dispatches `command.session.new` (carrying the resolved
   * `model` when one is pinned) and checks the ingress result —
   * a failed session creation stops the fire right there, so the follow-up
   * `user.message` can never auto-create a model-less session (T6). The
   * `user.message` text is `<queue body>\n\n<task prompt>` (body empty →
   * just the prompt).
   */
  async #fire(
    definition: QueueDefinition,
    task: QueueTask,
    queueDirectory: string | undefined,
  ): Promise<void> {
    const target = definition.target;
    if (target === undefined) {
      // Defensive: #tick only fires queues with a target.
      this.#logger.warn(`[queue] queue "${definition.name}" has no target; skipping task "${task.id}"`);
      return;
    }

    // Unified run-parameter override chain (T03, context D1), resolved once
    // at the top of #fire: the task-level front matter wins, the queue
    // definition is the fallback. `timeout` / `silence` end at the
    // controller's built-in defaults; `model` ends at the channel agent
    // config (undefined here) — no built-in default participates in its chain.
    const params: RunParams = {
      model: task.model ?? definition.model,
      timeoutMs: this.#effectiveRunTimeout(task, definition),
      silenceMs: task.silenceMs ?? definition.silenceMs,
    };

    // A task-level `directory:` override is validated here, BEFORE the task
    // is marked running, so an invalid one drops the task cleanly without a
    // running-state window. No run record or history line exists for this
    // failure (same as the scheduler's directory-validation failure, which
    // returns before #registerRun): the notice + log are the trace.
    let workingDirectory = queueDirectory ?? process.cwd();
    if (task.directory !== undefined) {
      const validation = await validateWorkingDirectory(task.directory);
      if (!validation.ok) {
        // SF-2 stop-race: a stop() landing during the validation await must
        // not delete the task or deliver — the task stays pending and the
        // next start re-fires it (at-least-once), failing and notifying then.
        // Every other fire-failure path gets this from #failFire's stale-fire
        // guard; this pre-registration path has no RunRecord to check, so the
        // #started check is the equivalent.
        if (!this.#started) return;
        this.#logger.warn(
          `[queue] task "${task.id}" of queue "${definition.name}" has an invalid working directory "${validation.directory}": ${validation.detail}`,
        );
        // Pre-session configuration error (spec D2 dead-letter split): no
        // agent session exists to trace, so the fail-and-drop semantics stay
        // — delete the file and tell the target no session was created.
        await this.#deleteTask(definition.name, task.id);
        await this.#deliverToTarget(
          target,
          this.#t("queue.fireError", { queue: definition.name, detail: validation.detail }),
        );
        return;
      }
      workingDirectory = validation.directory;
    }

    try {
      await setQueueTaskState(definition.name, task.id, "running", this.#queuesRoot);
    } catch (error) {
      this.#logger.error(
        `[queue] failed to mark task "${task.id}" of queue "${definition.name}" as running:`,
        error,
      );
      return;
    }

    const record = await this.#registerRun(definition, task, target, params);
    if (record === null) {
      // SF-2 (or the header write failed and #registerRun already handled
      // the fail-and-drop equivalent for the SF-2 stop race): stopped-path
      // tasks stay `running` and are
      // re-enqueued at the next start (at-least-once).
      return;
    }
    const sessionId = record.sessionId;

    try {
      const sessionResult = await this.#dispatchClientEvent({
        type: "command.session.new",
        clientSessionId: sessionId,
        workingDirectory,
        workingDirectorySource: "default",
        // Resolved model override (T03 chain): only present when the task or
        // the queue pins one; absent stays undefined so the channel config
        // model resolution is unchanged.
        ...(params.model !== undefined ? { model: params.model } : {}),
      });
      if (!sessionResult.ok) {
        await this.#failFire(record, sessionResult.reason);
        return;
      }
      // Run-history spec D5: capture the agentSessionId from the fire's
      // session.new result — this is the authoritative value (a later
      // session-bindings lookup could miss a subsequent /new).
      if (sessionResult.agentSessionId !== undefined) {
        record.agentSessionId = sessionResult.agentSessionId;
      }

      const text = buildTaskPrompt(definition.body, task.prompt);
      const messageResult = await this.#dispatchClientEvent({
        type: "user.message",
        clientSessionId: sessionId,
        text,
      });
      if (!messageResult.ok) {
        await this.#failFire(record, messageResult.reason);
        return;
      }
    } catch (error) {
      // Defensive: the real core's ingress never rejects or throws; a
      // throwing mock or future dispatcher must not leave a stuck `running`
      // task, so the fire is failed and dropped like any other failure.
      const reason = error instanceof Error ? error.message : String(error);
      await this.#failFire(record, `failed to dispatch synthetic events: ${reason}`);
    }
  }

  /**
   * Fails a fire whose synthetic dispatch reported `{ ok: false }` (T6):
   * ends the run, dead-letters the task file (spec D2/T02 — `state: failed`
   * plus the dead-letter trace fields, the file is KEPT for tracing and
   * `queue retry`) and delivers ONE localized failure notice with the real
   * reason to the queue's `target`, carrying the agent session id when the
   * session was created before the failure. Stop-race (SF-2): a dispatch in
   * flight across a stop resolves `{ ok: false, reason: "gateway is not
   * running" }` — that is not a task failure; no history line is written,
   * nothing is delivered, the file is not dead-lettered and the task stays
   * `running` so the next start re-enqueues it (at-least-once).
   */
  async #failFire(record: RunRecord, reason: string): Promise<void> {
    // SF-2 / run-history D2 / stale-fire guard: identity-check the fire's
    // local record against the registry BEFORE anything else. The record is
    // no longer the registered one in two cases, and in BOTH the fire's
    // failure must be fully ignored (no history line, no #endRun, no task
    // delete, no delivery):
    //
    // 1. stop() cleared the run registry (SF-2): a dispatch in flight across
    //    a stop resolves `{ ok: false, reason: "gateway is not running" }` —
    //    that is not a task failure; the task file stays `running` for the
    //    at-least-once re-run at the next start, which writes its own line.
    // 2. a stop() → start() fast re-run re-fired the SAME taskId (queue run
    //    ids are restart-stable `queue:<queue>:<taskId>`) and registered a
    //    NEW record under the SAME id: a mere `registered !== undefined`
    //    check would let the stale fire write history and — worse — let the
    //    id-keyed #endRun/delete/deliver below take the NEW run down with
    //    it. `#endRun` therefore sits INSIDE this guard.
    //
    // The scheduler needs no such guard: its ids embed a restart-unique
    // timestamp, so a re-fire never reuses an id and a stale fire's re-get
    // finds no record.
    const registered = this.#runs.get(record.sessionId);
    if (registered !== record) {
      this.#logger.warn(
        `[queue] ignoring stale fire failure of task "${record.taskId}" of queue "${record.queueName}": ${reason}`,
      );
      return;
    }
    this.#endRun(record.sessionId);
    if (this.#started) {
      await this.#writeHistory(record, "fire-failed", { reason });
    }
    this.#logger.warn(`[queue] task "${record.taskId}" of queue "${record.queueName}" failed: ${reason}`);
    if (!this.#started) return;
    await this.#failRun(record, reason);
  }

  /**
   * The shared runtime dead-letter tail (spec D2/T02), used by every
   * failure path AFTER a run record exists: one atomic `state: failed`
   * write (with `failedAt` / `reason` and the recorded `agentSessionId`, if
   * any) keeps the task file on disk, and exactly one notice goes to the
   * target — the reason first, then a trailing italic one-liner referencing
   * the kept accumulation file; when the agent session exists its id is
   * included so the failure can be traced (or resumed) on the agent side.
   */
  async #failRun(record: RunRecord, reason: string): Promise<void> {
    try {
      await failQueueTask(
        record.queueName,
        record.taskId,
        {
          reason,
          ...(record.agentSessionId !== undefined ? { agentSessionId: record.agentSessionId } : {}),
        },
        this.#queuesRoot,
      );
    } catch (error) {
      this.#logger.error(
        `[queue] failed to dead-letter task "${record.taskId}" of queue "${record.queueName}":`,
        error,
      );
    }
    // T1: content first (the real reason, plus the agent session id when one
    // exists), then a trailing italic one-liner referencing the kept
    // accumulation file.
    const agentLine =
      record.agentSessionId !== undefined
        ? `${this.#t("queue.taskFailedAgentSession", { sessionId: record.agentSessionId })}\n`
        : "";
    await this.#deliverToTarget(
      record.target,
      `${reason}\n${agentLine}\n${this.#t("queue.taskFailedSuffix", {
        queue: record.queueName,
        path: record.accumulator.filePath,
      })}`,
    );
  }

  /**
   * Completion (T4): delivers the run's LAST assistant message (marker
   * stripped) plus an italic suffix referencing the kept accumulation file
   * (or the suffix alone when the last message is empty), carrying every
   * attachment collected across all messages, then deletes the task file
   * (completion is success — the file's purpose is fulfilled). The run/slot
   * is already released by the caller (DONE end-run) once this runs. T1:
   * content first, then a trailing italic one-liner — no prefix header, task
   * id dropped from the attribution.
   */
  async #completeTask(record: RunRecord): Promise<void> {
    await this.#writeHistory(record, "completed");
    const { queueName, taskId, target } = record;
    const filePath = record.accumulator.filePath;
    const lastMessage = record.accumulator.lastMessage.trim();
    const attachments = record.accumulator.collectedAttachments.map((a) => ({
      kind: "file" as const,
      filePath: a.filePath,
      ...(a.fileName !== undefined ? { fileName: a.fileName } : {}),
    }));
    const suffix = this.#t("queue.taskCompletedSuffix", { queue: queueName, path: filePath });
    if (lastMessage === "") {
      // No separate no-output key for queues: the completed suffix (with the
      // file reference) is the notice. Attachments collected across the run
      // still go with the delivery (same as the non-empty branch).
      if (attachments.length === 0) {
        await this.#deliverToTarget(target, suffix);
      } else {
        await this.#deliverToTarget(target, {
          type: "assistant.message",
          clientSessionId: target,
          text: suffix,
          attachments,
        });
      }
    } else {
      await this.#deliverToTarget(target, {
        type: "assistant.message",
        clientSessionId: target,
        text: `${lastMessage}\n\n${suffix}`,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    }
    await this.#deleteTask(queueName, taskId);
  }

  /**
   * Failure from a diverted `error` event (T4): runtime failure after the
   * session was created → dead-letter (spec D2/T02) + notice with the
   * reason (and agent session id); no partial transcript inlined.
   */
  async #failTask(record: RunRecord, reason: string): Promise<void> {
    await this.#writeHistory(record, "failed", { reason });
    await this.#failRun(record, reason);
  }

  /**
   * Handles a run timeout (cleanup-chain hardening, timeout teardown
   * spec D3/D4): the chain is wrapped in one top-level try/catch — the timer
   * callback is a floating promise, so an unexpected throw anywhere would
   * otherwise break the chain silently. Local steps first (history line,
   * task-file dead-letter), remote steps last; the release dispatch is
   * fire-and-forget so a hung/throwing remote step cannot block the local
   * cleanup that un-wedges the queue (a `running` file stuck mid-chain is
   * exactly the zombie the tick reconciliation would otherwise have to heal).
   */
  async #handleTimeout(sessionId: string): Promise<void> {
    try {
      const record = this.#runs.get(sessionId);
      if (record === undefined) return; // run already ended
      this.#runs.delete(sessionId);
      record.probe.stop();
      const { queueName, taskId } = record;

      // Tombstone (timeout teardown spec D4): arm the reconciliation grace
      // window for the rest of this chain.
      this.#recordEnd(sessionId);

      this.#logger.warn(
        `[queue] task "${taskId}" of queue "${queueName}" timed out after ${record.timeoutMs}ms`,
      );

      // Local fs steps FIRST (history writer never throws — run-history
      // spec D3; #failRun catches its own fs failures), so the worker
      // slot un-wedges even if everything remote below hangs or throws.
      // Timeout is a runtime failure (spec D2/T02): the task file is
      // dead-lettered (state: failed + trace fields), not deleted.
      await this.#writeHistory(record, "timeout", {
        reason: `timed out after ${record.timeoutMs}ms`,
      });
      await this.#failRun(record, `timed out after ${record.timeoutMs}ms`);

      // Fully tear down this run's session (timeout teardown spec D2/D1):
      // unlike interactive `/stop` (abort-only), release terminates the agent
      // process so a timed-out run cannot be revived by queued probes.
      // Deliberately NOT awaited (last, fire-and-forget): #dispatchSafe
      // already contains throws, and a dispatch that never settles must not
      // block the cleanup completed above.
      void this.#dispatchSafe({
        type: "command.session.release",
        clientSessionId: sessionId,
      });
    } catch (error) {
      // Top-level net (D3): log loudly instead of a silent floating rejection.
      this.#logger.error(
        `[queue] unexpected failure in the timeout handler for run "${sessionId}":`,
        error,
      );
    }
  }

  /**
   * Records a run's end time for the reconciliation grace window and prunes
   * expired tombstones (timeout teardown spec D4). Runs cleared by
   * `stop()` intentionally get NO tombstone: those files are "in-flight
   * forgotten" consumed by the next start's at-least-once reset, not zombies.
   */
  #recordEnd(sessionId: string): void {
    this.#endedAt.set(sessionId, Date.now());
    this.#pruneEndedTombstones();
  }

  /** Drops tombstones older than the 2×tickMs grace window. */
  #pruneEndedTombstones(): void {
    const cutoff = Date.now() - 2 * this.#tickMs;
    for (const [id, endedAtMs] of this.#endedAt) {
      if (endedAtMs < cutoff) this.#endedAt.delete(id);
    }
  }

  /**
   * True while a run's normal cleanup chain may still legitimately be between
   * the registry removal and its task-file delete (timeout teardown spec D4):
   * ticks and the timeout chain are independent timers and can interleave, so
   * a `running` file whose run just ended within 2×tickMs is skipped by the
   * zombie reconciliation.
   */
  #recentlyEnded(sessionId: string): boolean {
    const endedAtMs = this.#endedAt.get(sessionId);
    return endedAtMs !== undefined && Date.now() - endedAtMs < 2 * this.#tickMs;
  }

  /**
   * Zombie-task self-heal (timeout teardown spec D4, amended by the
   * dead-letter semantics spec D2/T02): within an owned, enabled, bound
   * queue, a task file still marked `running` with no live run has lost its
   * run — its cleanup chain died midway. The heal NEVER deletes the file
   * (dead-letter semantics, spec D2/T02): deleting it would destroy the
   * is left to the at-least-once reset of the next start (and manual/AI
   * cleanup). It is deliberately never reset to `pending` here: a
   * mid-session zombie proves the run terminated without finishing, so
   * re-running it risks duplicate side effects. Race safety against an
   * interleaving healthy cleanup chain (ticks and run timers are independent
   * chains): runs record a tombstone timestamp when they end
   * (`#endRun`/`#handleTimeout`; runs cleared by `stop()` get none — those
   * files belong to the next start's reset) and the reconciliation skips
   * runs ended within the last 2×tickMs; tombstones are pruned every tick.
   * Ownership filtering matches fire: disabled/unbound/foreign queues are
   * untouched.
   */
  async #reconcileZombieTasks(queueName: string, tasks: QueueTask[]): Promise<void> {
    for (const task of tasks) {
      if (task.state !== "running") continue; // failed/pending files are never touched
      const sessionId = `${QUEUE_SESSION_PREFIX}${queueName}:${task.id}`;
      if (this.#runs.has(sessionId)) continue; // live run — never touched
      if (this.#recentlyEnded(sessionId)) continue; // grace window (D4)
      // Dead-letter amendment (spec D2/T02): a leftover `running` file is no
      // longer deleted — under dead-letter semantics that would destroy the
      // run's record without ever reaching the terminal state (e.g. the
      // chain's failQueueTask write failed mid-way). It is left to the next
      // start's at-least-once reset (or manual/AI cleanup) instead. Nothing
      // is re-queued here: the at-least-once reset remains exclusively the
      // restart flow (see #resetRunningTasks).
      this.#logger.warn(
        `[queue] task "${task.id}" of queue "${queueName}" is stranded running with no active run; leaving it for the next start's reset (dead-letter semantics)`,
      );
    }
  }

  /** Registers the run (writing its Output File header), its timeout timer, accumulator and silence probe; `null` when stopped (SF-2). */
  async #registerRun(
    definition: QueueDefinition,
    task: QueueTask,
    target: string,
    params: RunParams,
  ): Promise<RunRecord | null> {
    if (!this.#started) return null;
    const sessionId = `${QUEUE_SESSION_PREFIX}${definition.name}:${task.id}`;
    // Captured once so the record's value and the timer duration are
    // identical by construction; a mid-run definition edit cannot touch an
    // already-running timer (the next fired run picks up the new value).
    const timeoutMs = params.timeoutMs;
    // T4: per-run output accumulator and silence probe, alongside the
    // existing wall-clock timeout (the layer-3 backstop). The probe is armed
    // (poked) at run start so its silence window opens as soon as the run
    // registers.
    const probe = createSilenceProbe({
      silentMs: params.silenceMs,
      onProbe: () => {
        void this.#handleProbe(sessionId);
      },
    });
    probe.poke();
    const record: RunRecord = {
      sessionId,
      queueName: definition.name,
      taskId: task.id,
      target,
      silentMs: params.silenceMs,
      timeoutMs,
      startedAt: Date.now(),
      accumulator: createRunAccumulator({
        sessionId,
        ...(this.#outputsDir !== undefined ? { outputsDir: this.#outputsDir } : {}),
      }),
      probe,
      timer: setTimeout(() => {
        void this.#handleTimeout(sessionId);
      }, timeoutMs),
      // agentSessionId lands here right after session.new succeeds (D5).
    };
    record.timer.unref?.();
    this.#runs.set(sessionId, record);
    // Run-history spec D6: write the header (front matter + the RAW prompt —
    // the queue body plus the task prompt, WITHOUT buildTaskPrompt's
    // completion-protocol block) so the Output File is self-contained; a
    // registered run always has a file. The agentSessionId is unknown until
    // session.new succeeds and the header can only be written once, so the
    // `agent` line is omitted on purpose.
    try {
      await this.#writeRunHeader(record, definition, task);
    } catch (error) {
      // Defensive: an fs failure here must not leave a half-registered run
      // or a stuck `running` task. End the run and dead-letter exactly like
      // a dispatch failure (spec D2/T02: failed + trace fields + notice),
      // with the run's own record — no history line is written for it
      // because nothing was ever dispatched and this path is effectively
      // unreachable on a local fs.
      this.#logger.error(`[queue] failed to write run header for "${sessionId}":`, error);
      this.#endRun(sessionId);
      if (this.#started) {
        await this.#failRun(record, "failed to write run output header");
      }
      return null;
    }
    return record;
  }

  /** Builds and writes a queue run's Output File header (run-history spec D6). */
  async #writeRunHeader(
    record: RunRecord,
    definition: QueueDefinition,
    task: QueueTask,
  ): Promise<void> {
    // The RAW prompt (queue body + task prompt) — the protocol block that
    // buildTaskPrompt wraps around it for the actual dispatch is NOT part
    // of the header.
    const rawBody = definition.body.trim();
    const rawPrompt = rawBody === "" ? task.prompt : `${rawBody}\n\n${task.prompt}`;
    const lines = [
      "---",
      `runId: ${record.sessionId}`,
      `channel: ${this.#channelName}`,
      `target: ${record.target}`,
      `queue: ${record.queueName}`,
      `taskId: ${record.taskId}`,
      `startedAt: ${new Date(record.startedAt).toISOString()}`,
      "---",
      "# Prompt",
      "",
      rawPrompt,
      "",
      "---",
      "",
    ];
    await record.accumulator.writeHeader(`${lines.join("\n")}\n`);
  }

  /**
   * Layer-2 probe (T4): the silence window elapsed with no run event, so a
   * probing `user.message` is dispatched into the run session asking it to
   * either report DONE or keep working. The wall-clock timeout (layer 3)
   * remains the only backstop — a failed probe dispatch is logged, with no
   * force-close added.
   */
  async #handleProbe(sessionId: string): Promise<void> {
    const record = this.#runs.get(sessionId);
    if (record === undefined) return; // run ended before the probe fired
    const silentMinutes = Math.max(1, Math.round(record.silentMs / 60_000));
    const result = await this.#dispatchClientEvent({
      type: "user.message",
      clientSessionId: sessionId,
      text: buildProbeMessage(silentMinutes),
    });
    if (!result.ok) {
      this.#logger.warn(`[queue] probe dispatch failed for run "${sessionId}": ${result.reason}`);
    }
  }

  #endRun(sessionId: string): void {
    const record = this.#runs.get(sessionId);
    if (record === undefined) return;
    clearTimeout(record.timer);
    record.probe.stop();
    this.#runs.delete(sessionId);
    // Tombstone (timeout teardown spec D4): arm the reconciliation grace
    // window — the caller's cleanup chain may still be about to delete the
    // task file.
    this.#recordEnd(sessionId);
  }

  /**
   * Writes the run's single history line (run-history spec D2/D3) at a run
   * endpoint. One line per finished run; `stop()`-cleared in-flight runs
   * write nothing, and neither do pre-fire skips (no RunRecord exists for
   * those). The writer never throws, so this can be awaited anywhere in a
   * endpoint without risk.
   */
  async #writeHistory(
    record: RunRecord,
    outcome: RunHistoryOutcome,
    extra: { reason?: string } = {},
  ): Promise<void> {
    await appendRunHistory(
      "queue",
      {
        runId: record.sessionId,
        ts: new Date(record.startedAt).toISOString(),
        ms: Date.now() - record.startedAt,
        outcome,
        ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
        channel: this.#channelName,
        ...(record.agentSessionId !== undefined ? { agent: record.agentSessionId } : {}),
        file: record.accumulator.filePath,
      },
      this.#historyRoot,
    );
  }

  #inFlight(queueName: string): number {
    let count = 0;
    for (const record of this.#runs.values()) {
      if (record.queueName === queueName) count++;
    }
    return count;
  }

  /**
   * At-least-once restart (spec D2): every `running` task of an owned queue
   * is reset to `pending` so the next tick re-fires it. `failed` (the
   * dead-letter terminal state, spec D2/T02) is deliberately untouched — a
   * failed task is only ever re-queued explicitly (`queue retry`). Tasks of
   * queues owned by other channels are untouched.
   */
  async #resetRunningTasks(): Promise<void> {
    let definitions: QueueDefinition[];
    try {
      definitions = await listQueueDefinitions(this.#queuesRoot);
    } catch (error) {
      this.#logger.error("[queue] failed to load queue definitions while resetting running tasks:", error);
      return;
    }
    for (const definition of definitions) {
      if (definition.channel !== this.#channelName) continue;
      let tasks: QueueTask[];
      try {
        tasks = await listQueueTasks(definition.name, this.#queuesRoot);
      } catch (error) {
        this.#logger.error(
          `[queue] failed to load tasks of queue "${definition.name}" while resetting:`,
          error,
        );
        continue;
      }
      for (const task of tasks) {
        if (task.state !== "running") continue;
        try {
          await setQueueTaskState(definition.name, task.id, "pending", this.#queuesRoot);
        } catch (error) {
          this.#logger.error(
            `[queue] failed to reset task "${task.id}" of queue "${definition.name}" to pending:`,
            error,
          );
        }
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

  async #dispatchSafe(event: ClientOutputEvent): Promise<void> {
    try {
      await this.#dispatchClientEvent(event);
    } catch (error) {
      this.#logger.error("[queue] failed to dispatch synthetic event:", error);
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
      this.#logger.error(`[queue] failed to deliver event to target "${target}":`, error);
    }
  }

  async #deleteTask(queueName: string, taskId: string): Promise<void> {
    try {
      await deleteQueueTask(queueName, taskId, this.#queuesRoot);
    } catch (error) {
      this.#logger.error(`[queue] failed to delete task "${taskId}" of queue "${queueName}":`, error);
    }
  }
}
