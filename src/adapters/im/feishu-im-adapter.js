import { FeishuClient } from './feishu-client.js';
import { buildFeishuSessionId, parseFeishuSessionId } from './feishu-session.js';

export class FeishuIMAdapter {
  #config;
  #onOutput = null;
  #busy = false;
  #client = null;

  constructor(config) {
    this.#config = config;
  }

  async start(onOutput) {
    this.#onOutput = onOutput;
    this.#client = new FeishuClient(this.#config);
    this.#client.setOnMessage(async ({ chatId, chatType, text }) => {
      if (!this.#onOutput) {
        return;
      }

      await this.#onOutput({
        type: 'user.message',
        sessionId: buildFeishuSessionId(chatType, chatId),
        text,
      });
    });

    await this.#client.connect();
    console.log(`[feishu] adapter started (domain=${this.#config.domain ?? 'feishu'})`);
  }

  async stop() {
    if (this.#client) {
      await this.#client.disconnect();
      this.#client = null;
    }
    this.#onOutput = null;
    console.log('[feishu] adapter stopped');
  }

  async input(event) {
    if (!this.#client) {
      throw new Error('FeishuIMAdapter is not started');
    }

    this.#busy = true;
    try {
      const target = parseFeishuSessionId(event.sessionId);
      await this.#client.sendText(target.chatId, event.text);
    } finally {
      this.#busy = false;
    }
  }

  async isBusy() {
    return this.#busy;
  }
}
