import type {
  AgentAdapter,
  AgentInputEvent,
  AgentOutputEvent,
  ClientEgressEvent,
  ClientIngressEvent,
  GatewayCoreOptions,
} from "../types";

interface AgentRuntime {
  agentSessionId: string;
  agentAdapter: AgentAdapter;
  queue: AgentInputEvent[];
  lastActiveAt: number;
}

function createQueue<T>(): T[] {
  return [];
}

export class GatewayCore {
  readonly #imAdapter: GatewayCoreOptions["imAdapter"];
  readonly #agentModule: GatewayCoreOptions["agentModule"];
  readonly #agentConfig: GatewayCoreOptions["agentConfig"];
  readonly #pollIntervalMs: number;
  readonly #maxQueueSize: number;
  readonly #agentIdleTimeoutMs: number;
  readonly #clientIngressQueues = new Map<string, ClientIngressEvent[]>();
  readonly #clientEgressQueue = createQueue<ClientEgressEvent>();
  readonly #clientToAgentSession = new Map<string, string>();
  readonly #agentToClientSession = new Map<string, string>();
  readonly #agentRuntimes = new Map<string, AgentRuntime>();
  #pollTimer: NodeJS.Timeout | null = null;
  #started = false;

  constructor({ imAdapter, agentModule, agentConfig, pollIntervalMs, maxQueueSize, agentIdleTimeoutMs }: GatewayCoreOptions) {
    this.#imAdapter = imAdapter;
    this.#agentModule = agentModule;
    this.#agentConfig = agentConfig;
    this.#pollIntervalMs = pollIntervalMs;
    this.#maxQueueSize = maxQueueSize;
    this.#agentIdleTimeoutMs = agentIdleTimeoutMs;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    await this.#imAdapter.start(async (event) => {
      this.#enqueueClientIngress(event);
    });

    this.#pollTimer = setInterval(() => {
      void this.#tick();
    }, this.#pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;

    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }

    for (const [agentSessionId, runtime] of this.#agentRuntimes) {
      await runtime.agentAdapter.stop();
      this.#agentRuntimes.delete(agentSessionId);
    }

    await this.#imAdapter.stop();
  }

  async #tick(): Promise<void> {
    await this.#flushClientIngress();
    await this.#flushAgentInputs();
    await this.#flushClientEgress();
    await this.#collectIdleAgents();
  }

  #enqueueClientIngress(event: ClientIngressEvent): void {
    if (event.type === "command.session.new") {
      this.#clientIngressQueues.set(event.clientSessionId, [event]);
      return;
    }

    const queue = this.#clientIngressQueues.get(event.clientSessionId) ?? createQueue<ClientIngressEvent>();
    if (queue.length >= this.#maxQueueSize) {
      throw new Error(`Client ingress queue overflow for session ${event.clientSessionId}`);
    }
    queue.push(event);
    this.#clientIngressQueues.set(event.clientSessionId, queue);
  }

  #enqueueClientEgress(event: ClientEgressEvent): void {
    if (this.#clientEgressQueue.length >= this.#maxQueueSize) {
      throw new Error("Client egress queue overflow");
    }
    this.#clientEgressQueue.push(event);
  }

  async #flushClientIngress(): Promise<void> {
    for (const [clientSessionId, queue] of this.#clientIngressQueues) {
      if (queue.length === 0) {
        this.#clientIngressQueues.delete(clientSessionId);
        continue;
      }

      while (queue.length > 0) {
        const event = queue.shift();
        if (!event) break;

        try {
          if (event.type === "command.session.new") {
            await this.#handleSessionNew(event.clientSessionId);
            queue.length = 0;
            break;
          }

          if (event.type === "command.session.compact") {
            await this.#handleSessionCompact(event.clientSessionId);
            continue;
          }

          await this.#handleUserMessage(event.clientSessionId, event.text);
        } catch (error) {
          console.error(`[core] failed to process client ingress for ${clientSessionId}:`, error);
        }
      }

      if (queue.length === 0) {
        this.#clientIngressQueues.delete(clientSessionId);
      }
    }
  }

  async #flushAgentInputs(): Promise<void> {
    for (const runtime of this.#agentRuntimes.values()) {
      if (runtime.queue.length === 0) continue;
      if (await runtime.agentAdapter.isBusy()) continue;

      const event = runtime.queue.shift();
      if (!event) continue;

      try {
        await runtime.agentAdapter.input(event);
      } catch (error) {
        console.error(`[core] failed to deliver agent input for ${runtime.agentSessionId}:`, error);
      }

      runtime.lastActiveAt = Date.now();
    }
  }

  async #flushClientEgress(): Promise<void> {
    if (this.#clientEgressQueue.length === 0) return;
    if (await this.#imAdapter.isBusy()) return;

    const event = this.#clientEgressQueue.shift();
    if (!event) return;

    try {
      await this.#imAdapter.input(event);
    } catch (error) {
      console.error("[core] failed to deliver client egress event:", error);
    }
  }

  async #handleUserMessage(clientSessionId: string, text: string): Promise<void> {
    const runtime = await this.#getOrCreateActiveRuntime(clientSessionId);
    this.#enqueueAgentInput(runtime, {
      type: "user.message",
      text,
    });
  }

  async #handleSessionCompact(clientSessionId: string): Promise<void> {
    const runtime = await this.#getActiveRuntime(clientSessionId);
    if (!runtime) {
      this.#enqueueClientEgress({
        type: "assistant.message",
        clientSessionId,
        text: "No active agent session to compact.",
      });
      return;
    }

    this.#enqueueAgentInput(runtime, {
      type: "command.session.compact",
    });
  }

  async #handleSessionNew(clientSessionId: string): Promise<void> {
    const previousAgentSessionId = this.#clientToAgentSession.get(clientSessionId);
    if (previousAgentSessionId) {
      const previousRuntime = this.#agentRuntimes.get(previousAgentSessionId);
      if (previousRuntime) {
        await this.#stopRuntime(previousRuntime);
      }
      this.#agentToClientSession.delete(previousAgentSessionId);
    }

    const runtime = await this.#createRuntimeForClient(clientSessionId);
    this.#bindClientToAgent(clientSessionId, runtime.agentSessionId);
    this.#enqueueClientEgress({
      type: "assistant.message",
      clientSessionId,
      text: "Started a new session.",
    });
  }

  #enqueueAgentInput(runtime: AgentRuntime, event: AgentInputEvent): void {
    if (runtime.queue.length >= this.#maxQueueSize) {
      throw new Error(`Agent input queue overflow for session ${runtime.agentSessionId}`);
    }
    runtime.queue.push(event);
    runtime.lastActiveAt = Date.now();
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
    this.#agentToClientSession.delete(agentSessionId);
    this.#bindClientToAgent(clientSessionId, runtime.agentSessionId);
    return runtime;
  }

  async #createRuntimeForClient(clientSessionId: string): Promise<AgentRuntime> {
    const { agentSessionId, agentAdapter } = await this.#agentModule.createAgentSession({
      config: this.#agentConfig,
    });
    return this.#startRuntime(clientSessionId, agentSessionId, agentAdapter);
  }

  async #startRuntime(clientSessionId: string, agentSessionId: string, agentAdapter: AgentAdapter): Promise<AgentRuntime> {
    await agentAdapter.start(async (event: AgentOutputEvent) => {
      this.#handleAgentOutput(event);
    });

    const runtime: AgentRuntime = {
      agentSessionId,
      agentAdapter,
      queue: createQueue<AgentInputEvent>(),
      lastActiveAt: Date.now(),
    };
    this.#agentRuntimes.set(agentSessionId, runtime);
    this.#agentToClientSession.set(agentSessionId, clientSessionId);
    return runtime;
  }

  #bindClientToAgent(clientSessionId: string, agentSessionId: string): void {
    const previousAgentSessionId = this.#clientToAgentSession.get(clientSessionId);
    if (previousAgentSessionId && previousAgentSessionId !== agentSessionId) {
      this.#agentToClientSession.delete(previousAgentSessionId);
    }
    this.#clientToAgentSession.set(clientSessionId, agentSessionId);
    this.#agentToClientSession.set(agentSessionId, clientSessionId);
  }

  #handleAgentOutput(event: AgentOutputEvent): void {
    const clientSessionId = this.#agentToClientSession.get(event.agentSessionId);
    if (!clientSessionId) {
      return;
    }

    const activeAgentSessionId = this.#clientToAgentSession.get(clientSessionId);
    if (activeAgentSessionId !== event.agentSessionId) {
      console.log(
        `[core] dropping late output from inactive agent session ${event.agentSessionId} for client ${clientSessionId}`,
      );
      return;
    }

    const runtime = this.#agentRuntimes.get(event.agentSessionId);
    if (runtime) {
      runtime.lastActiveAt = Date.now();
    }

    this.#enqueueClientEgress({
      type: "assistant.message",
      clientSessionId,
      text: event.text,
    });
  }

  async #collectIdleAgents(): Promise<void> {
    const now = Date.now();
    for (const runtime of this.#agentRuntimes.values()) {
      if (runtime.queue.length > 0) continue;
      if (await runtime.agentAdapter.isBusy()) continue;
      if (now - runtime.lastActiveAt < this.#agentIdleTimeoutMs) continue;

      await runtime.agentAdapter.stop();
      this.#agentRuntimes.delete(runtime.agentSessionId);
      console.log(`[core] released idle agent session ${runtime.agentSessionId}`);
    }
  }

  async #stopRuntime(runtime: AgentRuntime): Promise<void> {
    try {
      if (runtime.agentAdapter.abort && (await runtime.agentAdapter.isBusy())) {
        try {
          await runtime.agentAdapter.abort();
        } catch (error) {
          console.error(`[core] abort failed for ${runtime.agentSessionId}:`, error);
        }
      }
      await runtime.agentAdapter.stop();
    } finally {
      this.#agentRuntimes.delete(runtime.agentSessionId);
    }
  }
}
