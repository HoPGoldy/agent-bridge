import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { WSClient } from "@wecom/aibot-node-sdk";
import { createLogger, type Logger } from "../../../../core/logger";
import type { OutboundAttachment, WecomClientConfig, WecomInboundMessage } from "../../../../types";

const DEFAULT_WEBSOCKET_URL = "wss://openws.work.weixin.qq.com";
const MEDIA_TEMP_DIR = join(tmpdir(), "agent-bridge-wecom-media");
const IMAGE_SIGNATURE_PNG = Buffer.from("89504e470d0a1a0a", "hex");
const IMAGE_SIGNATURE_JPG = Buffer.from("ffd8ff", "hex");
// The WeCom docs designate body.msgid as the dedup key for inbound callbacks.
// Keep a bounded LRU of recently processed ids so redelivered callbacks
// (e.g. after a reconnect) are not handled twice.
const PROCESSED_MESSAGE_ID_LIMIT = 500;
const KICKED_ERROR_MESSAGE =
  "WeCom connection was closed by the server because a newer connection was established for the same bot; this instance will not reconnect";

type MediaRef = {
  kind: "image" | "file";
  url?: string;
  aeskey?: string;
  base64?: string;
  fileName?: string;
};

type SdkClientLike = {
  on(event: string, handler: (...args: any[]) => void): unknown;
  connect(): unknown;
  disconnect(): unknown;
  reply(
    frame: { req_id: string } | { headers: { req_id: string } },
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  replyStream(
    frame: { req_id: string } | { headers: { req_id: string } },
    streamId: string,
    content: string,
    finish?: boolean,
    msgItem?: Array<Record<string, unknown>>,
    feedback?: { id: string },
  ): Promise<unknown>;
  replyMedia(
    frame: { req_id: string } | { headers: { req_id: string } },
    mediaType: "image" | "file" | "voice" | "video",
    mediaId: string,
    videoOptions?: { title?: string; description?: string },
  ): Promise<unknown>;
  replyWelcome(
    frame: { req_id: string } | { headers: { req_id: string } },
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  sendMessage(chatId: string, payload: Record<string, unknown>): Promise<unknown>;
  uploadMedia(data: Buffer, options: { type: string; filename?: string }): Promise<{ media_id?: string }>;
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
};

type ReplyContext = {
  reqId: string;
  frame: { headers: { req_id: string } };
};

type StreamContext = {
  streamId: string;
  started: boolean;
};

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function detectImageExtension(data: Buffer): string {
  if (data.subarray(0, IMAGE_SIGNATURE_PNG.length).equals(IMAGE_SIGNATURE_PNG)) return ".png";
  if (data.subarray(0, IMAGE_SIGNATURE_JPG.length).equals(IMAGE_SIGNATURE_JPG)) return ".jpg";
  return ".jpg";
}

function decodeBase64(data: string): Buffer {
  const payload = data.split(",", 1).length > 1 ? data.split(",", 2)[1]! : data;
  return Buffer.from(payload.trim(), "base64");
}

function buildMarkdownBody(text: string): Record<string, unknown> {
  return {
    msgtype: "markdown",
    markdown: {
      content: text,
    },
  };
}

async function ensureMediaDir(): Promise<void> {
  if (!existsSync(MEDIA_TEMP_DIR)) {
    await mkdir(MEDIA_TEMP_DIR, { recursive: true });
  }
}

export class WecomClient {
  readonly #config: WecomClientConfig;
  readonly #logger: Logger;
  #onMessage: ((message: WecomInboundMessage) => Promise<void> | void) | null = null;
  #onKicked: (() => void) | null = null;
  #client: SdkClientLike | null = null;
  #kicked = false;
  #processedMessageIds = new Set<string>();
  #replyReqIdByMessageId = new Map<string, string>();
  #lastChatReqId = new Map<string, string>();
  #replyContextByMessageId = new Map<string, ReplyContext>();
  #lastReplyContextByChatId = new Map<string, ReplyContext>();
  #streamContextByMessageId = new Map<string, StreamContext>();
  #lastStreamContextByChatId = new Map<string, StreamContext>();

  constructor(config: WecomClientConfig, logger: Logger = createLogger("wecom")) {
    this.#config = config;
    this.#logger = logger;
  }

  setOnMessage(onMessage: (message: WecomInboundMessage) => Promise<void> | void): void {
    this.#onMessage = onMessage;
  }

  setOnKicked(onKicked: () => void): void {
    this.#onKicked = onKicked;
  }

  isKicked(): boolean {
    return this.#kicked;
  }

  async connect(): Promise<void> {
    const websocketUrl = this.#config.websocketUrl ?? DEFAULT_WEBSOCKET_URL;
    this.#kicked = false;
    const client = new WSClient({
      botId: this.#config.botId,
      secret: this.#config.secret,
      wsUrl: websocketUrl,
      logger: this.#logger,
    }) as unknown as SdkClientLike;
    this.#client = client;
    this.#registerInboundHandlers(client);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      const rejectOnce = (error: unknown, phase: "connect" | "subscribe") => {
        if (settled) {
          return;
        }
        settled = true;
        reject(this.#toConnectionError(error, websocketUrl, phase));
      };

      client.on("authenticated", resolveOnce);
      client.on("ready", resolveOnce);
      client.on("error", (error) => rejectOnce(error, "connect"));
      client.on("auth_error", (error) => rejectOnce(error, "subscribe"));
      client.on("close", () => {
        if (!settled) {
          rejectOnce(new Error("WeCom websocket closed before subscription completed"), "connect");
        }
      });

      try {
        client.connect();
      } catch (error) {
        rejectOnce(error, "connect");
      }
    });
  }

  #toConnectionError(error: unknown, websocketUrl: string, phase: "connect" | "subscribe"): Error {
    if (error instanceof Error) {
      return new Error(`WeCom websocket ${phase} failed (${websocketUrl}): ${error.message}`);
    }

    const event = error as { type?: unknown; message?: unknown; error?: unknown } | null;
    const details = [event?.message, event?.error]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("; ");
    const suffix = details ? `: ${details}` : "";
    return new Error(`WeCom websocket ${phase} failed (${websocketUrl})${suffix}`);
  }

  async disconnect(): Promise<void> {
    this.#client?.disconnect();
    this.#client = null;
  }

  #requireClient(): SdkClientLike {
    if (!this.#client) {
      throw new Error("WeCom websocket is not connected");
    }
    if (this.#kicked) {
      throw new Error(KICKED_ERROR_MESSAGE);
    }
    return this.#client;
  }

  async sendText(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    const client = this.#requireClient();

    const replyContext =
      this.#replyContextForMessage(replyToMessageId) ?? this.#lastReplyContextByChatId.get(chatId);
    if (replyContext) {
      this.#logger.debug(`reply context available for ${chatId}: ${replyContext.reqId}`);
      await client.reply(replyContext.frame, buildMarkdownBody(text));
      return;
    }

    await client.sendMessage(chatId, buildMarkdownBody(text));
  }

  async sendStreamText(
    chatId: string,
    text: string,
    options?: {
      replyToMessageId?: string;
      finish?: boolean;
      feedbackId?: string;
    },
  ): Promise<void> {
    const client = this.#requireClient();

    const replyToMessageId = options?.replyToMessageId;
    const replyContext =
      this.#replyContextForMessage(replyToMessageId) ?? this.#lastReplyContextByChatId.get(chatId);
    if (!replyContext) {
      await client.sendMessage(chatId, buildMarkdownBody(text));
      return;
    }

    const streamContext = this.#streamContextFor(chatId, replyToMessageId);
    const feedback = !streamContext.started && options?.feedbackId ? { id: options.feedbackId } : undefined;
    await client.replyStream(
      replyContext.frame,
      streamContext.streamId,
      text,
      options?.finish ?? false,
      undefined,
      feedback,
    );
    streamContext.started = true;
  }

  async sendAttachment(
    chatId: string,
    attachment: OutboundAttachment,
    replyToMessageId?: string,
  ): Promise<void> {
    const client = this.#requireClient();

    const upload = await this.#uploadMedia(attachment);
    const replyContext =
      this.#replyContextForMessage(replyToMessageId) ?? this.#lastReplyContextByChatId.get(chatId);
    if (replyContext) {
      this.#logger.debug(`reply media context available for ${chatId}: ${replyContext.reqId}`);
      await client.replyMedia(replyContext.frame, upload.type, upload.mediaId);
      return;
    }

    await client.sendMessage(chatId, {
      msgtype: upload.type,
      [upload.type]: { media_id: upload.mediaId },
    });
  }

  async #uploadMedia(attachment: OutboundAttachment): Promise<{ type: "image" | "file"; mediaId: string }> {
    if (!this.#client) {
      throw new Error("WeCom websocket is not connected");
    }

    const data = await readFile(attachment.filePath);
    const type = attachment.kind === "image" ? "image" : "file";
    const filename = sanitizeFileName(attachment.fileName ?? basename(attachment.filePath));
    const response = await this.#client.uploadMedia(data, { type, filename });
    const mediaId = String(response.media_id ?? "").trim();
    if (!mediaId) {
      throw new Error("media upload failed: missing media_id");
    }

    return { type, mediaId };
  }

  #replyReqIdForMessage(messageId?: string): string | undefined {
    if (!messageId) return undefined;
    return this.#replyReqIdByMessageId.get(messageId);
  }

  #replyContextForMessage(messageId?: string): ReplyContext | undefined {
    if (!messageId) return undefined;
    return this.#replyContextByMessageId.get(messageId);
  }

  #streamContextFor(chatId: string, messageId?: string): StreamContext {
    if (messageId) {
      const existing = this.#streamContextByMessageId.get(messageId);
      if (existing) {
        this.#lastStreamContextByChatId.set(chatId, existing);
        return existing;
      }
    }

    const fallback = this.#lastStreamContextByChatId.get(chatId);
    if (fallback) {
      return fallback;
    }

    const created = { streamId: randomUUID(), started: false };
    if (messageId) {
      this.#streamContextByMessageId.set(messageId, created);
    }
    this.#lastStreamContextByChatId.set(chatId, created);
    return created;
  }

  #registerInboundHandlers(client: SdkClientLike): void {
    client.on("event", (payload) => {
      this.#logger.info(
        `received SDK event event (reqId=${String(payload?.headers?.req_id ?? "") || "n/a"} eventType=${String(payload?.body?.event?.eventtype ?? "") || "n/a"})`,
      );
    });
    client.on("event.enter_chat", (payload) => {
      this.#logger.info(
        `received enter_chat event (reqId=${String(payload?.headers?.req_id ?? "") || "n/a"} userId=${String(payload?.body?.from?.userid ?? "") || "n/a"})`,
      );
      void this.#handleEnterChat(payload as Record<string, any>);
    });
    client.on("event.disconnected_event", (payload) => {
      // The server sends this when a newer connection for the same bot
      // replaces this one; the SDK will not auto-reconnect afterwards.
      this.#kicked = true;
      this.#logger.error(
        `connection replaced by a newer connection for the same bot (reqId=${String(payload?.headers?.req_id ?? "") || "n/a"}); this instance will no longer receive or send messages`,
      );
      this.#onKicked?.();
    });

    // The SDK emits both the generic "message" event and a type-specific
    // "message.<msgtype>" event for the same frame. Subscribe to the specific
    // events for known types, and use "message" only as a fallback for types
    // without a specific event (e.g. appmsg) to avoid double processing.
    const specificMsgTypes = new Set(["text", "image", "file", "voice", "video", "mixed"]);
    client.on("message", (payload) => {
      const msgtype = String(payload?.body?.msgtype ?? "").toLowerCase();
      if (specificMsgTypes.has(msgtype)) {
        return;
      }
      this.#logger.info(
        `received SDK event message (reqId=${String(payload?.headers?.req_id ?? "") || "n/a"} msgtype=${msgtype || "n/a"})`,
      );
      void this.#handleInboundCallback(
        payload as Record<string, any>,
        String(payload?.headers?.req_id ?? ""),
      );
    });

    for (const eventName of [
      "message.text",
      "message.image",
      "message.file",
      "message.voice",
      "message.video",
      "message.mixed",
    ]) {
      client.on(eventName, (payload) => {
        this.#logger.info(
          `received SDK event ${eventName} (reqId=${String(payload?.headers?.req_id ?? "") || "n/a"} msgtype=${String(payload?.body?.msgtype ?? "") || "n/a"})`,
        );
        void this.#handleInboundCallback(
          payload as Record<string, any>,
          String(payload?.headers?.req_id ?? ""),
        );
      });
    }
  }

  /**
   * Records a message id as processed. Returns false when the id was already
   * seen, so callers can drop duplicate callbacks. Bounded to the most recent
   * PROCESSED_MESSAGE_ID_LIMIT ids (insertion-ordered Set acts as the LRU).
   */
  #markMessageProcessed(messageId: string): boolean {
    if (this.#processedMessageIds.has(messageId)) {
      return false;
    }
    this.#processedMessageIds.add(messageId);
    if (this.#processedMessageIds.size > PROCESSED_MESSAGE_ID_LIMIT) {
      const oldest = this.#processedMessageIds.values().next().value;
      if (oldest !== undefined) {
        this.#processedMessageIds.delete(oldest);
      }
    }
    return true;
  }

  async #handleInboundCallback(payload: Record<string, any>, reqId: string): Promise<void> {
    const body = (payload.body ?? {}) as Record<string, any>;
    const senderId = String(body.from?.userid ?? "").trim();
    const chatId = String(body.chatid ?? senderId).trim();
    if (!chatId) {
      this.#logger.warn(`dropping inbound callback without chatId (reqId=${reqId || "n/a"})`);
      return;
    }

    const messageId = String(body.msgid ?? reqId ?? randomUUID()).trim();
    if (!this.#markMessageProcessed(messageId)) {
      this.#logger.info(
        `dropping duplicate inbound callback (messageId=${messageId} reqId=${reqId || "n/a"})`,
      );
      return;
    }

    this.#replyReqIdByMessageId.set(messageId, reqId);
    this.#lastChatReqId.set(chatId, reqId);
    const replyContext = { reqId, frame: { headers: { req_id: reqId } } };
    this.#replyContextByMessageId.set(messageId, replyContext);
    this.#lastReplyContextByChatId.set(chatId, replyContext);
    const streamContext = { streamId: randomUUID(), started: false };
    this.#streamContextByMessageId.set(messageId, streamContext);
    this.#lastStreamContextByChatId.set(chatId, streamContext);

    const textParts: string[] = [];
    const plainText = String(body.text?.content ?? "").trim();
    if (plainText) {
      textParts.push(plainText);
    }
    if (String(body.msgtype ?? "").toLowerCase() === "appmsg") {
      const title = String(body.appmsg?.title ?? "").trim();
      if (title) {
        textParts.push(title);
      }
    }
    if (String(body.msgtype ?? "").toLowerCase() === "mixed") {
      const items = Array.isArray(body.mixed?.msg_item) ? body.mixed.msg_item : [];
      for (const item of items) {
        if (String(item?.msgtype ?? "").toLowerCase() === "text") {
          const content = String(item?.text?.content ?? "").trim();
          if (content) textParts.push(content);
        }
      }
    }

    const refs = this.#extractMediaRefs(body);
    for (const ref of refs) {
      const localPath = await this.#downloadMediaRef(ref);
      if (localPath) {
        textParts.push(`[Received ${ref.kind}: ${localPath}]`);
      }
    }

    const chatType = String(body.chattype ?? "").toLowerCase() === "group" ? "group" : "dm";
    const rawText = textParts.join("\n").trim();
    const { text, mentionedBot } = this.#normalizeMention(rawText, chatType);

    this.#logger.info(
      `normalized inbound message (chatType=${chatType} chatId=${chatId} messageId=${messageId} textLength=${text.length})`,
    );

    await this.#onMessage?.({
      chatId,
      chatType,
      messageId,
      text,
      mentionedBot,
      raw: payload,
    });
  }

  async #handleEnterChat(payload: Record<string, any>): Promise<void> {
    if (!this.#client) {
      return;
    }

    const reqId = String(payload?.headers?.req_id ?? "").trim();
    if (!reqId) {
      return;
    }

    try {
      await this.#client.replyWelcome(
        { headers: { req_id: reqId } },
        {
          msgtype: "text",
          text: {
            content: "您好，我已连接成功，可以直接给我发消息。",
          },
        },
      );
      this.#logger.info(`sent enter_chat welcome reply (reqId=${reqId})`);
    } catch (error) {
      this.#logger.warn(`failed to send enter_chat welcome reply (reqId=${reqId}):`, error);
    }
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

  #extractMediaRefs(body: Record<string, any>): MediaRef[] {
    const refs: MediaRef[] = [];
    const msgType = String(body.msgtype ?? "").toLowerCase();

    if (msgType === "image" && body.image) {
      refs.push({
        kind: "image",
        url: typeof body.image.url === "string" ? body.image.url : undefined,
        aeskey: typeof body.image.aeskey === "string" ? body.image.aeskey : undefined,
        base64: typeof body.image.base64 === "string" ? body.image.base64 : undefined,
        fileName: typeof body.image.filename === "string" ? body.image.filename : undefined,
      });
    }

    if (msgType === "file" && body.file) {
      refs.push({
        kind: "file",
        url: typeof body.file.url === "string" ? body.file.url : undefined,
        aeskey: typeof body.file.aeskey === "string" ? body.file.aeskey : undefined,
        base64: typeof body.file.base64 === "string" ? body.file.base64 : undefined,
        fileName:
          typeof body.file.filename === "string"
            ? body.file.filename
            : typeof body.file.name === "string"
              ? body.file.name
              : undefined,
      });
    }

    if (msgType === "appmsg" && body.appmsg?.file) {
      refs.push({
        kind: "file",
        url: typeof body.appmsg.file.url === "string" ? body.appmsg.file.url : undefined,
        aeskey: typeof body.appmsg.file.aeskey === "string" ? body.appmsg.file.aeskey : undefined,
        base64: typeof body.appmsg.file.base64 === "string" ? body.appmsg.file.base64 : undefined,
        fileName:
          typeof body.appmsg.file.filename === "string"
            ? body.appmsg.file.filename
            : typeof body.appmsg.title === "string"
              ? body.appmsg.title
              : undefined,
      });
    }

    return refs;
  }

  async #downloadMediaRef(ref: MediaRef): Promise<string | null> {
    try {
      await ensureMediaDir();
      let bytes: Buffer;
      let fileName = ref.fileName;
      if (ref.base64) {
        bytes = decodeBase64(ref.base64);
      } else if (ref.url) {
        if (!this.#client) {
          throw new Error("WeCom websocket is not connected");
        }
        const downloaded = await this.#client.downloadFile(ref.url, ref.aeskey);
        bytes = downloaded.buffer;
        fileName = fileName ?? downloaded.filename;
      } else {
        return null;
      }

      const safeName = fileName
        ? sanitizeFileName(fileName)
        : ref.kind === "image"
          ? `${randomUUID()}${detectImageExtension(bytes)}`
          : `${randomUUID()}.bin`;
      const resolvedName = extname(safeName)
        ? safeName
        : ref.kind === "image"
          ? `${safeName}${detectImageExtension(bytes)}`
          : `${safeName}.bin`;
      const outputPath = join(MEDIA_TEMP_DIR, `${Date.now()}-${resolvedName}`);
      await writeFile(outputPath, bytes);
      return outputPath;
    } catch (error) {
      this.#logger.warn(`failed to download ${ref.kind} resource:`, error);
      return null;
    }
  }
}
