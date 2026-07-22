import * as Lark from "@larksuiteoapi/node-sdk";
import { createLogger, type Logger } from "../../../../core/logger";
import type { FeishuClientConfig, FeishuInboundMessage } from "../../../../types";

const DEDUP_TTL_MS = 12 * 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 5000;
const MESSAGE_EXPIRY_MS = 30 * 60 * 1000;
const DEDUP_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const REACTION_TYPING = "Typing";

type LarkClientLike = {
  im: {
    message: {
      create(args: unknown): Promise<{ data?: { message_id?: string | null } }>;
      reply(args: unknown): Promise<{ data?: { message_id?: string | null } }>;
      patch(args: unknown): Promise<unknown>;
    };
    messageReaction: {
      create(args: unknown): Promise<{ data?: { reaction_id?: string | null } }>;
      delete(args: unknown): Promise<unknown>;
    };
  };
};

type LarkChannelLike = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(
    to: string,
    input: { text: string },
    opts?: {
      replyTo?: string;
    },
  ): Promise<unknown>;
  on(name: "message", handler: (message: Lark.NormalizedMessage) => void | Promise<void>): () => void;
  on(
    name: "reject",
    handler: (event: { reason: string; messageId: string; chatId: string }) => void,
  ): () => void;
  on(name: "error", handler: (error: unknown) => void): () => void;
  on(name: "reconnecting" | "reconnected", handler: () => void): () => void;
};

function createChannel(config: FeishuClientConfig, logger: Logger): LarkChannelLike {
  const domain = config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;

  return Lark.createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    logger: {
      error: (...args: unknown[]) => logger.error(...args),
      warn: (...args: unknown[]) => logger.warn(...args),
      info: (...args: unknown[]) => logger.info(...args),
      debug: (...args: unknown[]) => logger.debug(...args),
      trace: (...args: unknown[]) => logger.debug(...args),
    },
    loggerLevel: Lark.LoggerLevel.warn,
    safety: {
      dedup: {
        ttl: DEDUP_TTL_MS,
        maxEntries: DEDUP_MAX_ENTRIES,
        sweepIntervalMs: DEDUP_SWEEP_INTERVAL_MS,
      },
      staleMessageWindowMs: MESSAGE_EXPIRY_MS,
    },
    policy: {
      requireMention: false,
    },
    webhook: {
      encryptKey: config.encryptKey,
      verificationToken: config.verificationToken,
    },
  });
}

function createClient(config: FeishuClientConfig): LarkClientLike {
  const domain = config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;

  return new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
  }) as LarkClientLike;
}

function buildMarkdownCard(text: string): string {
  return JSON.stringify({
    schema: "2.0",
    body: {
      elements: [
        {
          tag: "markdown",
          content: text,
        },
      ],
    },
  });
}

function buildCardPayload(card: Record<string, unknown>): string {
  return JSON.stringify(card);
}

export class FeishuClient {
  readonly #logger: Logger;
  readonly #channel: LarkChannelLike;
  readonly #client: LarkClientLike;
  #onMessage: ((message: FeishuInboundMessage) => Promise<void> | void) | null = null;
  #unsubscribe: Array<() => void> = [];
  #typingReactionByChatId = new Map<string, { messageId: string; reactionId: string }>();

  constructor(config: FeishuClientConfig, logger: Logger = createLogger("feishu")) {
    this.#logger = logger;
    this.#channel = createChannel(config, logger);
    this.#client = createClient(config);
  }

  setOnMessage(onMessage: (message: FeishuInboundMessage) => Promise<void> | void): void {
    this.#onMessage = onMessage;
  }

  async connect(): Promise<void> {
    this.#unsubscribe = [
      this.#channel.on("message", (message) => {
        void this.#handleMessage(message);
      }),
      this.#channel.on("reject", (event) => {
        this.#logger.debug(
          `channel rejected inbound message (reason=${event.reason} chatId=${event.chatId} messageId=${event.messageId})`,
        );
      }),
      this.#channel.on("error", (error) => {
        this.#logger.error("channel error:", error);
      }),
      this.#channel.on("reconnecting", () => {
        this.#logger.info("channel reconnecting");
      }),
      this.#channel.on("reconnected", () => {
        this.#logger.info("channel reconnected");
      }),
    ];

    this.#logger.info("starting channel connection");
    await this.#channel.connect();
    this.#logger.info("channel connected");
  }

  async disconnect(): Promise<void> {
    for (const unsubscribe of this.#unsubscribe.splice(0)) {
      try {
        unsubscribe();
      } catch (error) {
        this.#logger.debug("ignored channel unsubscribe error:", error);
      }
    }

    await this.#channel.disconnect();
  }

  async sendText(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    await this.sendMarkdown(chatId, text, replyToMessageId);
  }

  async sendMarkdown(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    const content = buildMarkdownCard(text);
    await this.#sendInteractive(chatId, content, replyToMessageId);

    this.#logger.debug(
      `markdown message sent (chatId=${chatId} replyTo=${replyToMessageId ?? "none"} length=${text.length})`,
    );
  }

  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    replyToMessageId?: string,
  ): Promise<string | null> {
    const content = buildCardPayload(card);
    const response = await this.#sendInteractive(chatId, content, replyToMessageId);
    return response.data?.message_id ?? null;
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.#client.im.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: buildCardPayload(card),
      },
    });
  }

  async #sendInteractive(
    chatId: string,
    content: string,
    replyToMessageId?: string,
  ): Promise<{ data?: { message_id?: string | null } }> {
    try {
      if (replyToMessageId) {
        return await this.#client.im.message.reply({
          path: {
            message_id: replyToMessageId,
          },
          data: {
            content,
            msg_type: "interactive",
          },
        });
      }

      return await this.#client.im.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          content,
          msg_type: "interactive",
        },
      });
    } catch (error: any) {
      if (replyToMessageId && (error?.code === 230011 || error?.code === 231003)) {
        this.#logger.warn(
          `reply target unavailable, falling back to create (chatId=${chatId} replyTo=${replyToMessageId})`,
        );
        return await this.#client.im.message.create({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: chatId,
            content,
            msg_type: "interactive",
          },
        });
      }
      throw error;
    }
  }

  async startTyping(chatId: string, messageId: string): Promise<void> {
    try {
      const response = await this.#client.im.messageReaction.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: REACTION_TYPING,
          },
        },
      });
      const reactionId = response.data?.reaction_id;
      if (reactionId) {
        this.#typingReactionByChatId.set(chatId, { messageId, reactionId });
      }
    } catch (error) {
      this.#logger.debug(`failed to add typing reaction (chatId=${chatId} messageId=${messageId})`, error);
    }
  }

  async stopTyping(chatId: string): Promise<void> {
    const entry = this.#typingReactionByChatId.get(chatId);
    if (!entry) {
      return;
    }

    this.#typingReactionByChatId.delete(chatId);

    try {
      await this.#client.im.messageReaction.delete({
        path: {
          message_id: entry.messageId,
          reaction_id: entry.reactionId,
        },
      });
    } catch (error) {
      this.#logger.debug(
        `failed to remove typing reaction (chatId=${chatId} messageId=${entry.messageId})`,
        error,
      );
    }
  }

  async #handleMessage(message: Lark.NormalizedMessage): Promise<void> {
    if (!message.content) {
      this.#logger.debug(`dropping message with no text content (messageId=${message.messageId})`);
      return;
    }

    await this.#onMessage?.({
      chatId: message.chatId,
      chatType: message.chatType,
      messageId: message.messageId,
      text: message.content,
      mentionedBot: message.mentionedBot,
      raw: message.raw,
    });
  }
}
