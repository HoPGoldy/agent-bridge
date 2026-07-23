import type {
  AgentAdapter,
  AgentOutputEvent,
  ClientInputEvent,
  ClientOutputEvent,
  GatewayCoreOptions,
} from "../types";
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
  readonly #bindingStore: GatewayCoreOptions["bindingStore"];
  readonly #logger: Logger = createLogger("core");
  readonly #clientToAgentSession = new Map<string, string>();
  readonly #agentRuntimes = new Map<string, AgentRuntime>();
  #started = false;

  constructor({ imAdapter, agentModule, agentConfig, agentIdleTimeoutMs, bindingStore }: GatewayCoreOptions) {
    this.#imAdapter = imAdapter;
    this.#agentModule = agentModule;
    this.#agentConfig = agentConfig;
    this.#agentIdleTimeoutMs = agentIdleTimeoutMs;
    this.#bindingStore = bindingStore;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    if (this.#bindingStore) {
      const bindings = await this.#bindingStore.load();
      for (const [clientSessionId, agentSessionId] of Object.entries(bindings)) {
        this.#clientToAgentSession.set(clientSessionId, agentSessionId);
      }
    }

    await this.#imAdapter.start(async (event) => {
      try {
        await this.#handleClientOutput(event);
      } catch (error) {
        this.#logger.error("failed to process client output event:", error);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;

    for (const runtime of [...this.#agentRuntimes.values()]) {
      await this.#stopRuntime(runtime);
    }

    await this.#imAdapter.stop();
  }

  async #handleClientOutput(event: ClientOutputEvent): Promise<void> {
    if (event.type === "command.session.new") {
      await this.#handleSessionNew(event.clientSessionId);
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
        text: "No active agent session to compact.",
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
        text: "No active agent session to stop.",
      });
      return;
    }

    this.#touchRuntime(runtime);

    if (!runtime.agentAdapter.abort) {
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: "This agent session cannot be stopped right now.",
      });
      return;
    }

    if (!(await runtime.agentAdapter.isBusy())) {
      await this.#deliverClientInput({
        type: "assistant.message",
        clientSessionId,
        text: "No active agent run to stop.",
      });
      return;
    }

    await runtime.agentAdapter.abort();
  }

  async #handleSessionNew(clientSessionId: string): Promise<void> {
    const previousAgentSessionId = this.#clientToAgentSession.get(clientSessionId);
    if (previousAgentSessionId) {
      const previousRuntime = this.#agentRuntimes.get(previousAgentSessionId);
      if (previousRuntime) {
        await this.#stopRuntime(previousRuntime);
      }
    }

    const runtime = await this.#createRuntimeForClient(clientSessionId);
    this.#bindClientToAgent(clientSessionId, runtime.agentSessionId);
    await this.#deliverClientInput({
      type: "assistant.message",
      clientSessionId,
      text: "Started a new session.",
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
    this.#bindClientToAgent(clientSessionId, runtime.agentSessionId);
    return runtime;
  }

  async #getOrRestoreRuntime(clientSessionId: string, agentSessionId: string): Promise<AgentRuntime> {
    const existing = this.#agentRuntimes.get(agentSessionId);
    if (existing) {
      this.#touchRuntime(existing);
      return existing;
    }

    if (this.#agentModule.resumeAgentSession) {
      const agentAdapter = await this.#agentModule.resumeAgentSession({
        config: this.#agentConfig,
        agentSessionId,
      });
      return this.#startRuntime(clientSessionId, agentSessionId, agentAdapter);
    }

    const runtime = await this.#createRuntimeForClient(clientSessionId);
    this.#bindClientToAgent(clientSessionId, runtime.agentSessionId);
    return runtime;
  }

  async #createRuntimeForClient(clientSessionId: string): Promise<AgentRuntime> {
    const { agentSessionId, agentAdapter } = await this.#agentModule.createAgentSession({
      config: this.#agentConfig,
    });
    return this.#startRuntime(clientSessionId, agentSessionId, agentAdapter);
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

  #bindClientToAgent(clientSessionId: string, agentSessionId: string): void {
    this.#clientToAgentSession.set(clientSessionId, agentSessionId);
    void this.#persistBindings();
  }

  async #persistBindings(): Promise<void> {
    if (!this.#bindingStore) {
      return;
    }
    try {
      await this.#bindingStore.save(Object.fromEntries(this.#clientToAgentSession));
    } catch (error) {
      this.#logger.error("failed to persist session bindings:", error);
    }
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
