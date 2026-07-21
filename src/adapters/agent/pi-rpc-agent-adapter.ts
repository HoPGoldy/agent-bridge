import type { AgentAdapter, AgentEgressEvent, AgentIngressEvent } from "../../types";
import { PiRpcClient } from "./pi-rpc-client";
import { toPiSessionId } from "./pi-session-id";

export class PiRpcAgentAdapter implements AgentAdapter {
  readonly #cwd: string;
  readonly #sessionDir?: string;
  readonly #bin: string;
  readonly #extraArgs: string[];
  #client: PiRpcClient | null = null;
  #sessionId: string | null = null;
  #piSessionId: string | null = null;
  #onOutput: ((event: AgentEgressEvent) => Promise<void> | void) | null = null;
  #busy = false;
  #lastActiveAt = Date.now();

  constructor({
    cwd,
    sessionDir,
    bin,
    extraArgs,
  }: {
    cwd?: string;
    sessionDir?: string;
    bin?: string;
    extraArgs?: string[];
  }) {
    this.#cwd = cwd ?? process.cwd();
    this.#sessionDir = sessionDir;
    this.#bin = bin ?? "pi";
    this.#extraArgs = extraArgs ?? [];
  }

  async start(onOutput: (event: AgentEgressEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
  }

  async stop(): Promise<void> {
    await this.#client?.stop();
    this.#client = null;
    if (this.#sessionId) {
      console.log(`[pi-rpc] session ${this.#sessionId} stopped`);
    }
    this.#onOutput = null;
  }

  async input(event: AgentIngressEvent): Promise<void> {
    if (!this.#onOutput) {
      throw new Error("PiRpcAgentAdapter is not started");
    }

    this.#busy = true;
    this.#lastActiveAt = Date.now();
    try {
      const client = await this.#ensureClient(event.sessionId);
      await client.prompt(event.text);
      await client.waitForSettled();
      const text = await client.getLastAssistantText();

      await this.#onOutput({
        type: "assistant.message",
        sessionId: event.sessionId,
        text: text ?? "(pi returned no assistant text)",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#onOutput({
        type: "assistant.message",
        sessionId: event.sessionId,
        text: `[pi-rpc error] ${message}`,
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

  async #ensureClient(sessionId: string): Promise<PiRpcClient> {
    if (this.#client) {
      if (this.#sessionId !== sessionId) {
        throw new Error(`PiRpcAgentAdapter already bound to session ${this.#sessionId}`);
      }
      return this.#client;
    }

    this.#sessionId = sessionId;
    this.#piSessionId = toPiSessionId(sessionId);
    this.#client = new PiRpcClient({
      bridgeSessionId: sessionId,
      piSessionId: this.#piSessionId,
      cwd: this.#cwd,
      sessionDir: this.#sessionDir,
      bin: this.#bin,
      extraArgs: this.#extraArgs,
    });
    this.#client.onEvent((rpcEvent) => {
      if (rpcEvent.type === "extension_error") {
        console.error(`[pi-rpc] extension_error for ${sessionId}:`, rpcEvent);
      }
    });
    await this.#client.start();
    console.log(`[pi-rpc] session ${sessionId} started (piSessionId=${this.#piSessionId})`);
    return this.#client;
  }
}
