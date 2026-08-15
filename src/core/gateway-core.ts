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
} from "../types";
import { createAgentSessionStateRegistry } from "../config/agent-session-state";
import { createInMemoryChannelStateStore } from "../config/channel-state";
import { getTranslatorForCommon, type Translator } from "../i18n";
import { createLogger, type Logger } from "./logger";

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
  /** Pure routing map: client session id -> agent session id. */
  readonly #clientToAgentSession = new Map<string, string>();
  readonly #agentRuntimes = new Map<string, AgentRuntime>();
  /**
   * Client-output handlers that have already entered and are still settling.
   * Used by stop() to wait for in-flight work (for example a `/new` whose
   * agent create is still pending) so no runtime leaks and no binding save is
   * enqueued after the drain. Each tracked promise never rejects.
   */
  readonly #inFlightHandlers = new Set<Promise<void>>();
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
  }: GatewayCoreOptions) {
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
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    const document = await this.#channelStateStore.load();
    for (const [clientSessionId, agentSessionId] of Object.entries(document.bindings)) {
      this.#clientToAgentSession.set(clientSessionId, agentSessionId);
    }

    await this.#imAdapter.start(async (event) => {
      // Reject new client output once stop has begun: the adapter may still
      // deliver events while it is shutting down, and those must not start
      // any new work after we have decided to stop.
      if (!this.#started) return;

      // The handled promise never rejects, so a failing handler can never
      // produce an unhandled rejection; the adapter still awaits it so per-
      // channel backpressure and ordering are preserved.
      const handled = this.#handleClientOutput(event).then(
        () => undefined,
        (error: unknown) => {
          this.#logger.error("failed to process client output event:", error);
        },
      );
      this.#inFlightHandlers.add(handled);
      try {
        await handled;
      } finally {
        this.#inFlightHandlers.delete(handled);
      }
    });
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

  async #handleClientOutput(event: ClientOutputEvent): Promise<void> {
    if (event.type === "command.session.new") {
      await this.#handleSessionNew(event.clientSessionId, event.workingDirectory, event.workingDirectorySource);
      return;
    }

    if (event.type === "command.session.compact") {
      await this.#handleSessionCompact(event.clientSessionId);
      return;
    }

    if (event.type === "command.session.stop") {
      await this.#handleSessionStop(event.clientSessionId);
      return;
    }

    if (event.type === "command.session.status") {
      await this.#handleSessionStatus(event.clientSessionId);
      return;
    }

    if (event.type === "command.session.model.list") {
      await this.#handleSessionModelList(event.clientSessionId);
      return;
    }

    if (event.type === "command.session.model.set") {
      await this.#handleSessionModelSet(event.clientSessionId, event.target);
      return;
    }

    await this.#handleUserMessage(event.clientSessionId, event.text);
  }

  async #handleUserMessage(clientSessionId: string, text: string): Promise<void> {
    const runtime = await this.#getOrCreateActiveRuntime(clientSessionId);
    this.#touchRuntime(runtime);
    await runtime.agentAdapter.input({
      type: "user.message",
      text,
    });
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

    if (await runtime.agentAdapter.isBusy()) {
      await this.#deliverClientInput({
        type: "error",
        clientSessionId,
        kind: "agent.model.busy",
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
  ): Promise<void> {
    // Transactional switch: create and start the new runtime (and its state
    // record) first so a failed creation never tears down the previous
    // session, its binding, or its runtime.
    let newRuntime: AgentRuntime;
    try {
      newRuntime = await this.#createRuntimeForClient(clientSessionId, {
        workingDirectory,
        workingDirectorySource,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger.error(`failed to create new agent session for ${clientSessionId}:`, error);
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("gateway.failedToStartNewSession", { detail }),
      });
      return;
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
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: this.#t("gateway.failedToStartNewSession", { detail }),
      });
      return;
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

    await this.#deliverClientInput({
      type: "assistant.message",
      clientSessionId,
      text: this.#t("gateway.startedNewSession", { workingDirectory }),
    });
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
    options?: { workingDirectory?: string; workingDirectorySource?: ClientWorkingDirectorySource },
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

    if (await runtime.agentAdapter.isBusy()) {
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
   * for the session. The persisted record and binding are left intact, so the
   * session can be resumed later (idle release, bridge stop). The runtime is
   * always removed from the map and the state handle always revoked, even when
   * `isBusy()`, `abort()` or `adapter.stop()` throws, so a stale adapter can
   * never write its state again; the original error still propagates to the
   * caller.
   */
  async #stopRuntime(runtime: AgentRuntime): Promise<void> {
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = null;
    }

    try {
      if (runtime.agentAdapter.abort && (await runtime.agentAdapter.isBusy())) {
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
    }
  }
}
