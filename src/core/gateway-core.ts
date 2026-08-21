import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentOutputEvent,
  AgentSessionStateApi,
  ChannelCommonContext,
  ClientInputEvent,
  ClientOutputEvent,
  ClientWorkingDirectorySource,
  GatewayCoreOptions,
  IngressResult,
} from "../types";
import { createAgentSessionStateRegistry } from "../config/agent-session-state";
import { createInMemoryChannelStateStore, QUEUES_DIR } from "../config/channel-state";
import { SYNTHETIC_SESSION_PREFIX } from "../modules/schedule/scheduler";
import {
  isValidQueueName,
  loadQueueDefinition,
  QUEUE_SESSION_PREFIX,
  bindQueue,
  type QueueDefinition,
} from "../modules/queue/queue-file";
import { getTranslatorForCommon, type Translator } from "../i18n";
import { createLogger, type Logger } from "./logger";

/**
 * Constructor options for `GatewayCore`: the shared `GatewayCoreOptions` plus
 * the optional synthetic-output divert callbacks (spec D2/D3). Declared here
 * rather than in `types.ts` because the divert targets are core-internal
 * mechanisms — the channel runner wires them to the per-channel scheduler and
 * queue controller. The callback types are structural; the only synthetic-
 * session imports are the shared `SYNTHETIC_SESSION_PREFIX` and
 * `QUEUE_SESSION_PREFIX` constants, so core and controllers can never drift on
 * the `schedule:` / `queue:` prefixes.
 */
export interface GatewayCoreConstructorOptions extends GatewayCoreOptions {
  /**
   * Optional divert target for agent output of `schedule:*` sessions (spec
   * D2). When provided, every output event whose resolved clientSessionId
   * starts with `schedule:` is handed to this callback (with the replaced
   * clientSessionId) instead of being delivered through the IM adapter. A
   * throwing callback is logged and swallowed; without the callback
   * `schedule:*` output falls back to the normal adapter path (defensive).
   */
  onScheduleOutput?: (event: ClientInputEvent) => void | Promise<void>;
  /**
   * Optional divert target for agent output of `queue:*` sessions (spec D3).
   * Same mechanics as `onScheduleOutput`: every output event whose resolved
   * clientSessionId starts with `queue:` is handed to this callback (with the
   * replaced clientSessionId) instead of the IM adapter, a throwing callback
   * is logged and swallowed, and without the callback `queue:*` output falls
   * back to the normal adapter path (defensive). Each controller receives
   * only its own prefix's events.
   */
  onQueueOutput?: (event: ClientInputEvent) => void | Promise<void>;
  /**
   * Root directory of the event-queue definition files (`queues/<name>.md`,
   * spec D1). Read by the core-routed `/queue-here` command (spec D4) to
   * check existence and binding before writing the current channel's name and
   * the chat's `clientSessionId` into the `channel`/`target` lines (T1's
   * `bindQueue`); defaults to the built-in `QUEUES_DIR`. Tests point this at
   * a temporary directory.
   */
  queuesRoot?: string;
}

interface AgentRuntime {
  agentSessionId: string;
  clientSessionId: string;
  agentAdapter: AgentAdapter;
  lastActiveAt: number;
  idleTimer: NodeJS.Timeout | null;
}

export class GatewayCore {
  readonly #imAdapter: GatewayCoreOptions["imAdapter"];
  readonly #agentModule: GatewayCoreOptions["agentModule"];
  readonly #agentConfig: GatewayCoreOptions["agentConfig"];
  readonly #agentIdleTimeoutMs: number;
  readonly #allowedWorkingDirectoryRoots?: string[];
  readonly #channelStateStore: NonNullable<GatewayCoreOptions["channelStateStore"]>;
  readonly #agentSessionStateRegistry: NonNullable<GatewayCoreOptions["agentSessionStateRegistry"]>;
  readonly #common?: ChannelCommonContext;
  readonly #t: Translator;
  readonly #logger: Logger = createLogger("core");
  /**
   * Optional divert target for `schedule:*` agent output (spec D2), wired by
   * the channel runner to the scheduler's `handleOutput`.
   */
  readonly #onScheduleOutput?: (event: ClientInputEvent) => void | Promise<void>;
  /**
   * Optional divert target for `queue:*` agent output (spec D3), wired by the
   * channel runner to the queue controller's output handler.
   */
  readonly #onQueueOutput?: (event: ClientInputEvent) => void | Promise<void>;
  /** Queue-definition root read and written by `/queue-here` (spec D4). */
  readonly #queuesRoot: string;
  /** Pure routing map: client session id -> agent session id. */
  readonly #clientToAgentSession = new Map<string, string>();
  readonly #agentRuntimes = new Map<string, AgentRuntime>();
  /**
   * Client-output handlers that have already entered and are still settling.
   * Used by stop() to wait for in-flight work (for example a `/new` whose
   * agent create is still pending) so no runtime leaks and no binding save is
   * enqueued after the drain. Each tracked promise never rejects.
   */
  readonly #inFlightHandlers = new Set<Promise<IngressResult>>();
  #started = false;

