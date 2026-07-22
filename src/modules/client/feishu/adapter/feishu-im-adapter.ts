import type { ClientEgressEvent, ClientIngressEvent, FeishuClientConfig, IMAdapter } from "../../../../types";
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
  #onOutput: ((event: ClientIngressEvent) => Promise<void> | void) | null = null;
  #client: FeishuClient | null = null;
  #egressQueue: ClientEgressEvent[] = [];
  #processing = false;
  #lastInboundMessageIdBySession = new Map<string, string>();

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

  async start(onOutput: (event: ClientIngressEvent) => Promise<void> | void): Promise<void> {
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

  async input(event: ClientEgressEvent): Promise<void> {
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
          const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
          const chunks = chunkText(event.text, MAX_TEXT_CHUNK);
          this.#logger.info(`sending reply (session=${event.clientSessionId})`);
          for (const [index, chunk] of chunks.entries()) {
            await this.#client.sendText(target.chatId, chunk, index === 0 ? replyToMessageId : undefined);
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
}
