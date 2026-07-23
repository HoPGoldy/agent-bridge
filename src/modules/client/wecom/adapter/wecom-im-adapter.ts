import type { ClientInputEvent, ClientOutputEvent, IMAdapter, WecomClientConfig } from "../../../../types";
import { createLogger, type Logger } from "../../../../core/logger";
import { WecomClient } from "./wecom-client";
import { buildWecomSessionId, parseWecomSessionId } from "./wecom-session";

const MAX_TEXT_CHUNK = 4000;
const PROGRESS_INTERVAL_MS = 60_000;
const STARTING_MESSAGE = "I’m starting now — I’ll share a progress update in about a minute.";

type ProgressFlushEvent = {
  type: "$progress.flush";
  clientSessionId: string;
};

type EgressEvent = ClientInputEvent | ProgressFlushEvent;

type ProgressState = {
  lines: string[];
  status: string;
  turnId: number;
  collapsedCount: number;
  dirty: boolean;
  interval: NodeJS.Timeout | null;
  announced: boolean;
};

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitPos = remaining.lastIndexOf("\n", maxLen);
    if (splitPos <= 0) {
      splitPos = remaining.lastIndexOf(" ", maxLen);
    }

    if (splitPos <= 0) {
      chunks.push(remaining.slice(0, maxLen));
      remaining = remaining.slice(maxLen);
      continue;
    }

    chunks.push(remaining.slice(0, splitPos + 1));
    remaining = remaining.slice(splitPos + 1);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

export class WecomIMAdapter implements IMAdapter {
  readonly #config: WecomClientConfig;
  readonly #logger: Logger;
  #onOutput: ((event: ClientOutputEvent) => Promise<void> | void) | null = null;
  #client: WecomClient | null = null;
  #egressQueue: EgressEvent[] = [];
  #processing = false;
  #lastInboundMessageIdBySession = new Map<string, string>();
  #progressStateBySession = new Map<string, ProgressState>();

  static progressBody(lines: string[], collapsedCount: number): string {
    const contentLines: string[] = [];
    if (collapsedCount > 0) {
      contentLines.push(`- Collapsed ${collapsedCount} earlier updates.`);
    }
    if (lines.length > 0) {
      contentLines.push(...lines);
    }
    return contentLines.length > 0 ? contentLines.join("\n") : "No progress yet.";
  }

  async #notifySendFailure(chatId: string, error: unknown): Promise<void> {
    if (!this.#client) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const text = `[agent-bridge error] Message delivery failed\n\n${message}`;

    try {
      await this.#client.sendText(chatId, text);
    } catch (notifyError) {
      this.#logger.error("failed to notify send failure:", notifyError);
    }
  }

  constructor(config: WecomClientConfig, logger: Logger = createLogger("wecom")) {
    this.#config = config;
    this.#logger = logger;
  }

