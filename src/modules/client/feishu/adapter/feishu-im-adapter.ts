import type { ChannelCommonContext, ClientInputEvent, ClientOutputEvent, FeishuClientConfig, IMAdapter } from "../../../../types";
import { formatSendFailureNotice, getTranslatorForCommon, type Translator } from "../../../../i18n";
import { createLogger, type Logger } from "../../../../core/logger";
import { ProgressRenderer } from "../../utils/progress-renderer";
import { parseSlashCommand } from "../../utils/slash-commands";
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
  readonly #t: Translator;
  #onOutput: ((event: ClientOutputEvent) => Promise<void> | void) | null = null;
  #client: FeishuClient | null = null;
  #egressQueue: ClientInputEvent[] = [];
  #processing = false;
  #lastInboundMessageIdBySession = new Map<string, string>();
  #progressStateBySession = new Map<
    string,
    {
      renderer: ProgressRenderer;
      messageId: string | null;
      creating: boolean;
    }
  >();

  static buildProgressCard(markdown: string): Record<string, unknown> {
    return {
      schema: "2.0",
      body: {
        elements: [
          {
            tag: "markdown",
            content: markdown,
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
    const text = formatSendFailureNotice(this.#t, message);

    try {
      await this.#client.sendText(chatId, text);
    } catch (notifyError) {
      this.#logger.error("failed to notify send failure:", notifyError);
    }
  }

  constructor(
    config: FeishuClientConfig,
    logger: Logger = createLogger("feishu"),
    common?: ChannelCommonContext,
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#t = getTranslatorForCommon(common);
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
      this.#resetProgressState(clientSessionId);
      await this.#client?.startTyping(chatId, messageId);
      const normalizedText = text.trim();

      const commandEvent = parseSlashCommand(normalizedText, clientSessionId);
      if (commandEvent) {
        this.#logger.info(`received command ${normalizedText} (session=${clientSessionId})`);
        await this.#onOutput(commandEvent);
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
      renderer: new ProgressRenderer({ t: this.#t }),
      messageId: null,
      creating: false,
    };
    this.#progressStateBySession.set(event.clientSessionId, state);

    if (!state.renderer.isProgressEvent(event)) {
      return;
    }
    state.renderer.takeProgressEvent(event);

    const card = FeishuIMAdapter.buildProgressCard(state.renderer.getCurrentProgress().markdown);
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

  #resetProgressState(clientSessionId: string): void {
    this.#progressStateBySession.set(clientSessionId, {
      renderer: new ProgressRenderer({ t: this.#t }),
      messageId: null,
      creating: false,
    });
  }
}
