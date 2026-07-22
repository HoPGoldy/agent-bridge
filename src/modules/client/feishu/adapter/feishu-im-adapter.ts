import type { ClientEgressEvent, ClientIngressEvent, FeishuClientConfig, IMAdapter } from "../../../../types";
import { createLogger, type Logger } from "../../../../core/logger";
import { FeishuClient } from "./feishu-client";
import { buildFeishuSessionId, parseFeishuSessionId } from "./feishu-session";

export class FeishuIMAdapter implements IMAdapter {
  readonly #config: FeishuClientConfig;
  readonly #logger: Logger;
  #onOutput: ((event: ClientIngressEvent) => Promise<void> | void) | null = null;
  #client: FeishuClient | null = null;
  #egressQueue: ClientEgressEvent[] = [];
  #processing = false;

  constructor(config: FeishuClientConfig, logger: Logger = createLogger("feishu")) {
    this.#config = config;
    this.#logger = logger;
  }

  async start(onOutput: (event: ClientIngressEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    this.#client = new FeishuClient(this.#config, this.#logger);
    this.#client.setOnMessage(async ({ chatId, chatType, text }) => {
      if (!this.#onOutput) return;

      const clientSessionId = buildFeishuSessionId(chatType, chatId);
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
          this.#logger.info(`sending reply (session=${event.clientSessionId})`);
          await this.#client.sendText(target.chatId, event.text);
        } catch (error) {
          this.#logger.error("failed to send egress event:", error);
        }
      }
    } finally {
      this.#processing = false;
    }
  }
}
