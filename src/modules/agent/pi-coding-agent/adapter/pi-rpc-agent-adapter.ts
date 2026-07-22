import type { AgentAdapter, AgentInputEvent, AgentOutputEvent } from "../../../../types";
import { createLogger, type Logger } from "../../../../core/logger";
import { PiRpcClient } from "./pi-rpc-client";
import { toPiSessionId } from "./pi-session-id";

export class PiRpcAgentAdapter implements AgentAdapter {
  readonly #agentSessionId: string;
  readonly #piSessionId: string;
  readonly #cwd: string;
  readonly #sessionDir?: string;
  readonly #bin: string;
  readonly #extraArgs: string[];
  readonly #logger: Logger;
  #client: PiRpcClient | null = null;
  #onOutput: ((event: AgentOutputEvent) => Promise<void> | void) | null = null;
  #inputQueue: AgentInputEvent[] = [];
  #processing = false;

  constructor({
    agentSessionId,
    cwd,
    sessionDir,
    bin,
    extraArgs,
    logger,
  }: {
    agentSessionId: string;
    cwd?: string;
    sessionDir?: string;
    bin?: string;
    extraArgs?: string[];
    logger?: Logger;
  }) {
    this.#agentSessionId = agentSessionId;
    this.#piSessionId = toPiSessionId(agentSessionId);
    this.#cwd = cwd ?? process.cwd();
    this.#sessionDir = sessionDir;
    this.#bin = bin ?? "pi";
    this.#extraArgs = extraArgs ?? [];
    this.#logger = logger ?? createLogger("pi-rpc");
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
      logger: this.#logger,
    });
    this.#client.onEvent((rpcEvent) => {
      if (rpcEvent.type === "extension_error") {
        this.#logger.error(`extension_error for ${this.#agentSessionId}:`, rpcEvent);
      }
    });
    this.#logger.info(`starting agent instance (bin=${this.#bin} cwd=${this.#cwd})`);
    await this.#client.start();
    this.#logger.info(`session ${this.#agentSessionId} started (piSessionId=${this.#piSessionId})`);
  }

  async stop(): Promise<void> {
    this.#inputQueue.length = 0;
    await this.#client?.stop();
    this.#client = null;
    this.#processing = false;
    this.#onOutput = null;
    this.#logger.info(`session ${this.#agentSessionId} stopped`);
  }

  async abort(): Promise<void> {
    await this.#client?.abort();
  }

  async input(event: AgentInputEvent): Promise<void> {
    if (!this.#client || !this.#onOutput) {
      throw new Error("PiRpcAgentAdapter is not started");
    }

    this.#inputQueue.push(event);
    void this.#drainInputQueue();
  }

  async isBusy(): Promise<boolean> {
    return this.#processing || this.#inputQueue.length > 0;
  }

  async #drainInputQueue(): Promise<void> {
    if (this.#processing) {
      return;
    }

    this.#processing = true;
    try {
      while (this.#client && this.#onOutput && this.#inputQueue.length > 0) {
        const event = this.#inputQueue.shift();
        if (!event) continue;
        await this.#processEvent(event);
      }
    } finally {
      this.#processing = false;
    }
  }

  async #processEvent(event: AgentInputEvent): Promise<void> {
    if (!this.#client) {
      throw new Error("PiRpcAgentAdapter is not started");
    }

    try {
      if (event.type === "user.message") {
        this.#logger.info(`sending prompt to agent (session=${this.#agentSessionId})`);
        await this.#client.prompt(event.text);
        await this.#client.waitForSettled();
        const text = await this.#client.getLastAssistantText();
        await this.#emitAssistant(text ?? "(pi returned no assistant text)");
        return;
      }

      this.#logger.info(`compacting context (session=${this.#agentSessionId})`);
      const result = await this.#client.compact();
      const suffix =
        typeof result.estimatedTokensAfter === "number"
          ? ` Estimated tokens after: ${result.estimatedTokensAfter}.`
          : "";
      await this.#emitAssistant(`Context compacted.${suffix}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emitAssistant(`[pi-rpc error] ${message}`);
    }
  }

  async #emitAssistant(text: string): Promise<void> {
    if (!this.#onOutput) {
      this.#logger.error(`dropped assistant output for stopped session ${this.#agentSessionId}`);
      return;
    }

    await this.#onOutput({
      type: "assistant.message",
      agentSessionId: this.#agentSessionId,
      text,
    });
  }
}
