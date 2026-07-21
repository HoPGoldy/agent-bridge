import * as Lark from '@larksuiteoapi/node-sdk';

const DEDUP_TTL_MS = 12 * 60 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 5000;
const MESSAGE_EXPIRY_MS = 30 * 60 * 1000;

function now() {
  return Date.now();
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function replaceMentionKeys(text, mentions = []) {
  let result = text;
  for (const mention of mentions) {
    if (!mention?.key) continue;
    const display = mention?.name ? `@${mention.name}` : '';
    result = result.replaceAll(mention.key, display);
  }
  return result.trim();
}

function parseTextContent(rawContent, messageType, mentions = []) {
  const parsed = parseJson(rawContent);

  switch (messageType) {
    case 'text': {
      const text = typeof parsed === 'object' && parsed ? parsed.text ?? '' : String(parsed ?? '');
      return replaceMentionKeys(text, mentions);
    }

    case 'post': {
      const locale = parsed?.zh_cn ?? parsed?.en_us ?? parsed?.ja_jp;
      const parts = [];
      if (locale?.title) parts.push(locale.title);
      if (Array.isArray(locale?.content)) {
        for (const row of locale.content) {
          if (!Array.isArray(row)) continue;
          for (const item of row) {
            if (item?.tag === 'text' && item.text) parts.push(item.text);
            else if (item?.tag === 'a' && item.text) parts.push(item.text);
            else if (item?.tag === 'md' && item.text) parts.push(item.text);
          }
        }
      }
      return parts.join('').trim();
    }

    default:
      return '';
  }
}

export class FeishuClient {
  #config;
  #client;
  #wsClient = null;
  #onMessage = null;
  #dedup = new Map();
  #dedupTimer = null;

  constructor(config) {
    this.#config = config;
    const domain = config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;

    this.#client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain,
    });
  }

  setOnMessage(onMessage) {
    this.#onMessage = onMessage;
  }

  async connect() {
    const dispatcher = new Lark.EventDispatcher({
      encryptKey: this.#config.encryptKey ?? '',
      verificationToken: this.#config.verificationToken ?? '',
    });

    dispatcher.register({
      'im.message.receive_v1': (data) => {
        void this.#handleMessage(data);
      },
    });

    this.#startDedupSweep();

    const domain = this.#config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
    this.#wsClient = new Lark.WSClient({
      appId: this.#config.appId,
      appSecret: this.#config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain,
      loggerLevel: Lark.LoggerLevel.info,
      autoReconnect: true,
      onReady: () => {
        console.log('[feishu] websocket ready');
      },
      onError: (error) => {
        console.error('[feishu] websocket error:', error?.message ?? error);
      },
      onReconnecting: () => {
        console.log('[feishu] websocket reconnecting');
      },
      onReconnected: () => {
        console.log('[feishu] websocket reconnected');
      },
    });

    await this.#wsClient.start({ eventDispatcher: dispatcher });
  }

  async disconnect() {
    if (this.#dedupTimer) {
      clearInterval(this.#dedupTimer);
      this.#dedupTimer = null;
    }

    if (this.#wsClient) {
      try {
        this.#wsClient.close({ force: true });
      } catch {
        // ignore
      }
      this.#wsClient = null;
    }
  }

  async sendText(chatId, text) {
    const content = JSON.stringify({ text });
    await this.#client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content,
      },
    });
  }

  async #handleMessage(data) {
    const message = data?.message;
    const sender = data?.sender;
    if (!message || !sender) return;

    if (sender.sender_type === 'app' || sender.sender_type === 'bot') {
      return;
    }

    if (message.create_time && this.#isExpired(message.create_time)) {
      return;
    }

    if (!this.#recordDedup(message.message_id)) {
      return;
    }

    const text = parseTextContent(message.content, message.message_type, message.mentions);
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

  #recordDedup(messageId) {
    if (!messageId) return false;
    if (this.#dedup.has(messageId)) return false;
    this.#dedup.set(messageId, now());

    if (this.#dedup.size > DEDUP_MAX_ENTRIES) {
      const firstKey = this.#dedup.keys().next().value;
      if (firstKey) {
        this.#dedup.delete(firstKey);
      }
    }

    return true;
  }

  #isExpired(createTime) {
    const timestamp = Number.parseInt(String(createTime), 10);
    if (!Number.isFinite(timestamp)) return false;
    return now() - timestamp > MESSAGE_EXPIRY_MS;
  }

  #startDedupSweep() {
    if (this.#dedupTimer) return;
    this.#dedupTimer = setInterval(() => {
      const cutoff = now() - DEDUP_TTL_MS;
      for (const [messageId, timestamp] of this.#dedup) {
        if (timestamp < cutoff) {
          this.#dedup.delete(messageId);
        }
      }
    }, 5 * 60 * 1000);
  }
}
