import type { AgentAdapter, AgentEgressEvent, AgentIngressEvent } from "../../types";
import { PiRpcClient } from "./pi-rpc-client";
import { toPiSessionId } from "./pi-session-id";

export class PiRpcAgentAdapter implements AgentAdapter {
  readonly #sessionId: string;
  readonly #piSessionId: string;
  readonly #cwd: string;
  readonly #sessionDir?: string;
  readonly #bin: string;
  readonly #extraArgs: string[];
  #client: PiRpcClient | null = null;
  #onOutput: ((event: AgentEgressEvent) => Promise<void> | void) | null = null;
  #busy = false;
  #lastActiveAt = Date.now();

  constructor({
    sessionId,
    cwd,
    sessionDir,
    bin,
    extraArgs,
  }: {
    sessionId: string;
    cwd?: string;
    sessionDir?: string;
    bin?: string;
    extraArgs?: string[];
  }) {
    this.#sessionId = sessionId;
    this.#piSessionId = toPiSessionId(sessionId);
    this.#cwd = cwd ?? process.cwd();
    this.#sessionDir = sessionDir;
    this.#bin = bin ?? "pi";
    this.#extraArgs = extraArgs ?? [];
  }

  async start(onOutput: (event: AgentEgressEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    this.#client = new PiRpcClient({
      bridgeSessionId: this.#sessionId,
      piSessionId: this.#piSessionId,
      cwd: this.#cwd,
      sessionDir: this.#sessionDir,
      bin: this.#bin,
      extraArgs: this.#extraArgs,
    });
    this.#client.onEvent((event) => {
      if (event.type === "extension_error") {
        console.error(`[pi-rpc] extension_error for ${this.#sessionId}:`, event);
      }
    });
    await this.#client.start();
    console.log(`[pi-rpc] session ${this.#sessionId} started (piSessionId=${this.#piSessionId})`);
  }

  async stop(): Promise<void> {
    await this.#client?.stop();
    this.#client = null;
    this.#onOutput = null;
    console.log(`[pi-rpc] session ${this.#sessionId} stopped`);
  }

  async input(event: AgentIngressEvent): Promise<void> {
    if (!this.#client || !this.#onOutput) {
      throw new Error("PiRpcAgentAdapter is not started");
    }

    this.#busy = true;
    this.#lastActiveAt = Date.now();
    try {
      await this.#client.prompt(event.text);
      await this.#client.waitForSettled();
      const text = await this.#client.getLastAssistantText();

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
}
