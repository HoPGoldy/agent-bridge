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
 *   timeout timer (same 10-minute default as scheduled tasks); a run ends
 *   when the controller receives its completion/failure signal through
 *   {@link QueueController.handleOutput} or when the timer fires;
 * - firing: a synthetic `command.session.new` (carrying the queue's pinned
 *   `model` when it has one) followed by a `user.message` whose text is the
 *   queue body plus the task prompt (spec D2). Fire failures are
 *   fail-and-drop (decided): the failure notice goes to the queue's `target`
 *   chat and the task file is deleted.
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
import { DEFAULT_TIMEOUT_MS } from "../schedule/task-file";
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
  deleteQueueTask,
  listQueueDefinitions,
  listQueueTasks,
  setQueueTaskState,
  type QueueDefinition,
  type QueueTask,
} from "./queue-file";

/** Default tick interval: 30 s (spec D2). */
export const DEFAULT_TICK_MS = 30_000;

export interface QueueControllerOptions {
  channelName: string;
  tickMs?: number;
  /**
   * Max run duration in ms before a task times out; defaults to the same
   * 10-minute constant as scheduled tasks (spec D2).
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
  logger?: Logger;
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
  timer: NodeJS.Timeout;
  /** Per-run output accumulator (T4): every assistant message is appended here. */
  accumulator: RunAccumulator;
  /** Per-run silence probe (T4): fires a probing user.message after inactivity. */
  probe: SilenceProbe;
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

  /** Active runs keyed by their run-unique synthetic session id. */
  readonly #runs = new Map<string, RunRecord>();

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
    this.#logger = options.logger ?? createLogger("queue");
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
   * Routes a diverted agent-output event for a `queue:*` session (T4,
   * three-layer completion protocol per qa-log 2026-08-19（二）).
   *
   * `assistant.message` no longer ends the run: it is classified against the
   * DONE-marker protocol, appended to the run's accumulator and pokes the
   * silence probe. When DONE is detected the run ends, ONE delivery (content
   * plus a trailing italic one-liner via `queue.taskCompletedSuffix`) with the
   * full accumulated text (plus all attachments) is delivered, the task file
   * is deleted and the worker slot is freed — the
   * slot is held until DONE/failure/timeout (WAITING, decided), so with
   * `workers=1` a second task cannot fire between the first message and DONE.
   * A terminal `error` delivers a localized failure notice with any
   * accumulated partial content, deletes the task file and ends the run.
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
      // Unbound queue (empty `target`): never consumed; tasks pile up until
      // `/queue-here` binds a chat (spec D2).
      if (definition.target === undefined) continue;

      const capacity = definition.workers - this.#inFlight(definition.name);
      if (capacity <= 0) continue;

      let tasks: QueueTask[];
      try {
        tasks = await listQueueTasks(definition.name, this.#queuesRoot);
      } catch (error) {
        this.#logger.error(`[queue] failed to load tasks of queue "${definition.name}":`, error);
        continue;
      }
      // Oldest `pending` tasks up to capacity (lexicographic file order IS
      // the FIFO order, spec D1).
      const pending = tasks.filter((task) => task.state === "pending").slice(0, capacity);
      for (const task of pending) {
        if (!this.#started) return;
        await this.#fire(definition, task);
      }
    }
  }

  /**
   * Fires one task (spec D2): marks it `running`, registers the run with its
   * timeout timer BEFORE dispatching (the run id must exist before any
   * output can arrive), then dispatches `command.session.new` (carrying the
   * queue's pinned `model` when it has one) and checks the ingress result —
   * a failed session creation stops the fire right there, so the follow-up
   * `user.message` can never auto-create a model-less session (T6). The
   * `user.message` text is `<queue body>\n\n<task prompt>` (body empty →
   * just the prompt).
   */
  async #fire(definition: QueueDefinition, task: QueueTask): Promise<void> {
    try {
      await setQueueTaskState(definition.name, task.id, "running", this.#queuesRoot);
    } catch (error) {
      this.#logger.error(
        `[queue] failed to mark task "${task.id}" of queue "${definition.name}" as running:`,
        error,
      );
      return;
    }
    const target = definition.target;
    if (target === undefined) {
      // Defensive: #tick only fires queues with a target.
      this.#logger.warn(`[queue] queue "${definition.name}" has no target; skipping task "${task.id}"`);
      return;
    }

