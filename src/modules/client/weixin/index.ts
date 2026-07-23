import { WeixinIMAdapter } from "./adapter/weixin-im-adapter";
import { loginWithWeixinQr } from "./adapter/weixin-qr-login";
import type { ClientModule, ConfigAdapter, WeixinClientConfig } from "../../../types";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

function createWeixinConfigCollector(): ConfigAdapter<WeixinClientConfig> {
  return {
    async collect(_ctx) {
      const qrCreds = await loginWithWeixinQr({ baseUrl: DEFAULT_BASE_URL });

      return {
        accountId: qrCreds.accountId,
        token: qrCreds.token,
        baseUrl: qrCreds.baseUrl,
        cdnBaseUrl: DEFAULT_CDN_BASE_URL,
      };
    },

    validate(config) {
      if (!config.accountId.trim()) {
        throw new Error("Weixin accountId is required");
      }
      if (!config.token.trim()) {
        throw new Error("Weixin token is required");
      }
      if (config.baseUrl && !/^https?:\/\//.test(config.baseUrl)) {
        throw new Error("Weixin baseUrl must start with http:// or https://");
      }
      if (config.cdnBaseUrl && !/^https?:\/\//.test(config.cdnBaseUrl)) {
        throw new Error("Weixin cdnBaseUrl must start with http:// or https://");
      }
    },

    summarize(config) {
      const masked =
        config.accountId.length > 8
          ? `${config.accountId.slice(0, 4)}****${config.accountId.slice(-4)}`
          : "****";
      return `type=weixin accountId=${masked} baseUrl=${config.baseUrl ?? DEFAULT_BASE_URL}`;
    },
  };
}

export const weixinClientModule: ClientModule<WeixinClientConfig> = {
  type: "weixin",
  createConfigCollector: createWeixinConfigCollector,
  createClientAdapter(config) {
    return new WeixinIMAdapter(config);
  },
};
