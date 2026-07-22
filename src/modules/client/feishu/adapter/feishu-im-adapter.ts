import type { ClientInputEvent, ClientOutputEvent, FeishuClientConfig, IMAdapter } from "../../../../types";
import { createLogger, type Logger } from "../../../../core/logger";
import { FeishuClient } from "./feishu-client";
import { buildFeishuSessionId, parseFeishuSessionId } from "./feishu-session";

const MAX_TEXT_CHUNK = 4000;

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

export class FeishuIMAdapter implements IMAdapter {
  readonly #config: FeishuClientConfig;
  readonly #logger: Logger;
  #onOutput: ((event: ClientOutputEvent) => Promise<void> | void) | null = null;
  #client: FeishuClient | null = null;
  #egressQueue: ClientInputEvent[] = [];
  #processing = false;
  #lastInboundMessageIdBySession = new Map<string, string>();
  #progressStateBySession = new Map<
    string,
    {
      messageId: string | null;
      creating: boolean;
      lines: string[];
      status: string;
    }
  >();

  static buildProgressCard(lines: string[], status: string): Record<string, unknown> {
    return {
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: `Current progress · ${status}`,
        },
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: lines.length > 0 ? lines.join("\n") : "No progress yet.",
          },
        ],
      },
    };
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

  constructor(config: FeishuClientConfig, logger: Logger = createLogger("feishu")) {
    this.#config = config;
    this.#logger = logger;
  }

  async start(onOutput: (event: ClientOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    this.#client = new FeishuClient(this.#config, this.#logger);
    this.#client.setOnMessage(async ({ chatId, chatType, text, messageId, mentionedBot }) => {
      if (!this.#onOutput) {
        this.#logger.warn(`dropping inbound message, adapter not ready (chatId=${chatId})`);
        return;
      }

      const clientSessionId = buildFeishuSessionId(chatType, chatId);

      if (chatType === "group" && (this.#config.requireMentionInGroup ?? true) && !mentionedBot) {
        this.#logger.debug(
          `ignoring group message without bot mention (session=${clientSessionId} messageId=${messageId})`,
        );
        return;
      }

      this.#lastInboundMessageIdBySession.set(clientSessionId, messageId);
      await this.#client?.startTyping(chatId, messageId);
      const normalizedText = text.trim();

      if (normalizedText === "/new") {
        this.#logger.info(`received command /new (session=${clientSessionId})`);
        await this.#onOutput({
          type: "command.session.new",
          clientSessionId,
        });
        return;
      }

      if (normalizedText === "/compact") {
        this.#logger.info(`received command /compact (session=${clientSessionId})`);
        await this.#onOutput({
          type: "command.session.compact",
          clientSessionId,
        });
        return;
      }

      if (normalizedText === "/progress") {
        this.#logger.info(`received command /progress (session=${clientSessionId})`);
        await this.#sendProgressSnapshot(clientSessionId);
        return;
      }

      this.#logger.info(`received user message (session=${clientSessionId}): ${normalizedText}`);
      await this.#onOutput({
        type: "user.message",
        clientSessionId,
        text,
      });
    });

    await this.#client.connect();
    this.#logger.info(`adapter started (domain=${this.#config.domain ?? "feishu"})`);
  }

  async stop(): Promise<void> {
    this.#egressQueue.length = 0;
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
      throw new Error("FeishuIMAdapter is not started");
    }

    this.#egressQueue.push(event);
    this.#logger.debug(
      `egress event queued (session=${event.clientSessionId} queueDepth=${this.#egressQueue.length})`,
    );
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
          const target = parseFeishuSessionId(event.clientSessionId);

          if (event.type !== "assistant.message") {
            await this.#handleProgressEvent(target.chatId, event);
            continue;
          }

          const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
          this.#logger.info(`sending reply (session=${event.clientSessionId})`);
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
          await this.#client.stopTyping(target.chatId);
          this.#logger.debug(`reply sent (session=${event.clientSessionId})`);
        } catch (error) {
          this.#logger.error("failed to send egress event:", error);
          try {
            const target = parseFeishuSessionId(event.clientSessionId);
            await this.#client.stopTyping(target.chatId);
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

  async #handleProgressEvent(
    chatId: string,
    event: Exclude<ClientInputEvent, { type: "assistant.message" }>,
  ): Promise<void> {
    if (!this.#client) {
      return;
    }

    const state = this.#progressStateBySession.get(event.clientSessionId) ?? {
      messageId: null,
      creating: false,
      lines: [],
      status: "running",
    };
    state.lines.push(this.#formatProgressLine(event));
    if (state.lines.length > 10) {
      state.lines.splice(0, state.lines.length - 10);
    }
    state.status = this.#progressStatus(event);
    this.#progressStateBySession.set(event.clientSessionId, state);

    const card = FeishuIMAdapter.buildProgressCard(state.lines, state.status);
    if (state.messageId) {
      await this.#client.updateCard(state.messageId, card);
      return;
    }

    if (state.creating) {
      return;
    }

    state.creating = true;
    try {
      state.messageId = await this.#client.sendCard(
        chatId,
        card,
        this.#lastInboundMessageIdBySession.get(event.clientSessionId),
      );
    } finally {
      state.creating = false;
    }
  }

  async #sendProgressSnapshot(clientSessionId: string): Promise<void> {
    if (!this.#client) {
      return;
    }

    const state = this.#progressStateBySession.get(clientSessionId);
    const target = parseFeishuSessionId(clientSessionId);
    const text = state
      ? ["Current progress:", ...state.lines].join("\n")
      : "No active progress for this session.";
    await this.#client.sendText(
      target.chatId,
      text,
      this.#lastInboundMessageIdBySession.get(clientSessionId),
    );
  }

  #formatProgressLine(event: Exclude<ClientInputEvent, { type: "assistant.message" }>): string {
    switch (event.type) {
      case "assistant.thinking":
        return `- assistant.thinking${event.text ? `: ${event.text}` : ""}`;
      case "session.compacting":
        return `- session.compacting${event.text ? `: ${event.text}` : ""}`;
      case "assistant.tool.running":
        return `- assistant.tool.running: ${event.toolName}${event.text ? ` (${event.text})` : ""}`;
      case "assistant.tool.done":
        return `- assistant.tool.done: ${event.toolName}${event.text ? ` (${event.text})` : ""}`;
      case "assistant.tool.error":
        return `- assistant.tool.error: ${event.toolName}${event.text ? ` (${event.text})` : ""}`;
    }
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
