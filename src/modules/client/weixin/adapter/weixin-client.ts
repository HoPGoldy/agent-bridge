import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { Client as OpenILinkClient, extractText, TYPING, CANCEL_TYPING } from "@openilink/openilink-sdk-node";
import { createLogger, type Logger } from "../../../../core/logger";
import type { OutboundAttachment, WeixinClientConfig, WeixinInboundMessage } from "../../../../types";

const MEDIA_TEMP_DIR = join(tmpdir(), "agent-bridge-weixin-media");

type SDKMessage = Record<string, any>;

const STALE_SESSION_ERRCODE = -2;
const STALE_SESSION_ERRMSG = "unknown error";

export class WeixinStaleSessionError extends Error {
  constructor(message = "Weixin conversation context became stale; wait for the user to send a fresh message.") {
    super(message);
    this.name = "WeixinStaleSessionError";
  }
}

type SDKClientLike = {
  monitor(
    handler: (message: SDKMessage) => Promise<void> | void,
    options?: {
      initial_buf?: string;
      on_buf_update?: (buf: string) => void;
      on_error?: (error: Error) => void;
      should_continue?: () => boolean;
    },
  ): Promise<void>;
  push(to: string, text: string): Promise<string>;
  getContextToken(userId: string): string | undefined;
  getConfig(userId: string, contextToken: string): Promise<{ typing_ticket?: string }>;
  sendTyping(userId: string, typingTicket: string, status: number): Promise<void>;
  sendMediaFile(
    to: string,
    contextToken: string,
    data: Uint8Array | ArrayBuffer,
    fileName: string,
    caption?: string,
  ): Promise<void>;
  downloadMedia(media: unknown): Promise<Uint8Array>;
};

export class WeixinClient {
  readonly #config: WeixinClientConfig;
  readonly #logger: Logger;
  #onMessage: ((message: WeixinInboundMessage) => Promise<void> | void) | null = null;
  #client: SDKClientLike | null = null;
  #monitorTask: Promise<void> | null = null;
  #running = false;
  #syncBuf = "";

  constructor(config: WeixinClientConfig, logger: Logger = createLogger("weixin")) {
    this.#config = config;
    this.#logger = logger;
  }

  setOnMessage(onMessage: (message: WeixinInboundMessage) => Promise<void> | void): void {
    this.#onMessage = onMessage;
  }