  async start(onOutput: (event: ClientOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    this.#client = new WecomClient(this.#config, this.#logger);
    this.#client.setOnMessage(async ({ chatId, chatType, text, messageId, mentionedBot }) => {
      if (!this.#onOutput) {
        this.#logger.warn(`dropping inbound message, adapter not ready (chatId=${chatId})`);
        return;
      }

      const clientSessionId = buildWecomSessionId(chatType, chatId);

      if (chatType === "group" && (this.#config.requireMentionInGroup ?? true) && !mentionedBot) {
        this.#logger.debug(
          `ignoring group message without bot mention (session=${clientSessionId} messageId=${messageId})`,
        );
        return;
      }

      const normalizedText = text.trim();
      if (normalizedText === "/new") {
        await this.#onOutput({ type: "command.session.new", clientSessionId });
        return;
      }
      if (normalizedText === "/compact") {
        await this.#onOutput({ type: "command.session.compact", clientSessionId });
        return;
      }
      if (normalizedText === "/stop") {
        await this.#onOutput({ type: "command.session.stop", clientSessionId });
        return;
      }

      this.#lastInboundMessageIdBySession.set(clientSessionId, messageId);
      this.#resetProgressState(clientSessionId);
      await this.#announceStart(chatId, messageId, clientSessionId);

      await this.#onOutput({
        type: "user.message",
        clientSessionId,
        text,
      });
    });

    await this.#client.connect();
    this.#logger.info(`adapter started (websocketUrl=${this.#config.websocketUrl ?? "wss://openws.work.weixin.qq.com"})`);
  }

  async stop(): Promise<void> {
    this.#egressQueue.length = 0;
    for (const state of this.#progressStateBySession.values()) {
      if (state.interval) {
        clearInterval(state.interval);
      }
    }
    this.#progressStateBySession.clear();
    if (this.#client) {
      await this.#client.disconnect();
      this.#client = null;
    }
    this.#processing = false;
    this.#onOutput = null;
    this.#logger.info("adapter stopped");
  }

  async input(event: ClientInputEvent): Promise<void> {
    if (!this.#client) {
      throw new Error("WecomIMAdapter is not started");
    }

    this.#egressQueue.push(event);
    void this.#drainEgressQueue();
  }

  async isBusy(): Promise<boolean> {
    return this.#processing || this.#egressQueue.length > 0;
  }

  async #drainEgressQueue(): Promise<void> {
    if (this.#processing) {
      return;
    }

    this.#processing = true;
    try {
      while (this.#client && this.#egressQueue.length > 0) {
        const event = this.#egressQueue.shift();
        if (!event) continue;

        try {
          const target = parseWecomSessionId(event.clientSessionId);

          if (event.type === "$progress.flush") {
            await this.#flushProgressSummary(target.chatId, event.clientSessionId);
            continue;
          }

          if (event.type !== "assistant.message") {
            this.#recordProgressEvent(event);
            continue;
          }

          this.#stopProgressTimer(event.clientSessionId);
          const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
          if (event.text.trim().length > 0) {
            const chunks = chunkText(event.text, MAX_TEXT_CHUNK);
            for (const [index, chunk] of chunks.entries()) {
              await this.#client.sendText(target.chatId, chunk, index === 0 ? replyToMessageId : undefined);
            }
          }
          for (const attachment of event.attachments ?? []) {
            try {
              await this.#client.sendAttachment(target.chatId, attachment, replyToMessageId);
            } catch (attachmentError) {
              this.#logger.error("failed to send attachment:", attachmentError);
              await this.#notifySendFailure(target.chatId, attachmentError);
            }
          }
        } catch (error) {
          this.#logger.error("failed to send egress event:", error);
          try {
            const target = parseWecomSessionId(event.clientSessionId);
            await this.#notifySendFailure(target.chatId, error);
          } catch (notifyError) {
            this.#logger.error("failed to handle egress send failure:", notifyError);
          }
        }
      }
    } finally {
      this.#processing = false;
    }
  }

  async #announceStart(chatId: string, messageId: string, clientSessionId: string): Promise<void> {
    const state = this.#progressStateBySession.get(clientSessionId);
    if (!state || state.announced || !this.#client) {
      return;
    }

    await this.#client.sendText(chatId, STARTING_MESSAGE, messageId);
    state.announced = true;
  }

  #recordProgressEvent(event: Exclude<ClientInputEvent, { type: "assistant.message" }>): void {
    if (!this.#shouldRenderProgressEvent(event)) {
      return;
    }

    const state = this.#progressStateBySession.get(event.clientSessionId) ?? this.#createProgressState();
    state.lines.push(this.#formatProgressLine(event));
    if (state.lines.length > 10) {
      state.collapsedCount += state.lines.length - 10;
      state.lines.splice(0, state.lines.length - 10);
    }
    state.status = this.#progressStatus(event);
    state.dirty = true;
    this.#progressStateBySession.set(event.clientSessionId, state);
  }

  async #flushProgressSummary(chatId: string, clientSessionId: string): Promise<void> {
    const state = this.#progressStateBySession.get(clientSessionId);
    if (!state || !state.dirty || !this.#client) {
      return;
    }

    const body = WecomIMAdapter.progressBody(state.lines, state.collapsedCount);
    await this.#client.sendText(chatId, body);
    state.dirty = false;
  }

  #queueProgressFlush(clientSessionId: string): void {
    this.#egressQueue.push({ type: "$progress.flush", clientSessionId });
    void this.#drainEgressQueue();
  }

  #createProgressState(previous?: ProgressState): ProgressState {
    return {
      lines: [],
      status: "running",
      turnId: (previous?.turnId ?? 0) + 1,
      collapsedCount: 0,
      dirty: false,
      interval: null,
      announced: false,
    };
  }

  #resetProgressState(clientSessionId: string): void {
    const previous = this.#progressStateBySession.get(clientSessionId);
    if (previous?.interval) {
      clearInterval(previous.interval);
    }
    const state = this.#createProgressState(previous);
    state.interval = setInterval(() => {
      this.#queueProgressFlush(clientSessionId);
    }, PROGRESS_INTERVAL_MS);
    state.interval.unref?.();
    this.#progressStateBySession.set(clientSessionId, state);
  }

  #stopProgressTimer(clientSessionId: string): void {
    const state = this.#progressStateBySession.get(clientSessionId);
    if (!state) {
      return;
    }
    if (state.interval) {
      clearInterval(state.interval);
    }
    this.#progressStateBySession.delete(clientSessionId);
  }

  #shouldRenderProgressEvent(event: Exclude<ClientInputEvent, { type: "assistant.message" }>): boolean {
    return event.type !== "assistant.thinking";
  }

  #formatProgressLine(event: Exclude<ClientInputEvent, { type: "assistant.message" }>): string {
    switch (event.type) {
      case "assistant.thinking":
        return "";
      case "session.compacting":
        return `- Compacting session${event.text ? `: ${event.text}` : ""}`;
      case "assistant.tool.running":
        return `- Running ${event.toolName}`;
      case "assistant.tool.done":
        return `- Finished ${event.toolName}`;
      case "assistant.tool.error":
        return this.#formatToolErrorLine(event.toolName, event.text);
    }
  }

  #formatToolErrorLine(toolName: string, text?: string): string {
    const normalizedText = text?.trim();
    if (!normalizedText) {
      return `- ${this.#humanizeToolError(toolName)}`;
    }

    const lowerText = normalizedText.toLowerCase();
    const lowerToolName = toolName.toLowerCase();
    if (lowerText === lowerToolName || lowerText === `failed ${lowerToolName}`) {
      return `- ${this.#humanizeToolError(toolName)}`;
    }

    return `- ${this.#humanizeToolError(toolName)}: ${normalizedText}`;
  }

  #humanizeToolError(toolName: string): string {
    return `Failed ${toolName}`;
  }

  #progressStatus(event: Exclude<ClientInputEvent, { type: "assistant.message" }>): string {
    switch (event.type) {
      case "assistant.tool.error":
        return "error";
      case "assistant.tool.done":
        return "done";
      default:
        return "running";
    }
  }
}
