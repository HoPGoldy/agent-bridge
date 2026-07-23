import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger, type Logger } from "../../../../core/logger";
import type { OutboundAttachment, WecomClientConfig, WecomInboundMessage } from "../../../../types";

const DEFAULT_WEBSOCKET_URL = "wss://openws.work.weixin.qq.com";
const MEDIA_TEMP_DIR = join(tmpdir(), "agent-bridge-wecom-media");
const UPLOAD_CHUNK_SIZE = 512 * 1024;

const APP_CMD_SUBSCRIBE = "aibot_subscribe";
const APP_CMD_CALLBACK = "aibot_msg_callback";
const APP_CMD_LEGACY_CALLBACK = "aibot_callback";
const APP_CMD_SEND = "aibot_send_msg";
const APP_CMD_RESPONSE = "aibot_respond_msg";
const APP_CMD_UPLOAD_MEDIA_INIT = "aibot_upload_media_init";
const APP_CMD_UPLOAD_MEDIA_CHUNK = "aibot_upload_media_chunk";
const APP_CMD_UPLOAD_MEDIA_FINISH = "aibot_upload_media_finish";

const CALLBACK_COMMANDS = new Set([APP_CMD_CALLBACK, APP_CMD_LEGACY_CALLBACK]);
const IMAGE_SIGNATURE_PNG = Buffer.from("89504e470d0a1a0a", "hex");
const IMAGE_SIGNATURE_JPG = Buffer.from("ffd8ff", "hex");

type WebSocketLike = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  send(data: string): void;
  close(): void;
};

type MediaRef = {
  kind: "image" | "file";
  url?: string;
  base64?: string;
  fileName?: string;
};

