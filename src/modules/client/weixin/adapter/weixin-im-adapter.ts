import type {
  ChannelCommonContext,
  ClientInputEvent,
  ClientOutputEvent,
  IMAdapter,
  WeixinClientConfig,
} from "../../../../types";
import { formatSendFailureNotice, getTranslatorForCommon, type Translator } from "../../../../i18n";
import { createLogger, type Logger } from "../../../../core/logger";
import { ProgressRenderer } from "../../utils/progress-renderer";
import { parseSlashCommand, resolveHelpMarkdown } from "../../utils/slash-commands";
import { WeixinClient } from "./weixin-client";
import { buildWeixinSessionId, parseWeixinSessionId } from "./weixin-session";

const MAX_TEXT_CHUNK = 2000;
const PROGRESS_INTERVAL_MS = 60_000;
const MESSAGE_DEDUP_TTL_MS = 5 * 60_000;
const TYPING_REFRESH_INTERVAL_MS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_THRESHOLD = 2;
const RATE_LIMIT_COOLDOWN_MS = 60_000;

type ProgressFlushEvent = {
  type: "$progress.flush";
  clientSessionId: string;
};

type EgressEvent = ClientInputEvent | ProgressFlushEvent;

type ProgressState = {
  renderer: ProgressRenderer;
  dirty: boolean;
  interval: NodeJS.Timeout | null;
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

export class WeixinIMAdapter implements IMAdapter {
  readonly #config: WeixinClientConfig;
  readonly #logger: Logger;
  readonly #t: Translator;
  #onOutput: ((event: ClientOutputEvent) => Promise<void> | void) | null = null;
  #client: WeixinClient | null = null;
  #egressQueue: EgressEvent[] = [];
  #processing = false;
  #progressStateBySession = new Map<string, ProgressState>();
  #typingHeartbeatBySession = new Map<string, NodeJS.Timeout>();
  #recentInboundMessageIds = new Map<string, number>();
  #recentInboundContentKeys = new Map<string, number>();
  #rateLimitEvents: number[] = [];
  #rateLimitCircuitUntil = 0;

  constructor(
    config: WeixinClientConfig,
    logger: Logger = createLogger("weixin"),
    common?: ChannelCommonContext,
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#t = getTranslatorForCommon(common);
  }

  async start(onOutput: (event: ClientOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    this.#client = new WeixinClient(this.#config, this.#logger);
    this.#client.setOnMessage(async ({ chatId, chatType, text, messageId }) => {
      if (!this.#onOutput) {
        this.#logger.warn(`dropping inbound message, adapter not ready (chatId=${chatId})`);
        return;
      }

      const clientSessionId = buildWeixinSessionId(chatType, chatId);

      if (this.#isDuplicateInbound(chatId, messageId, text)) {
        this.#logger.debug(
          `dropping duplicate inbound message (session=${clientSessionId} messageId=${messageId})`,
        );
        return;
      }

      if (chatType === "group") {
        this.#logger.debug(`ignoring unsupported Weixin group message (session=${clientSessionId})`);
        return;
      }

      const normalizedText = text.trim();
      const helpMarkdown = resolveHelpMarkdown(normalizedText, this.#t);
      if (helpMarkdown) {
        await this.#client?.sendText(chatId, helpMarkdown);
        return;
      }

      this.#resetProgressState(clientSessionId);
      const commandEvent = parseSlashCommand(normalizedText, clientSessionId);
      if (commandEvent) {
        await this.#onOutput(commandEvent);
        return;
      }

      await this.#client?.sendTyping(chatId);
      this.#startTypingHeartbeat(clientSessionId, chatId);

      await this.#onOutput({
        type: "user.message",
        clientSessionId,
        text,
      });
    });

    await this.#client.connect();
    this.#logger.info(`adapter started (baseUrl=${this.#config.baseUrl ?? "https://ilinkai.weixin.qq.com"})`);
  }

  async stop(): Promise<void> {
    this.#egressQueue.length = 0;
    for (const state of this.#progressStateBySession.values()) {
      if (state.interval) {
        clearInterval(state.interval);
      }
    }
    this.#progressStateBySession.clear();
    for (const timer of this.#typingHeartbeatBySession.values()) {
      clearInterval(timer);
    }
    this.#typingHeartbeatBySession.clear();
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
      throw new Error("WeixinIMAdapter is not started");
    }

    this.#egressQueue.push(event);
    await this.#drainEgressQueue();
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
          const target = parseWeixinSessionId(event.clientSessionId);

          if (event.type === "$progress.flush") {
            await this.#flushProgressSummary(target.chatId, event.clientSessionId);
            continue;
          }

          if (event.type !== "assistant.message") {
            this.#recordProgressEvent(event);
            continue;
          }

          this.#stopProgressTimer(event.clientSessionId);
          if (event.text.trim().length > 0) {
            const chunks = chunkText(event.text, MAX_TEXT_CHUNK);
            for (const chunk of chunks) {
              await this.#sendTextWithProtection(target.chatId, chunk);
            }
          }
          for (const attachment of event.attachments ?? []) {
            try {
              await this.#client.sendAttachment(target.chatId, attachment);
            } catch (attachmentError) {
              this.#logger.error("failed to send attachment:", attachmentError);
              await this.#notifySendFailure(target.chatId, attachmentError);
            }
          }
          this.#stopTypingHeartbeat(event.clientSessionId);
          await this.#client.stopTyping(target.chatId);
        } catch (error) {
          this.#logger.error("failed to send egress event:", error);
          try {
            const target = parseWeixinSessionId(event.clientSessionId);
            this.#stopTypingHeartbeat(event.clientSessionId);
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

  #startTypingHeartbeat(clientSessionId: string, chatId: string): void {
    this.#stopTypingHeartbeat(clientSessionId);
    const timer = setInterval(() => {
      void this.#client?.sendTyping(chatId);
    }, TYPING_REFRESH_INTERVAL_MS);
    timer.unref?.();
    this.#typingHeartbeatBySession.set(clientSessionId, timer);
  }

  #stopTypingHeartbeat(clientSessionId: string): void {
    const timer = this.#typingHeartbeatBySession.get(clientSessionId);
    if (!timer) {
      return;
    }
    clearInterval(timer);
    this.#typingHeartbeatBySession.delete(clientSessionId);
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

  async #sendTextWithProtection(chatId: string, text: string): Promise<void> {
    if (!this.#client) {
      throw new Error("WeixinIMAdapter is not started");
    }

    const now = Date.now();
    if (this.#rateLimitCircuitUntil > now) {
      throw new Error(this.#t("client.weixinCooldown"));
    }
    if (this.#rateLimitCircuitUntil !== 0 && this.#rateLimitCircuitUntil <= now) {
      this.#rateLimitCircuitUntil = 0;
      this.#rateLimitEvents = [];
    }

    try {
      await this.#client.sendText(chatId, text);
      this.#resetRateLimitState();
    } catch (error) {
      if (this.#isStaleSessionError(error)) {
        throw error;
      }
      if (this.#isRateLimitError(error)) {
        this.#recordRateLimitEvent(now);
        if (this.#rateLimitCircuitUntil > now) {
          throw new Error(this.#t("client.weixinCooldown"));
        }
      }
      throw error;
    }
  }

  #recordProgressEvent(event: Exclude<ClientInputEvent, { type: "assistant.message" }>): void {
    const state = this.#progressStateBySession.get(event.clientSessionId) ?? this.#createProgressState();
    this.#progressStateBySession.set(event.clientSessionId, state);

    if (!state.renderer.isProgressEvent(event)) {
      return;
    }
    state.renderer.takeProgressEvent(event);
    state.dirty = true;
  }

  async #flushProgressSummary(chatId: string, clientSessionId: string): Promise<void> {
    const state = this.#progressStateBySession.get(clientSessionId);
    if (!state || !state.dirty || !this.#client) {
      return;
    }

    await this.#sendTextWithProtection(chatId, state.renderer.getCurrentProgress().markdown);
    state.dirty = false;
  }

  #queueProgressFlush(clientSessionId: string): void {
    this.#egressQueue.push({ type: "$progress.flush", clientSessionId });
    void this.#drainEgressQueue();
  }

  #createProgressState(): ProgressState {
    return {
      renderer: new ProgressRenderer({ t: this.#t }),
      dirty: false,
      interval: null,
    };
  }

  #resetProgressState(clientSessionId: string): void {
    const previous = this.#progressStateBySession.get(clientSessionId);
    if (previous?.interval) {
      clearInterval(previous.interval);
    }
    const state = this.#createProgressState();
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

  #isDuplicateInbound(chatId: string, messageId: string, text: string): boolean {
    const now = Date.now();
    this.#pruneDedupState(now);

    if (messageId) {
      const existing = this.#recentInboundMessageIds.get(messageId);
      if (existing && now - existing < MESSAGE_DEDUP_TTL_MS) {
        return true;
      }
      this.#recentInboundMessageIds.set(messageId, now);
    }

    const normalizedText = text.trim();
    if (!normalizedText) {
      return false;
    }

    const contentKey = `${chatId}:${normalizedText}`;
    const existingContent = this.#recentInboundContentKeys.get(contentKey);
    if (existingContent && now - existingContent < MESSAGE_DEDUP_TTL_MS) {
      return true;
    }
    this.#recentInboundContentKeys.set(contentKey, now);
    return false;
  }

  #pruneDedupState(now: number): void {
    for (const [messageId, seenAt] of this.#recentInboundMessageIds) {
      if (now - seenAt >= MESSAGE_DEDUP_TTL_MS) {
        this.#recentInboundMessageIds.delete(messageId);
      }
    }
    for (const [contentKey, seenAt] of this.#recentInboundContentKeys) {
      if (now - seenAt >= MESSAGE_DEDUP_TTL_MS) {
        this.#recentInboundContentKeys.delete(contentKey);
      }
    }
  }

  #recordRateLimitEvent(now: number): void {
    this.#rateLimitEvents = this.#rateLimitEvents.filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
    );
    this.#rateLimitEvents.push(now);
    if (this.#rateLimitEvents.length >= RATE_LIMIT_THRESHOLD) {
      this.#rateLimitCircuitUntil = now + RATE_LIMIT_COOLDOWN_MS;
    }
  }

  #resetRateLimitState(): void {
    this.#rateLimitEvents = [];
    this.#rateLimitCircuitUntil = 0;
  }

  #isRateLimitError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    if (this.#isStaleSessionError(error)) {
      return false;
    }
    return (
      message.includes("frequency limit") || message.includes("rate limit") || message.includes("freq limit")
    );
  }

  #isStaleSessionError(error: unknown): boolean {
    return error instanceof Error && error.name === "WeixinStaleSessionError";
  }
}
