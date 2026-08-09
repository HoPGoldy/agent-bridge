import type {
  AgentAdapter,
  AgentOutputEvent,
  ChannelCommonContext,
  ClientInputEvent,
  ClientOutputEvent,
  GatewayCoreOptions,
  SessionBinding,
} from "../types";
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
  readonly #bindingStore: GatewayCoreOptions["bindingStore"];
  readonly #common?: ChannelCommonContext;
  readonly #t: Translator;
  readonly #logger: Logger = createLogger("core");
  readonly #clientToAgentSession = new Map<string, SessionBinding>();
  readonly #agentRuntimes = new Map<string, AgentRuntime>();
  /**
   * Client-output handlers that have already entered and are still settling.
   * Used by stop() to wait for in-flight work (for example a `/new` whose
   * agent create is still pending) so no runtime leaks and no binding save is
   * enqueued after the drain. Each tracked promise never rejects.
   */
  readonly #inFlightHandlers = new Set<Promise<void>>();
  /** Tail of the serialized binding-save queue; never rejects. */
  #persistTail: Promise<void> = Promise.resolve();
  #started = false;

  constructor({ imAdapter, agentModule, agentConfig, agentIdleTimeoutMs, allowedWorkingDirectoryRoots, bindingStore, common }: GatewayCoreOptions) {
    this.#imAdapter = imAdapter;
    this.#agentModule = agentModule;
    this.#agentConfig = agentConfig;
    this.#agentIdleTimeoutMs = agentIdleTimeoutMs;
    this.#allowedWorkingDirectoryRoots = allowedWorkingDirectoryRoots;
    this.#bindingStore = bindingStore;
    this.#common = common;
    this.#t = getTranslatorForCommon(common);
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    if (this.#bindingStore) {
      const bindings = await this.#bindingStore.load();
      for (const [clientSessionId, binding] of Object.entries(bindings)) {
        this.#clientToAgentSession.set(clientSessionId, binding);
      }
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
      await this.#handleSessionNew(event.clientSessionId, event.workingDirectory);
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

  async #handleSessionNew(clientSessionId: string, workingDirectory?: string): Promise<void> {
    // Transactional switch: create and start the new runtime first so a failed
    // creation never tears down the previous session, its binding, or its runtime.
    let newRuntime: AgentRuntime;
    try {
      newRuntime = await this.#createRuntimeForClient(clientSessionId, workingDirectory);
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

    const previousBinding = this.#clientToAgentSession.get(clientSessionId);
    if (previousBinding) {
      const previousRuntime = this.#agentRuntimes.get(previousBinding.agentSessionId);
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

    // Wait for the binding save before confirming success so the new binding is
    // durable when the user reads the reply. The save never rejects; failures
    // are logged and the in-memory binding stays authoritative.
    await this.#bindClientToAgent(clientSessionId, {
      agentSessionId: newRuntime.agentSessionId,
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    });
    await this.#deliverClientInput({
      type: "assistant.message",
      clientSessionId,
      text: this.#t("gateway.startedNewSession"),
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
    const binding = this.#clientToAgentSession.get(clientSessionId);
    if (!binding) {
      return null;
    }
    return this.#getOrRestoreRuntime(clientSessionId, binding);
  }

  async #getOrCreateActiveRuntime(clientSessionId: string): Promise<AgentRuntime> {
    const existing = await this.#getActiveRuntime(clientSessionId);
    if (existing) {
      return existing;
    }

    const runtime = await this.#createRuntimeForClient(clientSessionId);
    void this.#bindClientToAgent(clientSessionId, { agentSessionId: runtime.agentSessionId });
    return runtime;
  }

  async #getOrRestoreRuntime(clientSessionId: string, binding: SessionBinding): Promise<AgentRuntime> {
    const existing = this.#agentRuntimes.get(binding.agentSessionId);
    if (existing) {
      this.#touchRuntime(existing);
      return existing;
    }

    if (this.#agentModule.resumeAgentSession) {
      try {
        const agentAdapter = await this.#agentModule.resumeAgentSession({
          config: this.#agentConfig,
          common: this.#common ?? { channelName: "", language: "en-US" },
          agentSessionId: binding.agentSessionId,
          ...(binding.workingDirectory !== undefined ? { workingDirectory: binding.workingDirectory } : {}),
          ...(this.#allowedWorkingDirectoryRoots !== undefined
            ? { allowedWorkingDirectoryRoots: this.#allowedWorkingDirectoryRoots }
            : {}),
        });
        try {
          return await this.#startRuntime(clientSessionId, binding.agentSessionId, agentAdapter);
        } catch (error) {
          // Mirror #createRuntimeForClient: a partially started resumed adapter
          // must be cleaned up best-effort and the persisted binding must stay
          // untouched so a later message can retry the restore.
          this.#logger.error(`resumed agent session ${binding.agentSessionId} failed to start, cleaning up:`, error);
          try {
            await agentAdapter.stop();
          } catch (stopError) {
            this.#logger.error(
              `failed to stop partially resumed agent adapter ${binding.agentSessionId}:`,
              stopError,
            );
          }
          throw error;
        }
      } catch (error) {
        // The user asked the agent for work and got silence: surface a
        // localized failure with the detail and a `/new` hint. The persisted
        // binding is intentionally kept so the session can be retried once the
        // configuration is fixed, and exactly one message is delivered for a
        // single failed resume.
        const detail = error instanceof Error ? error.message : String(error);
        this.#logger.error(
          `failed to resume agent session ${binding.agentSessionId} for client ${clientSessionId}:`,
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

    const runtime = await this.#createRuntimeForClient(clientSessionId, binding.workingDirectory);
    void this.#bindClientToAgent(clientSessionId, {
      agentSessionId: runtime.agentSessionId,
      ...(binding.workingDirectory !== undefined ? { workingDirectory: binding.workingDirectory } : {}),
    });
    return runtime;
  }

  async #createRuntimeForClient(clientSessionId: string, workingDirectory?: string): Promise<AgentRuntime> {
    const { agentSessionId, agentAdapter } = await this.#agentModule.createAgentSession({
      config: this.#agentConfig,
      common: this.#common ?? { channelName: "", language: "en-US" },
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
      ...(this.#allowedWorkingDirectoryRoots !== undefined
        ? { allowedWorkingDirectoryRoots: this.#allowedWorkingDirectoryRoots }
        : {}),
    });
    try {
      return await this.#startRuntime(clientSessionId, agentSessionId, agentAdapter);
    } catch (error) {
      this.#logger.error(`agent session ${agentSessionId} failed to start, cleaning up:`, error);
      try {
        await agentAdapter.stop();
      } catch (stopError) {
        this.#logger.error(`failed to stop partially created agent adapter ${agentSessionId}:`, stopError);
      }
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

  /**
   * Serializes binding-store writes: the snapshot is captured synchronously at
   * enqueue time and written strictly in order through a promise tail, so an
   * older snapshot can never overwrite a newer one and at most one save is in
   * flight at a time. The returned promise never rejects: failures are logged
   * and the queue stays alive for the next save. Await it when durability
   * matters (for example before replying success to `/new`).
   */
  #enqueuePersist(): Promise<void> {
    if (!this.#bindingStore) {
      return Promise.resolve();
    }
    const snapshot = Object.fromEntries(this.#clientToAgentSession);
    const save = this.#persistTail.then(() => this.#bindingStore!.save(snapshot));
    const handled = save.then(
      () => undefined,
      (error: unknown) => {
        this.#logger.error("failed to persist session bindings:", error);
      },
    );
    this.#persistTail = handled;
    return handled;
  }

  /** Resolves once every enqueued binding save has finished (drain on stop). */
  #drainPersist(): Promise<void> {
    return this.#persistTail;
  }

  #bindClientToAgent(clientSessionId: string, binding: SessionBinding): Promise<void> {
    this.#clientToAgentSession.set(clientSessionId, binding);
    return this.#enqueuePersist();
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
    const activeBinding = this.#clientToAgentSession.get(clientSessionId);
    if (activeBinding?.agentSessionId !== agentSessionId) {
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

    await this.#stopRuntime(runtime);
    this.#logger.info(`released idle agent session ${agentSessionId}`);
  }

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
    }
  }
}
