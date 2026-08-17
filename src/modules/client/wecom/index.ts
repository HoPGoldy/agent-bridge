import { WecomIMAdapter } from "./adapter/wecom-im-adapter";
import { parseWecomSessionId } from "./adapter/wecom-session";
import type { ClientModule, ConfigAdapter, WecomClientConfig } from "../../../types";
import {
  imClientSessionStateCodec,
  type ImClientSessionStateV1,
} from "../utils/client-session-state";

const DEFAULT_WEBSOCKET_URL = "wss://openws.work.weixin.qq.com";

function createWecomConfigCollector(): ConfigAdapter<WecomClientConfig> {
  return {
    async collect(ctx) {
      const botId = await ctx.input("WeCom Bot ID", {
        required: true,
        validate: (value) => (value ? null : "Bot ID is required"),
      });

      const secret = await ctx.input("WeCom Secret", {
        required: true,
        secret: true,
        validate: (value) => (value ? null : "Secret is required"),
      });

      const websocketUrl = await ctx.input("WeCom WebSocket URL", {
        defaultValue: DEFAULT_WEBSOCKET_URL,
        validate: (value) =>
          !value || /^wss?:\/\//.test(value) ? null : "WebSocket URL must start with ws:// or wss://",
      });

      const requireMentionInGroup = await ctx.confirm("Require @mention in group chats", true);

      return { botId, secret, websocketUrl, requireMentionInGroup };
    },

    validate(config) {
      if (!config.botId.trim()) {
        throw new Error("WeCom botId is required");
      }
      if (!config.secret.trim()) {
        throw new Error("WeCom secret is required");
      }
      if (config.websocketUrl && !/^wss?:\/\//.test(config.websocketUrl)) {
        throw new Error("WeCom websocketUrl must start with ws:// or wss://");
      }
    },

    summarize(config) {
      const masked = config.botId.length > 8 ? `${config.botId.slice(0, 4)}****${config.botId.slice(-4)}` : "****";
      return `type=wecom botId=${masked} websocketUrl=${config.websocketUrl ?? DEFAULT_WEBSOCKET_URL} requireMentionInGroup=${config.requireMentionInGroup ?? true}`;
    },
  };
}

export const wecomClientModule: ClientModule<WecomClientConfig, ImClientSessionStateV1> = {
  type: "wecom",
  sessionStateCodec: imClientSessionStateCodec,
  validateSessionId(clientSessionId) {
    try {
      parseWecomSessionId(clientSessionId);
      return true;
    } catch {
      return false;
    }
  },
  createConfigCollector: createWecomConfigCollector,
  createClientAdapter({ config, common, sessionState, onScheduleRun, onScheduleHere }) {
    return new WecomIMAdapter(config, undefined, common, sessionState, onScheduleRun, onScheduleHere);
  },
};