  constructor({
    imAdapter,
    agentModule,
    agentConfig,
    agentIdleTimeoutMs,
    allowedWorkingDirectoryRoots,
    channelStateStore,
    agentSessionStateRegistry,
    common,
    onScheduleOutput,
    onQueueOutput,
    queuesRoot,
  }: GatewayCoreConstructorOptions) {
    this.#imAdapter = imAdapter;
    this.#agentModule = agentModule;
    this.#agentConfig = agentConfig;
    this.#agentIdleTimeoutMs = agentIdleTimeoutMs;
    this.#allowedWorkingDirectoryRoots = allowedWorkingDirectoryRoots;
    this.#channelStateStore = channelStateStore ?? createInMemoryChannelStateStore();
    this.#agentSessionStateRegistry =
      agentSessionStateRegistry ?? createAgentSessionStateRegistry(this.#channelStateStore);
    this.#common = common;
    this.#t = getTranslatorForCommon(common);
    this.#onScheduleOutput = onScheduleOutput;
    this.#onQueueOutput = onQueueOutput;
    this.#queuesRoot = queuesRoot ?? QUEUES_DIR;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    const document = await this.#channelStateStore.load();
    for (const [clientSessionId, agentSessionId] of Object.entries(document.bindings)) {
      this.#clientToAgentSession.set(clientSessionId, agentSessionId);
    }

    await this.#imAdapter.start(async (event) => {
      await this.#processClientOutput(event);
    });
  }

  /**
   * Public ingress for synthetic client-output events (spec D2): the
   * scheduler fires task runs by dispatching `command.session.new` and
   * `user.message` here. Events travel the exact same path as
   * adapter-delivered messages — the same shutdown guard, error capture and
   * in-flight tracking — so task sessions behave like ordinary sessions in
   * every respect except the `schedule:*` divert below. Never rejects: a
   * failed handler resolves `{ ok: false, reason }` with the underlying
   * error message, so the scheduler can fail the whole fire instead of
   * letting the follow-up `user.message` auto-create a model-less session
   * (T6).
   */
  async input(event: ClientOutputEvent): Promise<IngressResult> {
    return this.#processClientOutput(event);
  }

  /**
   * Shared client-output ingress used by both the adapter callback in
   * `start()` and the public `input()`: reject once stop has begun, track
   * every handler until it settles, and never let a failing handler produce
   * an unhandled rejection — a failing handler resolves `{ ok: false, reason }`
   * instead. A single implementation keeps the two entry points from
   * drifting apart.
   */
  async #processClientOutput(event: ClientOutputEvent): Promise<IngressResult> {
    // Reject new client output once stop has begun: the adapter may still
    // deliver events while it is shutting down, and those must not start
    // any new work after we have decided to stop.
    if (!this.#started) return { ok: false, reason: "gateway is not running" };

    // The handled promise never rejects, so a failing handler can never
    // produce an unhandled rejection; the adapter still awaits it so per-
    // channel backpressure and ordering are preserved.
    const handled: Promise<IngressResult> = this.#handleClientOutput(event).then(
      (result) => result,
      (error: unknown) => {
        this.#logger.error("failed to process client output event:", error);
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      },
    );
    this.#inFlightHandlers.add(handled);
    try {
      return await handled;
    } finally {
      this.#inFlightHandlers.delete(handled);
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    // Stop accepting new client output first, before anything else, so no new
    // handler can enter after this point.
    this.#started = false;

    await this.#imAdapter.stop();

    // Best-effort stop pass 1: stop the current runtimes before waiting on the
    // in-flight handlers. A handler can be blocked inside agentAdapter.input()
    // (for example a user.message awaiting the agent run); stopping the
    // adapter aborts/unblocks it, so the drain below cannot hang on it.
    await this.#stopAllRuntimes();

    // Drain-until-quiescent: an already-entered handler (for example a `/new`
    // whose agent create is still pending) can start a new runtime, bind it,
    // and enqueue a binding save while we are waiting. Stopping runtimes or
    // draining before it settles would leak the runtime and lose the binding
    // when the process exits right after stop.
    while (true) {
      while (this.#inFlightHandlers.size > 0) {
        await Promise.allSettled([...this.#inFlightHandlers]);
      }
      await this.#drainPersist();
      if (this.#inFlightHandlers.size === 0) break;
    }

    // Best-effort stop pass 2: stop any runtime a handler created while the
    // drain was waiting (for example a `/new` whose create completed during
    // stop). A single throwing stop must not prevent the remaining runtimes
    // from being stopped or the bindings from being drained.
    await this.#stopAllRuntimes();

    await this.#drainPersist();
  }

  /** Best-effort stop of every tracked runtime; a throwing stop cannot prevent the rest. */
  async #stopAllRuntimes(): Promise<void> {
    const runtimes = [...this.#agentRuntimes.values()];
    const results = await Promise.allSettled(runtimes.map((runtime) => this.#stopRuntime(runtime)));
    for (const result of results) {
      if (result.status === "rejected") {
        this.#logger.error("failed to stop agent session:", result.reason);
      }
    }
  }

  async #handleClientOutput(event: ClientOutputEvent): Promise<IngressResult> {
    if (event.type === "command.session.new") {
      return this.#handleSessionNew(
        event.clientSessionId,
        event.workingDirectory,
        event.workingDirectorySource,
        event.model,
      );
    }

    if (event.type === "command.session.compact") {
      await this.#handleSessionCompact(event.clientSessionId);
      return { ok: true };
    }

    if (event.type === "command.session.stop") {
      await this.#handleSessionStop(event.clientSessionId);
      return { ok: true };
    }

    if (event.type === "command.session.status") {
      await this.#handleSessionStatus(event.clientSessionId);
      return { ok: true };
    }

    if (event.type === "command.session.model.list") {
      await this.#handleSessionModelList(event.clientSessionId);
      return { ok: true };
    }

    if (event.type === "command.session.model.set") {
      await this.#handleSessionModelSet(event.clientSessionId, event.target);
      return { ok: true };
    }

    // Core-routed `/queue-here <name>` (spec D4): the IM adapters do not
    // parse this command, so an unrecognized slash command arrives here as a
    // plain chat-originated `user.message` — the core recognizes the raw
    // text itself. Synthetic (`schedule:*` / `queue:*`) sessions never take
    // this path: their user.message texts are controller-injected prompts.
    if (
      event.type === "user.message" &&
      !this.#isSyntheticClientSession(event.clientSessionId) &&
      (await this.#handleQueueHereCommand(event.clientSessionId, event.text))
    ) {
      return { ok: true };
    }

    await this.#handleUserMessage(event.clientSessionId, event.text);
    return { ok: true };
  }

  async #handleUserMessage(clientSessionId: string, text: string): Promise<void> {
    // Defensive invariant (spec D1/D3/T6): a synthetic session (`schedule:*`
    // or `queue:*`) is created exclusively by its synthetic
    // `command.session.new` — the scheduler / queue controller always
    // dispatches session.new first and stops on failure. A `user.message` for
    // an unbound synthetic id must never auto-create a session: that path
    // would run without the task's model override (the pre-T6 silent
    // fallback). Log and drop; the intentional drop counts as handled
    // (`{ ok: true }`).
    if (this.#isSyntheticClientSession(clientSessionId) && !this.#clientToAgentSession.has(clientSessionId)) {
      const kind = this.#isSyntheticScheduleSession(clientSessionId) ? "schedule" : "queue";
      this.#logger.warn(
        `dropping user.message for unbound ${kind} session ${clientSessionId}`,
      );
      return;
    }
    const runtime = await this.#getOrCreateActiveRuntime(clientSessionId);
    this.#touchRuntime(runtime);
    await runtime.agentAdapter.input({
      type: "user.message",
      text,
    });
  }

  /**
   * Core-routed `/queue-here <name>` command (spec D4): binds the current
   * chat as the queue's delivery target by writing BOTH the current channel's
   * config name and the chat's `clientSessionId` into the queue file's
   * `channel`/`target` front-matter lines in one atomic write (T1's
   * `bindQueue`); the per-channel queue controller picks the binding up on
   * its next tick reload — no direct controller call. Unlike the
   * adapter-local `/schedule-here` (which never reaches the core), the IM
   * adapters do not parse this command, so the raw text arrives as a plain
   * `user.message` and is recognized here. The `target` string is the sending
   * chat's `clientSessionId` — the exact format the queue controller's
   * deliver callback consumes (same as `/schedule-here`). Because `channel`
   * is always set to the current channel at bind time, a queue can be bound
   * from any chat (a stale `channel` line from an older file is overwritten
   * like any other). Refuses when the queue is missing or already carries a
   * `target` (rebinding is an AI file edit). Returns `true` when `text` was a
   * `/queue-here` command (handled, never reaching the agent session) and
   * `false` otherwise.
   */
  async #handleQueueHereCommand(clientSessionId: string, text: string): Promise<boolean> {
    const match = text.match(/^\/queue-here(?:\s+(.*))?$/i);
    if (match === null) {
      return false;
    }
    // Queue files are lowercased slugs; normalize so `/queue-here Build`
    // binds the `build` queue (same normalization as `/schedule-here`).
    const name = (match[1]?.trim() ?? "").toLowerCase();
    if (!isValidQueueName(name)) {
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("client.queueHereUsage"),
      });
      return true;
    }

    let definition: QueueDefinition | null;
    try {
      definition = await loadQueueDefinition(name, this.#queuesRoot);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger.error(`failed to load queue "${name}" for /queue-here:`, error);
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("client.queueHereFailed", { name, reason: detail }),
      });
      return true;
    }
    if (definition === null) {
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("client.queueHereQueueNotFound", { name }),
      });
      return true;
    }
    // Already-bound check: a queue whose `target` is set is refused — the
    // channel is always rewritten to the current one at bind time, so the
    // only way to move a queue is to unbind it first (edit the file with AI).
    if (definition.target !== undefined) {
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("client.queueHereAlreadyBound", { name }),
      });
      return true;
    }

    const channelName = this.#common?.channelName;
    if (channelName === undefined || channelName === "") {
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("client.queueHereFailed", {
          name,
          reason: "no channel context to bind the queue to",
        }),
      });
      return true;
    }

    const result = await bindQueue(name, channelName, clientSessionId, this.#queuesRoot);
    if (!result.ok) {
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("client.queueHereFailed", { name, reason: result.reason }),
      });
      return true;
    }
    await this.#deliverClientInput({
      type: "assistant.message",
      clientSessionId,
      text: this.#t("client.queueHereBound", { name }),
    });
    return true;
  }

  async #handleSessionCompact(clientSessionId: string): Promise<void> {
    const runtime = await this.#getActiveRuntime(clientSessionId);
    if (!runtime) {
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("gateway.noActiveSessionToCompact"),
      });
      return;
    }

    this.#touchRuntime(runtime);
    await runtime.agentAdapter.input({
      type: "command.session.compact",
    });
  }

  async #handleSessionStop(clientSessionId: string): Promise<void> {
    const runtime = await this.#getActiveRuntime(clientSessionId);
    if (!runtime) {
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("gateway.noActiveSessionToStop"),
      });
      return;
    }

    this.#touchRuntime(runtime);

    if (!runtime.agentAdapter.abort) {
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("gateway.sessionCannotBeStopped"),
      });
      return;
    }

    await runtime.agentAdapter.abort();
  }

  async #handleSessionStatus(clientSessionId: string): Promise<void> {
    const runtime = await this.#getActiveRuntime(clientSessionId);
    if (!runtime) {
      await this.#deliverClientInput({
        type: "error",
        clientSessionId,
        kind: "agent.status.unavailable",
      });
      return;
    }

    this.#touchRuntime(runtime);

    if (!runtime.agentAdapter.getStatus) {
      await this.#deliverClientInput({
        type: "error",
        clientSessionId,
        kind: "agent.status.unavailable",
      });
      return;
    }

    try {
      const status = await runtime.agentAdapter.getStatus();
      await this.#deliverClientInput({
        type: "agent.status.info",
        clientSessionId,
        status,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.#deliverClientInput({
        type: "error",
        clientSessionId,
        kind: "agent.status.unavailable",
        detail,
      });
    }
  }

  async #handleSessionModelList(clientSessionId: string): Promise<void> {
    const runtime = await this.#getActiveRuntime(clientSessionId);
    if (!runtime) {
      await this.#deliverClientInput({
        type: "error",
        clientSessionId,
        kind: "agent.model.list.unavailable",
      });
      return;
    }

    this.#touchRuntime(runtime);

    if (!runtime.agentAdapter.getAvailableModels) {
      await this.#deliverClientInput({
        type: "error",
        clientSessionId,
        kind: "agent.model.list.unavailable",
      });
      return;
    }

    try {
      const models = await runtime.agentAdapter.getAvailableModels();
      await this.#deliverClientInput({
        type: "agent.model.list",
        clientSessionId,
        models,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.#deliverClientInput({
        type: "error",
        clientSessionId,
        kind: "agent.model.list.unavailable",
        detail,
      });
    }
  }

  async #handleSessionModelSet(clientSessionId: string, target: string): Promise<void> {
    const runtime = await this.#getActiveRuntime(clientSessionId);
    if (!runtime) {
      await this.#deliverClientInput({
        type: "error",
        clientSessionId,
        kind: "agent.model.set.unavailable",
      });
      return;
    }

    this.#touchRuntime(runtime);

    if (!runtime.agentAdapter.setModel) {
      await this.#deliverClientInput({
        type: "error",
        clientSessionId,
        kind: "agent.model.set.unavailable",
      });
      return;
    }

    try {
      const result = await runtime.agentAdapter.setModel(target);
      await this.#deliverClientInput({
        type: "agent.model.updated",
        clientSessionId,
        provider: result.provider,
        modelId: result.modelId,
      });
    } catch (error) {
      const { kind, detail } = this.#resolveModelCommandError(error);
      await this.#deliverClientInput({
        type: "error",
        clientSessionId,
        kind,
        ...(detail ? { detail } : {}),
      });
    }
  }

  async #handleSessionNew(
    clientSessionId: string,
    workingDirectory: string,
    workingDirectorySource: ClientWorkingDirectorySource,
    model?: string,
  ): Promise<IngressResult> {
    // Transactional switch: create and start the new runtime (and its state
    // record) first so a failed creation never tears down the previous
    // session, its binding, or its runtime.
    let newRuntime: AgentRuntime;
    try {
      newRuntime = await this.#createRuntimeForClient(clientSessionId, {
        workingDirectory,
        workingDirectorySource,
        model,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger.error(`failed to create new agent session for ${clientSessionId}:`, error);
      if (!this.#isSyntheticClientSession(clientSessionId)) {
        // Chat-originated `/new` keeps its localized failure notice (T6: for
        // synthetic ids the adapters cannot resolve the id and would drop the
        // notice anyway — the failure surfaces through the ingress result
        // instead, and the scheduler / queue controller delivers it to the
        // task target).
        await this.#deliverClientInput({
          type: "assistant.message",
          clientSessionId,
          text: this.#t("gateway.failedToStartNewSession", { detail }),
        });
      }
      return { ok: false, reason: detail };
    }

    const previousAgentSessionId = this.#clientToAgentSession.get(clientSessionId);
    try {
      // Commit the durable binding (and drop the old record when it is no
      // longer referenced) before stopping the previous runtime, so the new
      // session is authoritative even if the old stop throws.
      await this.#switchClientToAgent(clientSessionId, newRuntime.agentSessionId, previousAgentSessionId);
    } catch (error) {
      // The durable commit failed and the in-memory binding was not updated:
      // clean up the new runtime and its record and keep the previous session
      // authoritative, mirroring a failed create.
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger.error(`failed to persist the new binding for ${clientSessionId}:`, error);
      await this.#cleanupNewRuntime(newRuntime);
      if (!this.#isSyntheticClientSession(clientSessionId)) {
        await this.#deliverClientInput({
          type: "assistant.message",
          clientSessionId,
          text: this.#t("gateway.failedToStartNewSession", { detail }),
        });
      }
      return { ok: false, reason: detail };
    }

    if (previousAgentSessionId) {
      const previousRuntime = this.#agentRuntimes.get(previousAgentSessionId);
      if (previousRuntime) {
        // #stopRuntime always removes the runtime from the map (finally), so a
        // throwing stop must not abort the switch: log it and continue so the
        // new runtime gets bound and the user receives a deterministic reply.
        try {
          await this.#stopRuntime(previousRuntime);
        } catch (error) {
          this.#logger.error(
            `failed to stop previous agent session ${previousRuntime.agentSessionId}:`,
            error,
          );
        }
      }
    }

    if (!this.#isSyntheticClientSession(clientSessionId)) {
      // Spec D1/D3: no "started a new session" confirmation for ephemeral
      // task runs — it would be mistaken for the task result (T3 review).
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("gateway.startedNewSession", { workingDirectory }),
      });
    }

    // Run-history spec D5: carry the freshly created session's id on the ok
    // result so the scheduler / queue controller can capture it at fire time
    // (the authoritative value — a later binding lookup could already point
    // at a newer session). Purely additive: existing callers ignore it.
    return { ok: true, agentSessionId: newRuntime.agentSessionId };
  }

  async #deliverClientInput(event: ClientInputEvent): Promise<void> {
    try {
      await this.#imAdapter.input(event);
    } catch (error) {
      this.#logger.error("failed to deliver client input event:", error);
    }
  }

  async #getActiveRuntime(clientSessionId: string): Promise<AgentRuntime | null> {
    const agentSessionId = this.#clientToAgentSession.get(clientSessionId);
    if (!agentSessionId) {
      return null;
    }
    return this.#getOrRestoreRuntime(clientSessionId, agentSessionId);
  }

  async #getOrCreateActiveRuntime(clientSessionId: string): Promise<AgentRuntime> {
    const existing = await this.#getActiveRuntime(clientSessionId);
    if (existing) {
      return existing;
    }

    const runtime = await this.#createRuntimeForClient(clientSessionId);
    try {
      // The durable first-time binding is committed before the in-memory
      // binding is updated; a failed commit rolls the new runtime back so no
      // unbound runtime or orphan record survives (and a restart cannot
      // resurrect a stale binding over the live in-memory one).
      await this.#bindClientToAgent(clientSessionId, runtime.agentSessionId);
    } catch (error) {
      this.#logger.error(`failed to persist the first binding for ${clientSessionId}:`, error);
      await this.#cleanupNewRuntime(runtime);
      throw error;
    }
    return runtime;
  }

  async #getOrRestoreRuntime(clientSessionId: string, agentSessionId: string): Promise<AgentRuntime> {
    const existing = this.#agentRuntimes.get(agentSessionId);
    if (existing) {
      this.#touchRuntime(existing);
      return existing;
    }

    // Resume is required on the agent module contract: every persistable
    // module restores its adapter from the scoped state handle, so the core
    // never needs to read adapter-owned state (for example the working
    // directory) to guess how to restore a session.
    let adapter: AgentAdapter | null = null;
    try {
      const sessionState = await this.#agentSessionStateRegistry.open<object>({
        agentSessionId,
        agentType: this.#agentModule.type,
        codec: this.#agentModule.sessionStateCodec,
      });
      adapter = await this.#agentModule.resumeAgentSession({
        config: this.#agentConfig,
        common: this.#common ?? { channelName: "", language: "en-US" },
        agentSessionId,
        sessionState,
        ...(this.#allowedWorkingDirectoryRoots !== undefined
          ? { allowedWorkingDirectoryRoots: this.#allowedWorkingDirectoryRoots }
          : {}),
      });
      try {
        return await this.#startRuntime(clientSessionId, agentSessionId, adapter);
      } catch (error) {
        // A partially started resumed adapter must be cleaned up best-effort.
        this.#logger.error(`resumed agent session ${agentSessionId} failed to start, cleaning up:`, error);
        await this.#stopAdapterBestEffort(adapter, agentSessionId);
        throw error;
      }
    } catch (error) {
      // Resume failed: revoke this handle (the record and binding stay intact
      // so a later message can retry), then surface exactly one localized
      // failure with a /new hint. The user asked the agent for work and got
      // silence otherwise.
      await this.#revokeSessionStateBestEffort(agentSessionId);
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger.error(
        `failed to resume agent session ${agentSessionId} for client ${clientSessionId}:`,
        error,
      );
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("gateway.failedToResumeSession", { detail }),
      });
      throw error;
    }
  }

  /**
   * Creates, starts and persists a brand-new agent session. The agent session
   * id is core-owned (`<moduleType>:<uuid>`); the module must initialize its
   * state record through the reserved handle before returning. Any failure
   * (reserve, create, start, initialize, verify) stops the partial adapter,
   * revokes the handle and deletes the reserved record, leaving any previous
   * session, binding and runtime untouched.
   */
  async #createRuntimeForClient(
    clientSessionId: string,
    options?: {
      workingDirectory?: string;
      workingDirectorySource?: ClientWorkingDirectorySource;
      model?: string;
    },
  ): Promise<AgentRuntime> {
    const agentSessionId = `${this.#agentModule.type}:${randomUUID()}`;
    const sessionState = await this.#agentSessionStateRegistry.reserve({
      agentSessionId,
      agentType: this.#agentModule.type,
      codec: this.#agentModule.sessionStateCodec,
    });

    let adapter: AgentAdapter | null = null;
    let runtime: AgentRuntime | null = null;
    try {
      adapter = await this.#agentModule.createAgentSession({
        config: this.#agentConfig,
        common: this.#common ?? { channelName: "", language: "en-US" },
        agentSessionId,
        sessionState,
        ...(options?.workingDirectory !== undefined
          ? { workingDirectory: options.workingDirectory }
          : {}),
        ...(options?.workingDirectorySource !== undefined
          ? { workingDirectorySource: options.workingDirectorySource }
          : {}),
        ...(options?.model !== undefined ? { model: options.model } : {}),
        ...(this.#allowedWorkingDirectoryRoots !== undefined
          ? { allowedWorkingDirectoryRoots: this.#allowedWorkingDirectoryRoots }
          : {}),
      });
      try {
        runtime = await this.#startRuntime(clientSessionId, agentSessionId, adapter);
      } catch (error) {
        this.#logger.error(`agent session ${agentSessionId} failed to start, cleaning up:`, error);
        await this.#stopAdapterBestEffort(adapter, agentSessionId);
        throw error;
      }

      // Verify the module initialized the state record before any binding can
      // point at this session. An uninitialized record must never be committed.
      try {
        await sessionState.flush();
        await sessionState.read();
      } catch (error) {
        this.#logger.error(`agent session ${agentSessionId} was not initialized, cleaning up:`, error);
        if (runtime) {
          await this.#stopRuntime(runtime).catch((stopError) => {
            this.#logger.error(`failed to stop uninitialized agent session ${agentSessionId}:`, stopError);
          });
        }
        throw error;
      }

      return runtime;
    } catch (error) {
      await this.#agentSessionStateRegistry.delete(agentSessionId).catch((cleanupError) => {
        this.#logger.error(`failed to clean up agent session state ${agentSessionId}:`, cleanupError);
      });
      throw error;
    }
  }

  async #startRuntime(
    clientSessionId: string,
    agentSessionId: string,
    agentAdapter: AgentAdapter,
  ): Promise<AgentRuntime> {
    await agentAdapter.start(async (event: AgentOutputEvent) => {
      await this.#handleAgentOutput(event);
    });

    const runtime: AgentRuntime = {
      agentSessionId,
      clientSessionId,
      agentAdapter,
      lastActiveAt: Date.now(),
      idleTimer: null,
    };
    this.#agentRuntimes.set(agentSessionId, runtime);
    this.#touchRuntime(runtime);
    return runtime;
  }

  /** Resolves once every enqueued binding write has finished (drain on stop). */
  #drainPersist(): Promise<void> {
    return this.#channelStateStore.flush();
  }

  /**
   * Durably records the first binding of a client to a freshly created agent
   * session. The durable commit happens before the in-memory binding is
   * updated, so a failed commit leaves no binding behind and rejects so the
   * caller can clean up the new runtime.
   */
  async #bindClientToAgent(clientSessionId: string, agentSessionId: string): Promise<void> {
    if (this.#isSyntheticClientSession(clientSessionId)) {
      // Spec D1/D3: synthetic (`schedule:*` / `queue:*`) bindings live in
      // memory only. The run-unique id would grow the state file forever and
      // ephemeral runs have no resume semantics; a restart dropping the
      // binding matches the "runs are lost on restart" expectation. There is
      // no durable commit here, so the caller's rollback path can never
      // trigger.
      this.#clientToAgentSession.set(clientSessionId, agentSessionId);
      return;
    }
    const proposed = new Map(this.#clientToAgentSession);
    proposed.set(clientSessionId, agentSessionId);
    await this.#channelStateStore.transaction((draft) => {
      draft.bindings = { ...Object.fromEntries(proposed) };
    });
    this.#clientToAgentSession.set(clientSessionId, agentSessionId);
  }

  /**
   * Rebinds a client to a new agent session and, in the same transaction,
   * deletes the previous session's record when no other binding references it.
   * The durable document is committed first; the in-memory binding is only
   * updated after the commit succeeds. A failed commit therefore keeps the
   * previous binding and runtime authoritative, and a restart can never
   * resurrect a stale binding over a live one. Rejects when the durable commit
   * fails; the caller must clean up the new runtime.
   */
  async #switchClientToAgent(
    clientSessionId: string,
    newAgentSessionId: string,
    previousAgentSessionId?: string,
  ): Promise<void> {
    if (this.#isSyntheticClientSession(clientSessionId)) {
      // Spec D1/D3: synthetic bindings are memory-only (see #bindClientToAgent).
      this.#clientToAgentSession.set(clientSessionId, newAgentSessionId);
      return;
    }
    const proposed = new Map(this.#clientToAgentSession);
    proposed.set(clientSessionId, newAgentSessionId);
    const snapshot = Object.fromEntries(proposed);
    await this.#channelStateStore.transaction((draft) => {
      draft.bindings = { ...snapshot };
      if (previousAgentSessionId && previousAgentSessionId !== newAgentSessionId) {
        const stillReferenced = Object.values(snapshot).includes(previousAgentSessionId);
        if (!stillReferenced) {
          delete draft.agentSessions[previousAgentSessionId];
        }
      }
    });
    this.#clientToAgentSession.set(clientSessionId, newAgentSessionId);
  }

  /**
   * Best-effort cleanup of a runtime that was created but never durably bound
   * (a failed first binding or binding switch): stop the adapter (removing the
   * runtime and revoking its live state handle) and delete the reserved
   * record, so no unbound runtime or orphan record survives.
   */
  async #cleanupNewRuntime(runtime: AgentRuntime): Promise<void> {
    try {
      await this.#stopRuntime(runtime);
    } catch (error) {
      this.#logger.error(`failed to stop agent session ${runtime.agentSessionId} during cleanup:`, error);
    }
    try {
      await this.#agentSessionStateRegistry.delete(runtime.agentSessionId);
    } catch (error) {
      this.#logger.error(`failed to delete agent session state ${runtime.agentSessionId} during cleanup:`, error);
    }
  }

  async #stopAdapterBestEffort(adapter: AgentAdapter, agentSessionId: string): Promise<void> {
    try {
      await adapter.stop();
    } catch (error) {
      this.#logger.error(`failed to stop agent adapter ${agentSessionId}:`, error);
    }
  }

  async #revokeSessionStateBestEffort(agentSessionId: string): Promise<void> {
    try {
      await this.#agentSessionStateRegistry.revoke(agentSessionId);
    } catch (error) {
      this.#logger.error(`failed to revoke agent session state ${agentSessionId}:`, error);
    }
  }

  #resolveModelCommandError(error: unknown): { kind: string; detail?: string } {
    const detail = error instanceof Error ? error.message : String(error);
    if (typeof error === "object" && error && "kind" in error && typeof error.kind === "string") {
      switch (error.kind) {
        case "agent.model.invalid":
        case "agent.model.busy":
        case "agent.model.set.unavailable":
          return { kind: error.kind, ...(detail ? { detail } : {}) };
      }
    }
    return { kind: "agent.model.set.unavailable", ...(detail ? { detail } : {}) };
  }

  async #handleAgentOutput(event: AgentOutputEvent): Promise<void> {
    const agentSessionId = event.agentSessionId;
    const runtime = this.#agentRuntimes.get(agentSessionId);
    if (!runtime) {
      this.#logger.info(`dropping output from released agent session ${agentSessionId}`);
      return;
    }

    const clientSessionId = runtime.clientSessionId;
    const activeAgentSessionId = this.#clientToAgentSession.get(clientSessionId);
    if (activeAgentSessionId !== agentSessionId) {
      this.#logger.info(
        `dropping late output from inactive agent session ${agentSessionId} for client ${clientSessionId}`,
      );
      return;
    }

    this.#touchRuntime(runtime);

    if (this.#isSyntheticScheduleSession(clientSessionId) && this.#onScheduleOutput !== undefined) {
      // Spec D2 divert: a `schedule:*` session has no real chat behind it and
      // its output is not streamed into any chat — every event (including the
      // `assistant.message` completion signal) goes to the injected callback
      // (the scheduler's handleOutput) instead of the IM adapter.
      await this.#divertOutput(event, clientSessionId, this.#onScheduleOutput, "schedule");
      return;
    }

    if (this.#isSyntheticQueueSession(clientSessionId) && this.#onQueueOutput !== undefined) {
      // Spec D3 divert: a `queue:*` run has no real chat behind it either,
      // same mechanics as the schedule divert, with every event handed to the
      // queue controller's output callback instead of the IM adapter.
      await this.#divertOutput(event, clientSessionId, this.#onQueueOutput, "queue");
      return;
    }

    if (this.#isToolRelatedEvent(event)) {
      this.#logger.info("forwarding tool event from agent", {
        type: event.type,
        agentSessionId,
        clientSessionId,
        toolName: "toolName" in event ? event.toolName : undefined,
        toolCallId: "toolCallId" in event ? event.toolCallId : undefined,
        toolLabel: "toolLabel" in event ? event.toolLabel : undefined,
        text: event.text,
      });
    }

    if (event.type === "assistant.message") {
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: event.text,
        attachments: event.attachments,
      });
      return;
    }

    await this.#deliverClientInput({
      ...event,
      clientSessionId,
    });
  }

  /**
   * Spec D2/D3: hands an agent-output event for a synthetic session
   * (`schedule:*` / `queue:*`) to the injected divert callback with the
   * resolved clientSessionId substituted (the `assistant.message` branch
   * mirrors the normal delivery path so the controller receives exactly what
   * an adapter would have). A throwing callback is logged and swallowed — it
   * must never surface through the core's ingress. Only called when a
   * callback was injected; without one synthetic output falls back to the
   * normal adapter path.
   */
  async #divertOutput(
    event: AgentOutputEvent,
    clientSessionId: string,
    onOutput: (event: ClientInputEvent) => void | Promise<void>,
    kind: "schedule" | "queue",
  ): Promise<void> {
    const diverted: ClientInputEvent =
      event.type === "assistant.message"
        ? {
            type: "assistant.message",
            clientSessionId,
            text: event.text,
            attachments: event.attachments,
          }
        : { ...event, clientSessionId };
    try {
      await onOutput(diverted);
    } catch (error) {
      this.#logger.error(`failed to divert ${kind} output for ${clientSessionId}:`, error);
    }
  }

  /**
   * Spec D1/D3: synthetic task-run sessions use
   * `schedule:<task>:<yyyymmdd-hhmmss>-<seq>` and `queue:<queue>:<taskId>` ids
   * (run-history spec D4).
   */
  #isSyntheticClientSession(clientSessionId: string): boolean {
    return (
      clientSessionId.startsWith(SYNTHETIC_SESSION_PREFIX) ||
      clientSessionId.startsWith(QUEUE_SESSION_PREFIX)
    );
  }

  /** Spec D1: `schedule:*` sessions divert to the scheduler's callback. */
  #isSyntheticScheduleSession(clientSessionId: string): boolean {
    return clientSessionId.startsWith(SYNTHETIC_SESSION_PREFIX);
  }

  /** Spec D3: `queue:*` sessions divert to the queue controller's callback. */
  #isSyntheticQueueSession(clientSessionId: string): boolean {
    return clientSessionId.startsWith(QUEUE_SESSION_PREFIX);
  }

  #isToolRelatedEvent(
    event: AgentOutputEvent,
  ): event is Extract<
    AgentOutputEvent,
    {
      type:
        | "assistant.tool.running"
        | "assistant.tool.update"
        | "assistant.tool.done"
        | "assistant.tool.error"
        | "session.compacting";
    }
  > {
    return (
      event.type === "assistant.tool.running" ||
      event.type === "assistant.tool.update" ||
      event.type === "assistant.tool.done" ||
      event.type === "assistant.tool.error" ||
      event.type === "session.compacting"
    );
  }

  #touchRuntime(runtime: AgentRuntime): void {
    runtime.lastActiveAt = Date.now();
    this.#scheduleIdleRelease(runtime);
  }

  #scheduleIdleRelease(runtime: AgentRuntime): void {
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
    }
    if (this.#agentIdleTimeoutMs <= 0) {
      runtime.idleTimer = null;
      return;
    }

    runtime.idleTimer = setTimeout(() => {
      void this.#releaseIdleRuntime(runtime.agentSessionId);
    }, this.#agentIdleTimeoutMs);
    runtime.idleTimer.unref?.();
  }

  async #releaseIdleRuntime(agentSessionId: string): Promise<void> {
    const runtime = this.#agentRuntimes.get(agentSessionId);
    if (!runtime) {
      return;
    }

    const idleForMs = Date.now() - runtime.lastActiveAt;
    if (idleForMs < this.#agentIdleTimeoutMs) {
      this.#scheduleIdleRelease(runtime);
      return;
    }

    try {
      await this.#stopRuntime(runtime);
    } catch (error) {
      // The runtime was still removed and its state handle revoked; only the
      // stop error surfaces here and must not become an unhandled rejection.
      this.#logger.error(`failed to stop idle agent session ${agentSessionId}:`, error);
    }
    this.#logger.info(`released idle agent session ${agentSessionId}`);
  }

  /**
   * Stops the adapter, removes the runtime and revokes every live state handle
   * for the session. The persisted record and binding are left intact for
   * ordinary sessions, so they can be resumed later (idle release, bridge
   * stop). An ephemeral synthetic session (`schedule:*` / `queue:*`) has no
   * resume semantics: its
   * record is deleted with the runtime (SF-1 — a unique record per run would
   * otherwise grow the state file forever). The runtime is always removed
   * from
   * the map and the state handle always revoked, even when `abort()`
   * or `adapter.stop()` throws, so a stale adapter can never write its state
   * again; the original error still propagates to the caller.
   */
  async #stopRuntime(runtime: AgentRuntime): Promise<void> {
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = null;
    }

    try {
      // T1: abort unconditionally when the adapter exposes it — the adapter
      // internally no-ops when it has no active run to abort.
      if (runtime.agentAdapter.abort) {
        try {
          await runtime.agentAdapter.abort();
        } catch (error) {
          this.#logger.error(`abort failed for ${runtime.agentSessionId}:`, error);
        }
      }
      await runtime.agentAdapter.stop();
    } finally {
      this.#agentRuntimes.delete(runtime.agentSessionId);
      await this.#revokeSessionStateBestEffort(runtime.agentSessionId);
      if (this.#isSyntheticClientSession(runtime.clientSessionId)) {
        // SF-1: a schedule/queue run leaves no residue. The adapter has
        // stopped and can no longer write state (its only state writes happen
        // inside #prepareWorkingDirectory during start), so deleting the
        // record here cannot race a later write. Same deletion semantics as
        // #cleanupNewRuntime (registry revoke + transactional record delete).
        try {
          await this.#agentSessionStateRegistry.delete(runtime.agentSessionId);
        } catch (error) {
          this.#logger.error(
            `failed to delete synthetic agent session state ${runtime.agentSessionId}:`,
            error,
          );
        }
      }
    }
  }
}