    const record = this.#registerRun(definition, task, target);
    if (record === null) {
      // SF-2: stopped while the fire was in flight; the task file stays
      // `running` and is re-enqueued at the next start (at-least-once).
      this.#logger.warn(
        `[queue] controller stopped during fire of "${definition.name}:${task.id}"; run not registered`,
      );
      return;
    }
    const sessionId = record.sessionId;

    try {
      const sessionResult = await this.#dispatchClientEvent({
        type: "command.session.new",
        clientSessionId: sessionId,
        workingDirectory: process.cwd(),
        workingDirectorySource: "default",
        // Per-queue model override (spec D1): only present when the queue
        // pins one; absent stays undefined so the channel config model
        // resolution is unchanged.
        ...(definition.model !== undefined ? { model: definition.model } : {}),
      });
      if (!sessionResult.ok) {
        await this.#failFire(record, sessionResult.reason);
        return;
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
   * ends the run and delivers a localized failure notice with the real
   * reason to the queue's `target`, then deletes the task file (fail-and-drop,
   * decided). Stop-race (SF-2): a dispatch in flight across a stop resolves
   * `{ ok: false, reason: "gateway is not running" }` — that is not a task
   * failure; nothing is delivered and the task file stays `running` so the
   * next start re-enqueues it (at-least-once).
   */
  async #failFire(record: RunRecord, reason: string): Promise<void> {
    this.#endRun(record.sessionId);
    this.#logger.warn(`[queue] task "${record.taskId}" of queue "${record.queueName}" failed: ${reason}`);
    if (!this.#started) return;
    await this.#deleteTask(record.queueName, record.taskId);
    // T1: content first (the real reason), then a trailing italic one-liner
    // referencing the kept accumulation file.
    await this.#deliverToTarget(
      record.target,
      `${reason}\n\n${this.#t("queue.taskFailedSuffix", {
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
   * (fail-and-drop). The run/slot is already released by the caller (DONE
   * end-run) once this runs. T1: content first, then a trailing italic
   * one-liner — no prefix header, task id dropped from the attribution.
   */
  async #completeTask(record: RunRecord): Promise<void> {
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

  /** Failure from a diverted `error` event (T4): notice + reason, no partial transcript. */
  async #failTask(record: RunRecord, reason: string): Promise<void> {
    const { queueName, taskId, target } = record;
    // The reason stays visible; the partial transcript is NOT inlined — it
    // lives in the kept accumulation file that the suffix references.
    const suffix = this.#t("queue.taskFailedSuffix", {
      queue: queueName,
      path: record.accumulator.filePath,
    });
    const notice = `${reason}\n\n${suffix}`;
    await this.#deliverToTarget(target, notice);
    await this.#deleteTask(queueName, taskId);
  }

  async #handleTimeout(sessionId: string): Promise<void> {
    const record = this.#runs.get(sessionId);
    if (record === undefined) return; // run already ended
    this.#runs.delete(sessionId);
    record.probe.stop();
    const { queueName, taskId, target } = record;
    this.#logger.warn(
      `[queue] task "${taskId}" of queue "${queueName}" timed out after ${this.#runTimeoutMs}ms`,
    );
    // Abort this run's own session (same core command as the scheduler).
    await this.#dispatchSafe({
      type: "command.session.stop",
      clientSessionId: sessionId,
    });
    await this.#deleteTask(queueName, taskId);

    // The partial transcript is NOT inlined — the kept accumulation file is
    // referenced by the trailing italic one-liner.
    const suffix = this.#t("queue.taskTimedOutSuffix", {
      queue: queueName,
      path: record.accumulator.filePath,
    });
    await this.#deliverToTarget(target, suffix);
  }

  /** Registers the run, its timeout timer, accumulator and silence probe; `null` when stopped (SF-2). */
  #registerRun(definition: QueueDefinition, task: QueueTask, target: string): RunRecord | null {
    if (!this.#started) return null;
    const sessionId = `${QUEUE_SESSION_PREFIX}${definition.name}:${task.id}`;
    // T4: per-run output accumulator and silence probe, alongside the
    // existing wall-clock timeout (the layer-3 backstop). The probe is armed
    // (poked) at run start so its silence window opens as soon as the run
    // registers.
    const probe = createSilenceProbe({
      silentMs: definition.silenceMs,
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
      silentMs: definition.silenceMs,
      accumulator: createRunAccumulator({
        sessionId,
        ...(this.#outputsDir !== undefined ? { outputsDir: this.#outputsDir } : {}),
      }),
      probe,
      timer: setTimeout(() => {
        void this.#handleTimeout(sessionId);
      }, this.#runTimeoutMs),
    };
    record.timer.unref?.();
    this.#runs.set(sessionId, record);
    return record;
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
   * is reset to `pending` so the next tick re-fires it. Tasks of queues
   * owned by other channels are untouched.
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
