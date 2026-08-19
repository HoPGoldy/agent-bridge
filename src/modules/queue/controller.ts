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

import type { ClientInputEvent, ClientOutputEvent, IngressResult, OutboundAttachment } from "../../types";
import type { Translator } from "../../i18n";
import { createLogger, type Logger } from "../../core/logger";
import { DEFAULT_TIMEOUT_MS } from "../schedule/task-file";
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
  logger?: Logger;
}

interface RunRecord {
  /** The run-unique synthetic clientSessionId (`queue:<queue>:<taskId>`). */
  sessionId: string;
  queueName: string;
  taskId: string;
  /** Delivery address captured at fire time (spec D2). */
  target: string;
  timer: NodeJS.Timeout;
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
   * after stop (same contract as the scheduler, T6).
   */
  async stop(): Promise<void> {
    this.#started = false;
    if (this.#tickTimer) {
      clearTimeout(this.#tickTimer);
      this.#tickTimer = null;
    }
    for (const record of this.#runs.values()) {
      clearTimeout(record.timer);
    }
    this.#runs.clear();
  }

  /**
   * Routes a diverted agent-output event for a `queue:*` session (spec D3).
   * `assistant.message` is the completion signal: the result (a localized
   * completion notice naming queue and task) is delivered to the run's
   * `target` together with any attachments the task produced (same contract
   * as the scheduler), the task file is deleted (fail-and-drop) and the run
   * ends. A
   * terminal `error` delivers a localized failure notice with the real
   * reason, deletes the task file and ends the run. Every other event type
   * is discarded. Events whose run-unique id has no active run are dropped
   * and logged (orphan).
   */
  handleOutput(event: ClientInputEvent): void {
    if (!event.clientSessionId.startsWith(QUEUE_SESSION_PREFIX)) return;
    const record = this.#runs.get(event.clientSessionId);
    if (record === undefined) {
      this.#logger.info(`[queue] dropping orphan output for run "${event.clientSessionId}"`);
      return;
    }

    if (event.type === "assistant.message") {
      this.#endRun(event.clientSessionId);
      const text = event.text ?? "";
      void this.#completeTask(record, text, event.attachments);
      return;
    }

    if (event.type === "error") {
      this.#endRun(event.clientSessionId);
      const reason = event.detail ?? "agent run failed";
      void this.#failTask(record, reason);
      return;
    }

    // Intermediate/progress events are discarded (spec D2).
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

      const text = definition.body === "" ? task.prompt : `${definition.body}\n\n${task.prompt}`;
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
    await this.#deliverToTarget(
      record.target,
      this.#t("queue.taskFailed", { queue: record.queueName, taskId: record.taskId, reason }),
    );
  }

  /**
   * Completion (spec D2): deliver the result notice — with the task's
   * attachments when it produced any (same contract as the scheduler) — and
   * delete the task file.
   */
  async #completeTask(
    record: RunRecord,
    text: string,
    attachments?: OutboundAttachment[],
  ): Promise<void> {
    await this.#deliverToTarget(record.target, {
      type: "assistant.message",
      clientSessionId: record.target,
      text: this.#t("queue.taskCompleted", {
        queue: record.queueName,
        taskId: record.taskId,
        result: text,
      }),
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    });
    await this.#deleteTask(record.queueName, record.taskId);
  }

  /** Failure from a diverted `error` event (spec D2): notice + drop. */
  async #failTask(record: RunRecord, reason: string): Promise<void> {
    await this.#deliverToTarget(
      record.target,
      this.#t("queue.taskFailed", { queue: record.queueName, taskId: record.taskId, reason }),
    );
    await this.#deleteTask(record.queueName, record.taskId);
  }

  async #handleTimeout(sessionId: string): Promise<void> {
    const record = this.#runs.get(sessionId);
    if (record === undefined) return; // run already ended
    this.#runs.delete(sessionId);
    this.#logger.warn(
      `[queue] task "${record.taskId}" of queue "${record.queueName}" timed out after ${this.#runTimeoutMs}ms`,
    );
    // Abort this run's own session (same core command as the scheduler).
    await this.#dispatchSafe({
      type: "command.session.stop",
      clientSessionId: sessionId,
    });
    await this.#deleteTask(record.queueName, record.taskId);
    await this.#deliverToTarget(
      record.target,
      this.#t("queue.taskTimedOut", { queue: record.queueName, taskId: record.taskId }),
    );
  }

  /** Registers the run and its timeout timer; `null` when stopped (SF-2). */
  #registerRun(definition: QueueDefinition, task: QueueTask, target: string): RunRecord | null {
    if (!this.#started) return null;
    const sessionId = `${QUEUE_SESSION_PREFIX}${definition.name}:${task.id}`;
    const record: RunRecord = {
      sessionId,
      queueName: definition.name,
      taskId: task.id,
      target,
      timer: setTimeout(() => {
        void this.#handleTimeout(sessionId);
      }, this.#runTimeoutMs),
    };
    record.timer.unref?.();
    this.#runs.set(sessionId, record);
    return record;
  }

  #endRun(sessionId: string): void {
    const record = this.#runs.get(sessionId);
    if (record === undefined) return;
    clearTimeout(record.timer);
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
