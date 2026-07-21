export class PiRpcAgentAdapter {
  #sessionId;
  #endpoint;
  #onOutput = null;
  #busy = false;
  #lastActiveAt = Date.now();

  constructor({ sessionId, endpoint }) {
    this.#sessionId = sessionId;
    this.#endpoint = endpoint;
  }

  async start(onOutput) {
    this.#onOutput = onOutput;
    console.log(`[pi-rpc] session ${this.#sessionId} started (endpoint=${this.#endpoint})`);
  }

  async stop() {
    console.log(`[pi-rpc] session ${this.#sessionId} stopped`);
    this.#onOutput = null;
  }

  async input(event) {
    this.#busy = true;
    this.#lastActiveAt = Date.now();
    try {
      // TODO: Replace with real Pi RPC call once protocol is defined.
      if (!this.#onOutput) {
        throw new Error('PiRpcAgentAdapter is not started');
      }
      await this.#onOutput({
        type: 'assistant.message',
        sessionId: event.sessionId,
        text: `[pi-rpc pending] Received: ${event.text}`,
      });
    } finally {
      this.#busy = false;
      this.#lastActiveAt = Date.now();
    }
  }

  async isBusy() {
    return this.#busy;
  }

  getLastActiveAt() {
    return this.#lastActiveAt;
  }
}
