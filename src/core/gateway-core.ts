import type { AgentAdapter, AgentEgressEvent, AgentFactory, AgentIngressEvent, GatewayCoreOptions } from "../types";

type AgentEntry = {
  adapter: AgentAdapter;
  lastActiveAt: number;
};

function createQueue<T>(): T[] {
  return [];
}

export class GatewayCore {
  readonly #imAdapter: GatewayCoreOptions["imAdapter"];
  readonly #agentFactory: AgentFactory;
  readonly #pollIntervalMs: number;
  readonly #maxQueueSize: number;
  readonly #agentIdleTimeoutMs: number;
  readonly #ingressQueues = new Map<string, AgentIngressEvent[]>();
  readonly #egressQueue = createQueue<AgentEgressEvent>();
  readonly #agentEntries = new Map<string, AgentEntry>();
  #pollTimer: NodeJS.Timeout | null = null;
  #started = false;

  constructor({ imAdapter, agentFactory, pollIntervalMs, maxQueueSize, agentIdleTimeoutMs }: GatewayCoreOptions) {
    this.#imAdapter = imAdapter;
    this.#agentFactory = agentFactory;
    this.#pollIntervalMs = pollIntervalMs;
    this.#maxQueueSize = maxQueueSize;
    this.#agentIdleTimeoutMs = agentIdleTimeoutMs;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;

    await this.#imAdapter.start(async (event) => {
      this.#enqueueIngress(event);
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

    for (const [sessionId, entry] of this.#agentEntries) {
      await entry.adapter.stop();
      this.#agentEntries.delete(sessionId);
    }

    await this.#imAdapter.stop();
  }

  async #tick(): Promise<void> {
    await this.#flushIngress();
    await this.#flushEgress();
    await this.#collectIdleAgents();
  }

  #enqueueIngress(event: AgentIngressEvent): void {
    const queue = this.#ingressQueues.get(event.sessionId) ?? createQueue<AgentIngressEvent>();
    if (queue.length >= this.#maxQueueSize) {
      throw new Error(`Ingress queue overflow for session ${event.sessionId}`);
    }
    queue.push(event);
    this.#ingressQueues.set(event.sessionId, queue);
  }

  #enqueueEgress(event: AgentEgressEvent): void {
    if (this.#egressQueue.length >= this.#maxQueueSize) {
      throw new Error("Egress queue overflow");
    }
    this.#egressQueue.push(event);
  }

  async #flushIngress(): Promise<void> {
    for (const [sessionId, queue] of this.#ingressQueues) {
      if (queue.length === 0) {
        this.#ingressQueues.delete(sessionId);
        continue;
      }

      const entry = await this.#getOrCreateAgent(sessionId);
      if (await entry.adapter.isBusy()) {
        continue;
      }

      const event = queue.shift();
      if (!event) continue;

      try {
        await entry.adapter.input(event);
      } catch (error) {
        console.error(`[core] failed to deliver ingress event for ${sessionId}:`, error);
      }

      entry.lastActiveAt = Date.now();
      if (queue.length === 0) {
        this.#ingressQueues.delete(sessionId);
      }
    }
  }

  async #flushEgress(): Promise<void> {
    if (this.#egressQueue.length === 0) return;
    if (await this.#imAdapter.isBusy()) return;

    const event = this.#egressQueue.shift();
    if (!event) return;

    try {
      await this.#imAdapter.input(event);
    } catch (error) {
      console.error("[core] failed to deliver egress event:", error);
    }
  }

  async #getOrCreateAgent(sessionId: string): Promise<AgentEntry> {
    const existing = this.#agentEntries.get(sessionId);
    if (existing) return existing;

    const adapter = await this.#agentFactory.create(sessionId, async (event) => {
      this.#enqueueEgress(event);
    });

    const entry: AgentEntry = {
      adapter,
      lastActiveAt: Date.now(),
    };
    this.#agentEntries.set(sessionId, entry);
    return entry;
  }

  async #collectIdleAgents(): Promise<void> {
    const now = Date.now();
    for (const [sessionId, entry] of this.#agentEntries) {
      const hasPendingIngress = (this.#ingressQueues.get(sessionId)?.length ?? 0) > 0;
      if (hasPendingIngress) continue;
      if (await entry.adapter.isBusy()) continue;
      if (now - entry.lastActiveAt < this.#agentIdleTimeoutMs) continue;

      await entry.adapter.stop();
      this.#agentEntries.delete(sessionId);
      console.log(`[core] released idle agent session ${sessionId}`);
    }
  }
}
