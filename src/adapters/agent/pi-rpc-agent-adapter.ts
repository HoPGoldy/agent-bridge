import type { AgentAdapter, AgentInputEvent, AgentOutputEvent } from "../../types";
import { PiRpcClient } from "./pi-rpc-client";
import { toPiSessionId } from "./pi-session-id";

export class PiRpcAgentAdapter implements AgentAdapter {
  readonly #agentSessionId: string;
  readonly #piSessionId: string;
  readonly #cwd: string;
  readonly #sessionDir?: string;
  readonly #bin: string;
  readonly #extraArgs: string[];
  #client: PiRpcClient | null = null;
  #onOutput: ((event: AgentOutputEvent) => Promise<void> | void) | null = null;
  #busy = false;
  #lastActiveAt = Date.now();

  constructor({
    agentSessionId,
    cwd,
    sessionDir,
    bin,
    extraArgs,
  }: {
    agentSessionId: string;
    cwd?: string;
    sessionDir?: string;
    bin?: string;
    extraArgs?: string[];
  }) {
    this.#agentSessionId = agentSessionId;
    this.#piSessionId = toPiSessionId(agentSessionId);
    this.#cwd = cwd ?? process.cwd();
    this.#sessionDir = sessionDir;
    this.#bin = bin ?? "pi";
    this.#extraArgs = extraArgs ?? [];
  }

  async start(onOutput: (event: AgentOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    this.#client = new PiRpcClient({
      agentSessionId: this.#agentSessionId,
      piSessionId: this.#piSessionId,
      cwd: this.#cwd,
      sessionDir: this.#sessionDir,
      bin: this.#bin,
      extraArgs: this.#extraArgs,
    });
    this.#client.onEvent((rpcEvent) => {
      if (rpcEvent.type === "extension_error") {
        console.error(`[pi-rpc] extension_error for ${this.#agentSessionId}:`, rpcEvent);
      }
    });
    await this.#client.start();
    console.log(`[pi-rpc] session ${this.#agentSessionId} started (piSessionId=${this.#piSessionId})`);
  }

  async stop(): Promise<void> {
    await this.#client?.stop();
    this.#client = null;
    this.#onOutput = null;
    console.log(`[pi-rpc] session ${this.#agentSessionId} stopped`);
  }

  async abort(): Promise<void> {
    await this.#client?.abort();
  }

  async input(event: AgentInputEvent): Promise<void> {
    if (!this.#client || !this.#onOutput) {
      throw new Error("PiRpcAgentAdapter is not started");
    }

    this.#busy = true;
    this.#lastActiveAt = Date.now();
    try {
      if (event.type === "user.message") {
        await this.#client.prompt(event.text);
        await this.#client.waitForSettled();
        const text = await this.#client.getLastAssistantText();

        await this.#onOutput({
          type: "assistant.message",
          agentSessionId: this.#agentSessionId,
          text: text ?? "(pi returned no assistant text)",
        });
        return;
      }

      const result = await this.#client.compact();
      const suffix =
        typeof result.estimatedTokensAfter === "number"
          ? ` Estimated tokens after: ${result.estimatedTokensAfter}.`
          : "";
      await this.#onOutput({
        type: "assistant.message",
        agentSessionId: this.#agentSessionId,
        text: `Context compacted.${suffix}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#onOutput({
        type: "assistant.message",
        agentSessionId: this.#agentSessionId,
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
