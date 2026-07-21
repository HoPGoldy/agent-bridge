export class FeishuIMAdapter {
  #config;
  #onOutput = null;
  #busy = false;

  constructor(config) {
    this.#config = config;
  }

  async start(onOutput) {
    this.#onOutput = onOutput;
    console.log(
      `[feishu] start requested (domain=${this.#config.domain ?? 'feishu'}) - implementation pending, target mode will follow Hermes WebSocket adapter.`,
    );
  }

  async stop() {
    console.log('[feishu] stop requested');
    this.#onOutput = null;
  }

  async input(event) {
    this.#busy = true;
    try {
      const target = this.#parseSessionId(event.sessionId);
      console.log(`[feishu] send text -> ${target.chatType}:${target.chatId}`);
      console.log(event.text);
    } finally {
      this.#busy = false;
    }
  }

  async isBusy() {
    return this.#busy;
  }

  async emitUserMessage(text, sessionId) {
    if (!this.#onOutput) {
      throw new Error('FeishuIMAdapter is not started');
    }
    await this.#onOutput({
      type: 'user.message',
      sessionId,
      text,
    });
  }

  #parseSessionId(sessionId) {
    if (sessionId.startsWith('feishu:dm:')) {
      return { chatType: 'dm', chatId: sessionId.slice('feishu:dm:'.length) };
    }
    if (sessionId.startsWith('feishu:group:')) {
      return { chatType: 'group', chatId: sessionId.slice('feishu:group:'.length) };
    }
    throw new Error(`Unsupported sessionId: ${sessionId}`);
  }
}
