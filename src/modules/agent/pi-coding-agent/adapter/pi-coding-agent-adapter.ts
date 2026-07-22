import type { AgentAdapter, AgentInputEvent, AgentOutputEvent, OutboundAttachment } from "../../../../types";
import { createLogger, type Logger } from "../../../../core/logger";
import { extractMediaMarkers } from "../media-marker";
import { PiRpcClient } from "./pi-rpc-client";
import { toPiSessionId } from "./pi-session-id";

export class PiCodingAgentAdapter implements AgentAdapter {
  readonly #agentSessionId: string;
  readonly #piSessionId: string;
  readonly #cwd: string;
  readonly #sessionDir?: string;
  readonly #bin: string;
  readonly #model?: string;
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
    model,
    extraArgs,
    logger,
  }: {
    agentSessionId: string;
    cwd?: string;
    sessionDir?: string;
    bin?: string;
    model?: string;
    extraArgs?: string[];
    logger?: Logger;
  }) {
    this.#agentSessionId = agentSessionId;
    this.#piSessionId = toPiSessionId(agentSessionId);
    this.#cwd = cwd ?? process.cwd();
    this.#sessionDir = sessionDir;
    this.#bin = bin ?? "pi";
    this.#model = model;
    this.#extraArgs = extraArgs ?? [];
    this.#logger = logger ?? createLogger("pi-coding-agent");
  }

  async start(onOutput: (event: AgentOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    this.#client = new PiRpcClient({
      agentSessionId: this.#agentSessionId,
      piSessionId: this.#piSessionId,
      cwd: this.#cwd,
      sessionDir: this.#sessionDir,
      bin: this.#bin,
      model: this.#model,
      extraArgs: this.#extraArgs,
      logger: this.#logger,
    });
    this.#client.onEvent((rpcEvent) => {
      void this.#handleRpcEvent(rpcEvent);
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
    this.#logger.info(`aborting agent turn (session=${this.#agentSessionId})`);
    await this.#client?.abort();
  }

  async input(event: AgentInputEvent): Promise<void> {
    if (!this.#client || !this.#onOutput) {
      throw new Error("PiCodingAgentAdapter is not started");
    }

    this.#inputQueue.push(event);
    this.#logger.debug(
      `input event queued (session=${this.#agentSessionId} type=${event.type} queueDepth=${this.#inputQueue.length})`,
    );
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
      throw new Error("PiCodingAgentAdapter is not started");
    }

    try {
      if (event.type === "user.message") {
        this.#logger.info(`sending prompt to agent (session=${this.#agentSessionId})`);
        const startedAt = Date.now();
        await this.#emitProgress({
          type: "assistant.thinking",
          agentSessionId: this.#agentSessionId,
          text: "Processing request",
        });
        await this.#client.prompt(event.text);
        await this.#client.waitForSettled();
        const rawText = await this.#client.getLastAssistantText();
        const { text, attachments } = extractMediaMarkers(rawText ?? "(pi returned no assistant text)");
        this.#logger.debug(
          `prompt settled (session=${this.#agentSessionId} durationMs=${Date.now() - startedAt} replyLength=${text.length} attachments=${attachments.length})`,
        );
        await this.#emitAssistant(text, attachments);
        return;
      }

      this.#logger.info(`compacting context (session=${this.#agentSessionId})`);
      await this.#emitProgress({
        type: "session.compacting",
        agentSessionId: this.#agentSessionId,
        text: "Compacting context",
      });
      const result = await this.#client.compact();
      this.#logger.debug(
        `compact finished (session=${this.#agentSessionId} estimatedTokensAfter=${result.estimatedTokensAfter ?? "unknown"})`,
      );
      const suffix =
        typeof result.estimatedTokensAfter === "number"
          ? ` Estimated tokens after: ${result.estimatedTokensAfter}.`
          : "";
      await this.#emitAssistant(`Context compacted.${suffix}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.error(
        `event processing failed (session=${this.#agentSessionId} type=${event.type}):`,
        error,
      );
      await this.#emitAssistant(`[pi-coding-agent error] ${message}`);
    }
  }

  async #emitAssistant(text: string, attachments?: OutboundAttachment[]): Promise<void> {
    if (!this.#onOutput) {
      this.#logger.error(`dropped assistant output for stopped session ${this.#agentSessionId}`);
      return;
    }

    await this.#onOutput({
      type: "assistant.message",
      agentSessionId: this.#agentSessionId,
      text,
      attachments,
    });
  }

  async #emitProgress(event: Exclude<AgentOutputEvent, { type: "assistant.message" }>): Promise<void> {
    if (!this.#onOutput) {
      return;
    }
    await this.#onOutput(event);
  }

  async #handleRpcEvent(rpcEvent: { type: string; [key: string]: unknown }): Promise<void> {
    if (!this.#onOutput) {
      return;
    }

    if (rpcEvent.type === "tool_execution_start") {
      const toolName = typeof rpcEvent.toolName === "string" ? rpcEvent.toolName : "unknown";
      await this.#emitProgress({
        type: "assistant.tool.running",
        agentSessionId: this.#agentSessionId,
        toolName,
        text: `Running ${toolName}`,
      });
      return;
    }

    if (rpcEvent.type === "tool_execution_end") {
      const toolName = typeof rpcEvent.toolName === "string" ? rpcEvent.toolName : "unknown";
      const isError = Boolean(rpcEvent.isError);
      await this.#emitProgress({
        type: isError ? "assistant.tool.error" : "assistant.tool.done",
        agentSessionId: this.#agentSessionId,
        toolName,
        text: isError ? `Failed ${toolName}` : `Finished ${toolName}`,
      });
    }
  }
}
