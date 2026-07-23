import type {
  ChannelCommonContext,
  ClientInputEvent,
  ClientOutputEvent,
  IMAdapter,
  WecomClientConfig,
} from "../../../../types";
import { formatSendFailureNotice, getTranslatorForCommon, type Translator } from "../../../../i18n";
import { createLogger, type Logger } from "../../../../core/logger";
import { ProgressRenderer } from "../../utils/progress-renderer";
import { parseSlashCommand } from "../../utils/slash-commands";
import { WecomClient } from "./wecom-client";
import { buildWecomSessionId, parseWecomSessionId } from "./wecom-session";

const MAX_TEXT_CHUNK = 4000;

type ProgressState = {
  renderer: ProgressRenderer;
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
  readonly #t: Translator;
  #onOutput: ((event: ClientOutputEvent) => Promise<void> | void) | null = null;
  #client: WecomClient | null = null;
  #egressQueue: ClientInputEvent[] = [];
  #processing = false;
  #lastInboundMessageIdBySession = new Map<string, string>();
  #progressStateBySession = new Map<string, ProgressState>();

  async #notifySendFailure(chatId: string, error: unknown): Promise<void> {
    if (!this.#client) {
      return;
    }
    if (this.#client.isKicked()) {
      // The connection is gone for good; a failure notification cannot be
      // delivered either, so don't attempt one.
      this.#logger.debug("skipping send-failure notification, connection was replaced");
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
    config: WecomClientConfig,
    logger: Logger = createLogger("wecom"),
    common?: ChannelCommonContext,
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#t = getTranslatorForCommon(common);
  }

  async start(onOutput: (event: ClientOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    this.#client = new WecomClient(this.#config, this.#logger);
    this.#client.setOnKicked(() => {
      this.#logger.error(
        "this bot connection was replaced by a newer connection (another instance is running with the same bot credentials); " +
          "this instance will keep running but can no longer receive or send messages — stop the other instance and restart this process to recover",
      );
    });
    this.#client.setOnMessage(async ({ chatId, chatType, text, messageId, mentionedBot }) => {
      if (!this.#onOutput) {
        this.#logger.warn(`dropping inbound message, adapter not ready (chatId=${chatId})`);
        return;
      }

      this.#logger.info(
        `adapter received inbound message (chatType=${chatType} chatId=${chatId} messageId=${messageId} mentionedBot=${mentionedBot} textLength=${text.trim().length})`,
      );

      const clientSessionId = buildWecomSessionId(chatType, chatId);

      if (chatType === "group" && (this.#config.requireMentionInGroup ?? true) && !mentionedBot) {
        this.#logger.debug(
          `ignoring group message without bot mention (session=${clientSessionId} messageId=${messageId})`,
        );
        return;
      }

      const normalizedText = text.trim();
      const commandEvent = parseSlashCommand(normalizedText, clientSessionId);
      if (commandEvent) {
        await this.#onOutput(commandEvent);
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
    this.#logger.info(
      `adapter started (websocketUrl=${this.#config.websocketUrl ?? "wss://openws.work.weixin.qq.com"})`,
    );
  }

  async stop(): Promise<void> {
    this.#egressQueue.length = 0;
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

          if (event.type !== "assistant.message") {
            await this.#handleProgressEvent(target.chatId, event);
            continue;
          }

          const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
          await this.#finishProgressMessage(target.chatId, event.clientSessionId, replyToMessageId);
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

    await this.#client.sendStreamText(chatId, this.#t("client.processing"), {
      replyToMessageId: messageId,
      finish: false,
    });
    state.announced = true;
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
      announced: false,
    };
    this.#progressStateBySession.set(event.clientSessionId, state);

    if (!state.renderer.isProgressEvent(event)) {
      return;
    }
    state.renderer.takeProgressEvent(event);

    // Refresh the same stream message in place, like the feishu adapter
    // updates its progress card.
    const body = state.renderer.getCurrentProgress().markdown;
    const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
    await this.#client.sendStreamText(chatId, body, {
      replyToMessageId,
      finish: false,
    });
    state.announced = true;
  }

  async #finishProgressMessage(
    chatId: string,
    clientSessionId: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const state = this.#progressStateBySession.get(clientSessionId);
    if (!state || !state.announced || !this.#client) {
      return;
    }
    this.#progressStateBySession.delete(clientSessionId);

    const progress = state.renderer.getCurrentProgress();
    const body = progress.isEmpty ? this.#t("client.processing") : progress.markdown;
    try {
      await this.#client.sendStreamText(chatId, body, { replyToMessageId, finish: true });
    } catch (error) {
      // The stream may already have been auto-closed by the server (10 minute
      // limit); the final answer is sent as a separate message regardless.
      this.#logger.warn("failed to finish progress message:", error);
    }
  }

  #resetProgressState(clientSessionId: string): void {
    this.#progressStateBySession.set(clientSessionId, {
      renderer: new ProgressRenderer({ t: this.#t }),
      announced: false,
    });
  }
}
