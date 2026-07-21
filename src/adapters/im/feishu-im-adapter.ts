import type { AgentEgressEvent, AgentIngressEvent, FeishuChannelConfig, IMAdapter } from "../../types";
import { FeishuClient } from "./feishu-client";
import { buildFeishuSessionId, parseFeishuSessionId } from "./feishu-session";

export class FeishuIMAdapter implements IMAdapter {
  readonly #config: FeishuChannelConfig;
  #onOutput: ((event: AgentIngressEvent) => Promise<void> | void) | null = null;
  #busy = false;
  #client: FeishuClient | null = null;

  constructor(config: FeishuChannelConfig) {
    this.#config = config;
  }

  async start(onOutput: (event: AgentIngressEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    this.#client = new FeishuClient(this.#config);
    this.#client.setOnMessage(async ({ chatId, chatType, text }) => {
      if (!this.#onOutput) return;

      await this.#onOutput({
        type: "user.message",
        sessionId: buildFeishuSessionId(chatType, chatId),
        text,
      });
    });

    await this.#client.connect();
    console.log(`[feishu] adapter started (domain=${this.#config.domain ?? "feishu"})`);
  }

  async stop(): Promise<void> {
    if (this.#client) {
      await this.#client.disconnect();
      this.#client = null;
    }
    this.#onOutput = null;
    console.log("[feishu] adapter stopped");
  }

  async input(event: AgentEgressEvent): Promise<void> {
    if (!this.#client) {
      throw new Error("FeishuIMAdapter is not started");
    }

    this.#busy = true;
    try {
      const target = parseFeishuSessionId(event.sessionId);
      await this.#client.sendText(target.chatId, event.text);
    } finally {
      this.#busy = false;
    }
  }

  async isBusy(): Promise<boolean> {
    return this.#busy;
  }
}