type PendingResolver = {
  resolve: (payload: Record<string, any>) => void;
  reject: (error: unknown) => void;
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
  #ws: WebSocketLike | null = null;
  #pendingResponses = new Map<string, PendingResolver>();
  #replyReqIdByMessageId = new Map<string, string>();
  #lastChatReqId = new Map<string, string>();

  constructor(config: WecomClientConfig, logger: Logger = createLogger("wecom")) {
    this.#config = config;
    this.#logger = logger;
  }

  setOnMessage(onMessage: (message: WecomInboundMessage) => Promise<void> | void): void {
    this.#onMessage = onMessage;
  }

  async connect(): Promise<void> {
    const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    if (!WebSocketCtor) {
      throw new Error("WebSocket is not available in this runtime");
    }

    this.#ws = new WebSocketCtor(this.#config.websocketUrl ?? DEFAULT_WEBSOCKET_URL);
    const connectPromise = new Promise<void>((resolve, reject) => {
      if (!this.#ws) {
        reject(new Error("WeCom websocket not initialized"));
        return;
      }
      this.#ws.onopen = () => {
        void (async () => {
          try {
            const response = await this.#sendRequest(APP_CMD_SUBSCRIBE, {
              bot_id: this.#config.botId,
              secret: this.#config.secret,
              device_id: randomUUID().replace(/-/g, ""),
            });
            this.#raiseForError(response, "subscribe");
            resolve();
          } catch (error) {
            reject(error);
          }
        })();
      };
      this.#ws.onerror = (error) => reject(error);
      this.#ws.onclose = () => {
        this.#failPending(new Error("WeCom websocket closed"));
      };
      this.#ws.onmessage = (event) => {
        void this.#handleFrame(event.data);
      };
    });

    await connectPromise;
  }

  async disconnect(): Promise<void> {
    this.#failPending(new Error("WeCom client disconnected"));
    this.#ws?.close();
    this.#ws = null;
  }

  async sendText(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    const replyReqId = this.#replyReqIdForMessage(replyToMessageId) ?? this.#lastChatReqId.get(chatId);
    if (replyReqId) {
      try {
        const response = await this.#sendReplyRequest(replyReqId, buildMarkdownBody(text));
        this.#raiseForError(response, "send reply markdown");
        return;
      } catch (error) {
        this.#logger.warn(`reply send failed, falling back to proactive send (chatId=${chatId}):`, error);
      }
    }

    const response = await this.#sendRequest(APP_CMD_SEND, {
      chatid: chatId,
      ...buildMarkdownBody(text),
    });
    this.#raiseForError(response, "send markdown");
  }

  async sendAttachment(chatId: string, attachment: OutboundAttachment, replyToMessageId?: string): Promise<void> {
    const upload = await this.#uploadMedia(attachment);
    const replyReqId = this.#replyReqIdForMessage(replyToMessageId) ?? this.#lastChatReqId.get(chatId);

    if (replyReqId) {
      const response = await this.#sendReplyRequest(replyReqId, {
        msgtype: upload.type,
        [upload.type]: { media_id: upload.mediaId },
      });
      this.#raiseForError(response, "send reply media");
      return;
    }

    const response = await this.#sendRequest(APP_CMD_SEND, {
      chatid: chatId,
      msgtype: upload.type,
      [upload.type]: { media_id: upload.mediaId },
    });
    this.#raiseForError(response, "send media");
  }

  async #uploadMedia(attachment: OutboundAttachment): Promise<{ type: "image" | "file"; mediaId: string }> {
    const data = await readFile(attachment.filePath);
    const type = attachment.kind === "image" ? "image" : "file";
    const filename = sanitizeFileName(attachment.fileName ?? basename(attachment.filePath));
    const totalChunks = Math.ceil(data.length / UPLOAD_CHUNK_SIZE) || 1;

    const initResponse = await this.#sendRequest(APP_CMD_UPLOAD_MEDIA_INIT, {
      type,
      filename,
      total_size: data.length,
      total_chunks: totalChunks,
      md5: "",
    });
    this.#raiseForError(initResponse, "media upload init");
    const uploadId = String(initResponse.body?.upload_id ?? "").trim();
    if (!uploadId) {
      throw new Error("media upload init failed: missing upload_id");
    }

    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * UPLOAD_CHUNK_SIZE;
      const chunk = data.subarray(start, start + UPLOAD_CHUNK_SIZE);
      const chunkResponse = await this.#sendRequest(APP_CMD_UPLOAD_MEDIA_CHUNK, {
        upload_id: uploadId,
        chunk_index: index,
        base64_data: chunk.toString("base64"),
      });
      this.#raiseForError(chunkResponse, `media upload chunk ${index}`);
    }

    const finishResponse = await this.#sendRequest(APP_CMD_UPLOAD_MEDIA_FINISH, {
      upload_id: uploadId,
    });
    this.#raiseForError(finishResponse, "media upload finish");
    const mediaId = String(finishResponse.body?.media_id ?? "").trim();
    if (!mediaId) {
      throw new Error("media upload finish failed: missing media_id");
    }

    return { type, mediaId };
  }

  #replyReqIdForMessage(messageId?: string): string | undefined {
    if (!messageId) return undefined;
    return this.#replyReqIdByMessageId.get(messageId);
  }

  async #sendRequest(cmd: string, body: Record<string, unknown>): Promise<Record<string, any>> {
    const reqId = `${cmd}-${randomUUID()}`;
    return await this.#sendFrameAndWait(cmd, reqId, body);
  }

  async #sendReplyRequest(
    replyReqId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    return await this.#sendFrameAndWait(APP_CMD_RESPONSE, replyReqId, body);
  }

  async #sendFrameAndWait(
    cmd: string,
    reqId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    if (!this.#ws) {
      throw new Error("WeCom websocket is not connected");
    }

    const responsePromise = new Promise<Record<string, any>>((resolve, reject) => {
      this.#pendingResponses.set(reqId, { resolve, reject });
    });

    this.#ws.send(
      JSON.stringify({
        cmd,
        headers: { req_id: reqId },
        body,
      }),
    );

    try {
      return await responsePromise;
    } finally {
      this.#pendingResponses.delete(reqId);
    }
  }

  async #handleFrame(raw: string): Promise<void> {
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(raw) as Record<string, any>;
    } catch (error) {
      this.#logger.warn("failed to parse WeCom payload:", error);
      return;
    }

    const cmd = String(payload.cmd ?? "");
    const reqId = String(payload.headers?.req_id ?? "");

    if (reqId && this.#pendingResponses.has(reqId) && !CALLBACK_COMMANDS.has(cmd)) {
      this.#pendingResponses.get(reqId)?.resolve(payload);
      return;
    }

    if (!CALLBACK_COMMANDS.has(cmd)) {
      return;
    }

    await this.#handleInboundCallback(payload, reqId);
  }

  async #handleInboundCallback(payload: Record<string, any>, reqId: string): Promise<void> {
    const body = (payload.body ?? {}) as Record<string, any>;
    const senderId = String(body.from?.userid ?? "").trim();
    const chatId = String(body.chatid ?? senderId).trim();
    if (!chatId) {
      return;
    }

    const messageId = String(body.msgid ?? reqId ?? randomUUID()).trim();
    this.#replyReqIdByMessageId.set(messageId, reqId);
    this.#lastChatReqId.set(chatId, reqId);

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

    await this.#onMessage?.({
      chatId,
      chatType,
      messageId,
      text,
      mentionedBot,
      raw: payload,
    });
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
        base64: typeof body.image.base64 === "string" ? body.image.base64 : undefined,
        fileName: typeof body.image.filename === "string" ? body.image.filename : undefined,
      });
    }

    if (msgType === "file" && body.file) {
      refs.push({
        kind: "file",
        url: typeof body.file.url === "string" ? body.file.url : undefined,
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
      if (ref.base64) {
        bytes = decodeBase64(ref.base64);
      } else if (ref.url) {
        const response = await fetch(ref.url);
        if (!response.ok) {
          throw new Error(`download failed with status ${response.status}`);
        }
        bytes = Buffer.from(await response.arrayBuffer());
      } else {
        return null;
      }

      const fileName = ref.fileName
        ? sanitizeFileName(ref.fileName)
        : ref.kind === "image"
          ? `${randomUUID()}${detectImageExtension(bytes)}`
          : `${randomUUID()}.bin`;
      const resolvedName = extname(fileName)
        ? fileName
        : ref.kind === "image"
          ? `${fileName}${detectImageExtension(bytes)}`
          : `${fileName}.bin`;
      const outputPath = join(MEDIA_TEMP_DIR, `${Date.now()}-${resolvedName}`);
      await writeFile(outputPath, bytes);
      return outputPath;
    } catch (error) {
      this.#logger.warn(`failed to download ${ref.kind} resource:`, error);
      return null;
    }
  }

  #raiseForError(response: Record<string, any>, context: string): void {
    const errcode = response.errcode;
    if (errcode === undefined || errcode === null || errcode === 0) {
      return;
    }
    throw new Error(`${context} failed: ${response.errmsg ?? `errcode=${errcode}`}`);
  }

  #failPending(error: unknown): void {
    for (const [reqId, pending] of this.#pendingResponses) {
      pending.reject(error);
      this.#pendingResponses.delete(reqId);
    }
  }
}
