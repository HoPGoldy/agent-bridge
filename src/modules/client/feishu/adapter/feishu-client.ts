import * as Lark from "@larksuiteoapi/node-sdk";
import { createLogger, type Logger } from "../../../../core/logger";
import type { FeishuClientConfig, FeishuInboundMessage } from "../../../../types";

const DEDUP_TTL_MS = 12 * 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 5000;
const MESSAGE_EXPIRY_MS = 30 * 60 * 1000;
const DEDUP_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

type FeishuMention = {
  key?: string;
  name?: string;
};

type FeishuMessagePayload = {
  sender?: {
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    create_time?: string;
    chat_id?: string;
    chat_type?: "p2p" | "group";
    message_type?: string;
    content?: string;
    mentions?: FeishuMention[];
  };
};

function now(): number {
  return Date.now();
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function replaceMentionKeys(text: string, mentions: FeishuMention[] = []): string {
  let result = text;
  for (const mention of mentions) {
    if (!mention.key) continue;
    const display = mention.name ? `@${mention.name}` : "";
    result = result.replaceAll(mention.key, display);
  }
  return result.trim();
}

function parseTextContent(rawContent: string, messageType: string, mentions: FeishuMention[] = []): string {
  const parsed = parseJson(rawContent) as
    | string
    | {
        text?: string;
        zh_cn?: { title?: string; content?: Array<Array<{ tag?: string; text?: string }>> };
        en_us?: { title?: string; content?: Array<Array<{ tag?: string; text?: string }>> };
        ja_jp?: { title?: string; content?: Array<Array<{ tag?: string; text?: string }>> };
      };

  switch (messageType) {
    case "text": {
      const text = typeof parsed === "string" ? parsed : (parsed?.text ?? "");
      return replaceMentionKeys(text, mentions);
    }

    case "post": {
      const locale =
        typeof parsed === "object" && parsed !== null
          ? (parsed.zh_cn ?? parsed.en_us ?? parsed.ja_jp)
          : undefined;
      const parts: string[] = [];
      if (locale?.title) parts.push(locale.title);
      if (Array.isArray(locale?.content)) {
        for (const row of locale.content) {
          for (const item of row) {
            if (["text", "a", "md"].includes(item.tag ?? "") && item.text) {
              parts.push(item.text);
            }
          }
        }
      }
      return parts.join("").trim();
    }

    default:
      return "";
  }
}

export class FeishuClient {
  readonly #config: FeishuClientConfig;
  readonly #logger: Logger;
  readonly #client: Lark.Client;
  #wsClient: Lark.WSClient | null = null;
  #onMessage: ((message: FeishuInboundMessage) => Promise<void> | void) | null = null;
  #dedup = new Map<string, number>();
  #dedupTimer: NodeJS.Timeout | null = null;

  constructor(config: FeishuClientConfig, logger: Logger = createLogger("feishu")) {
    this.#config = config;
    this.#logger = logger;
    const domain = config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;

    this.#client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain,
    });
  }

  setOnMessage(onMessage: (message: FeishuInboundMessage) => Promise<void> | void): void {
    this.#onMessage = onMessage;
  }

  async connect(): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({
      encryptKey: this.#config.encryptKey ?? "",
      verificationToken: this.#config.verificationToken ?? "",
    });

    dispatcher.register({
      "im.message.receive_v1": (data: unknown) => {
        void this.#handleMessage(data as FeishuMessagePayload);
      },
    });

    this.#startDedupSweep();

    const domain = this.#config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
    this.#wsClient = new Lark.WSClient({
      appId: this.#config.appId,
      appSecret: this.#config.appSecret,
      domain,
      loggerLevel: Lark.LoggerLevel.warn,
      autoReconnect: true,
      onReady: () => {
        this.#logger.info("websocket ready");
      },
      onError: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#logger.error("websocket error:", message);
      },
      onReconnecting: () => {
        this.#logger.info("websocket reconnecting");
      },
      onReconnected: () => {
        this.#logger.info("websocket reconnected");
      },
    });

    await this.#wsClient.start({ eventDispatcher: dispatcher });
  }

  async disconnect(): Promise<void> {
    if (this.#dedupTimer) {
      clearInterval(this.#dedupTimer);
      this.#dedupTimer = null;
    }

    if (this.#wsClient) {
      try {
        this.#wsClient.close({ force: true });
      } catch {
        // ignore close errors
      }
      this.#wsClient = null;
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const content = JSON.stringify({ text });
    await this.#client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content,
      },
    });
  }

  async #handleMessage(data: FeishuMessagePayload): Promise<void> {
    const message = data.message;
    const sender = data.sender;
    if (!message || !sender) return;

    if (sender.sender_type === "app" || sender.sender_type === "bot") {
      return;
    }

    if (message.create_time && this.#isExpired(message.create_time)) {
      return;
    }

    if (!this.#recordDedup(message.message_id)) {
      return;
    }

    if (
      !message.content ||
      !message.message_type ||
      !message.chat_id ||
      !message.chat_type ||
      !message.message_id
    ) {
      return;
    }

    const text = parseTextContent(message.content, message.message_type, message.mentions ?? []);
    if (!text) {
      return;
    }

    await this.#onMessage?.({
      chatId: message.chat_id,
      chatType: message.chat_type,
      messageId: message.message_id,
      text,
      raw: data,
    });
  }

  #recordDedup(messageId?: string): boolean {
    if (!messageId) return false;
    if (this.#dedup.has(messageId)) return false;
    this.#dedup.set(messageId, now());

    if (this.#dedup.size > DEDUP_MAX_ENTRIES) {
      const oldest = this.#dedup.keys().next().value;
      if (typeof oldest === "string") {
        this.#dedup.delete(oldest);
      }
    }

    return true;
  }

  #isExpired(createTime: string): boolean {
    const timestamp = Number.parseInt(String(createTime), 10);
    if (!Number.isFinite(timestamp)) return false;
    return now() - timestamp > MESSAGE_EXPIRY_MS;
  }

  #startDedupSweep(): void {
    if (this.#dedupTimer) return;
    this.#dedupTimer = setInterval(() => {
      const cutoff = now() - DEDUP_TTL_MS;
      for (const [messageId, timestamp] of this.#dedup) {
        if (timestamp < cutoff) {
          this.#dedup.delete(messageId);
        }
      }
    }, DEDUP_SWEEP_INTERVAL_MS);
  }
}
