import type { AgentAdapter, AgentEgressEvent, AgentIngressEvent } from "../../types";

export class PiRpcAgentAdapter implements AgentAdapter {
  readonly #sessionId: string;
  readonly #endpoint: string;
  #onOutput: ((event: AgentEgressEvent) => Promise<void> | void) | null = null;
  #busy = false;
  #lastActiveAt = Date.now();

  constructor({ sessionId, endpoint }: { sessionId: string; endpoint: string }) {
    this.#sessionId = sessionId;
    this.#endpoint = endpoint;
  }

  async start(onOutput: (event: AgentEgressEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    console.log(`[pi-rpc] session ${this.#sessionId} started (endpoint=${this.#endpoint})`);
  }

  async stop(): Promise<void> {
    console.log(`[pi-rpc] session ${this.#sessionId} stopped`);
    this.#onOutput = null;
  }

  async input(event: AgentIngressEvent): Promise<void> {
    this.#busy = true;
    this.#lastActiveAt = Date.now();
    try {
      if (!this.#onOutput) {
        throw new Error("PiRpcAgentAdapter is not started");
      }

      await this.#onOutput({
        type: "assistant.message",
        sessionId: event.sessionId,
        text: `[pi-rpc pending] Received: ${event.text}`,
      });
    } finally {
      this.#busy = false;
      this.#lastActiveAt = Date.now();
    }
  }

  async isBusy(): Promise<boolean> {
    return this.#busy;
  }

  getLastActiveAt(): number {
    return this.#lastActiveAt;
  }
}