  async connect(): Promise<void> {
    if (this.#client) {
      return;
    }

    this.#client = new OpenILinkClient(this.#config.token, {
      base_url: this.#config.baseUrl,
      cdn_base_url: this.#config.cdnBaseUrl,
    }) as SDKClientLike;
    this.#running = true;
    this.#monitorTask = this.#client
      .monitor(
        async (message) => {
          await this.#handleMessage(message);
        },
        {
          initial_buf: this.#syncBuf,
          on_buf_update: (buf) => {
            this.#syncBuf = buf;
          },
          on_error: (error) => {
            this.#logger.error("weixin monitor error:", error);
          },
          should_continue: () => this.#running,
        },
      )
      .catch((error) => {
        if (this.#running) {
          this.#logger.error("weixin monitor stopped unexpectedly:", error);
        }
      });
  }

  async disconnect(): Promise<void> {
    this.#running = false;
    try {
      await this.#monitorTask;
    } catch {
      // swallowed above
    }
    this.#monitorTask = null;
    this.#client = null;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.#client) {
      throw new Error("Weixin client is not connected");
    }
    try {
      await this.#client.push(chatId, text);
    } catch (error) {
      if (isStaleSessionError(error)) {
        throw new WeixinStaleSessionError();
      }
      throw error;
    }
  }

  async sendAttachment(chatId: string, attachment: OutboundAttachment): Promise<void> {
    if (!this.#client) {
      throw new Error("Weixin client is not connected");
    }
    const contextToken = this.#client.getContextToken(chatId);
    if (!contextToken) {
      throw new Error(`No context token for Weixin chat ${chatId}`);
    }

    const data = await fs.readFile(attachment.filePath);
    await this.#client.sendMediaFile(
      chatId,
      contextToken,
      data,
      attachment.fileName ?? basename(attachment.filePath),
      attachment.caption ?? "",
    );
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.#client) {
      return;
    }
    const contextToken = this.#client.getContextToken(chatId);
    if (!contextToken) {
      return;
    }
    const config = await this.#client.getConfig(chatId, contextToken);
    if (!config.typing_ticket) {
      return;
    }
    await this.#client.sendTyping(chatId, config.typing_ticket, TYPING);
  }

  async stopTyping(chatId: string): Promise<void> {
    if (!this.#client) {
      return;
    }
    const contextToken = this.#client.getContextToken(chatId);
    if (!contextToken) {
      return;
    }
    const config = await this.#client.getConfig(chatId, contextToken);
    if (!config.typing_ticket) {
      return;
    }
    await this.#client.sendTyping(chatId, config.typing_ticket, CANCEL_TYPING);
  }

  async #handleMessage(message: SDKMessage): Promise<void> {
    const chatType = this.#inferChatType(message);
    const chatId = this.#resolveChatId(message, chatType);
    const extractedText = extractText(message as never);
    const { text, mentionedBot } = this.#normalizeMention(extractedText, chatType);
    const attachmentHints = await this.#downloadAttachmentHints(message);
    const combinedText = [text, ...attachmentHints].filter((part) => part.trim().length > 0).join("\n").trim();

    if (!combinedText) {
      return;
    }

    await this.#onMessage?.({
      chatId,
      chatType,
      messageId: String(message.message_id ?? randomUUID()),
      text: combinedText,
      mentionedBot,
      raw: message,
    });
  }

  #inferChatType(message: SDKMessage): "dm" | "group" {
    const roomId = String(message.room_id ?? message.chat_room_id ?? "").trim();
    if (roomId) {
      return "group";
    }
    const fromUserId = String(message.from_user_id ?? "").trim();
    return fromUserId.endsWith("@chatroom") ? "group" : "dm";
  }

  #resolveChatId(message: SDKMessage, chatType: "dm" | "group"): string {
    if (chatType === "group") {
      return String(message.room_id ?? message.chat_room_id ?? message.from_user_id ?? "").trim();
    }
    return String(message.from_user_id ?? "").trim();
  }

  #normalizeMention(text: string, chatType: "dm" | "group"): { text: string; mentionedBot: boolean } {
    if (chatType !== "group") {
      return { text, mentionedBot: false };
    }
    const match = text.match(/^@(\S+)\s*(.*)$/s);
    if (!match) {
      return { text, mentionedBot: false };
    }
    return { text: match[2] ?? "", mentionedBot: true };
  }

  async #downloadAttachmentHints(message: SDKMessage): Promise<string[]> {
    if (!this.#client) {
      return [];
    }

    const hints: string[] = [];
    for (const item of Array.isArray(message.item_list) ? message.item_list : []) {
      const downloaded = await this.#downloadItem(item);
      if (downloaded) {
        hints.push(downloaded);
      }
    }
    return hints;
  }

  async #downloadItem(item: SDKMessage): Promise<string | null> {
    if (!this.#client || typeof item?.type !== "number") {
      return null;
    }

    try {
      switch (item.type) {
        case 2:
          return await this.#downloadMediaHint(item.image_item?.media, "image", ".jpg");
        case 3:
          return await this.#downloadMediaHint(item.voice_item?.media, "voice", ".silk");
        case 4:
          return await this.#downloadMediaHint(
            item.file_item?.media,
            "file",
            extname(String(item.file_item?.file_name ?? "")) || ".bin",
            String(item.file_item?.file_name ?? "").trim() || undefined,
          );
        case 5:
          return await this.#downloadMediaHint(item.video_item?.media, "video", ".mp4");
        default:
          return null;
      }
    } catch (error) {
      this.#logger.warn("failed to download Weixin attachment:", error);
      return null;
    }
  }

  async #downloadMediaHint(
    media: unknown,
    label: "image" | "file" | "video" | "voice",
    fallbackExt: string,
    preferredName?: string,
  ): Promise<string> {
    if (!this.#client || !media) {
      throw new Error("missing media payload");
    }

    const bytes = await this.#client.downloadMedia(media);
    await fs.mkdir(MEDIA_TEMP_DIR, { recursive: true });
    const safeName = (preferredName || `${Date.now()}-${randomUUID()}${fallbackExt}`).replace(/[^a-zA-Z0-9._@-]/g, "_");
    const resolvedName = extname(safeName) ? safeName : `${safeName}${fallbackExt}`;
    const outputPath = join(MEDIA_TEMP_DIR, resolvedName);
    await fs.writeFile(outputPath, Buffer.from(bytes));
    return `[Received ${label}: ${outputPath}]`;
  }
}

function isStaleSessionError(error: unknown): boolean {
  const details = extractErrorDetails(error);
  if (details.errMsg.toLowerCase() === STALE_SESSION_ERRMSG) {
    return details.ret === STALE_SESSION_ERRCODE || details.errCode === STALE_SESSION_ERRCODE;
  }
  return false;
}

function extractErrorDetails(error: unknown): { ret?: number; errCode?: number; errMsg: string } {
  const candidate = error as { ret?: unknown; errCode?: unknown; errMsg?: unknown; message?: unknown } | undefined;
  const message = String(candidate?.message ?? "");
  const ret = typeof candidate?.ret === "number" ? candidate.ret : parseCodeFromText(message, /ret=(-?\d+)/i);
  const errCode = typeof candidate?.errCode === "number"
    ? candidate.errCode
    : parseCodeFromText(message, /errcode=(-?\d+)/i);
  const errMsg = typeof candidate?.errMsg === "string" ? candidate.errMsg : parseErrMsgFromText(message);
  return { ret, errCode, errMsg };
}

function parseCodeFromText(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseErrMsgFromText(text: string): string {
  const match = text.match(/errmsg=([^\n]+)$/i);
  return (match?.[1] ?? text).trim();
}
