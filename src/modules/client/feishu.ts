import { FeishuIMAdapter } from "../../adapters/im/feishu/feishu-im-adapter";
import type { ClientModule, ConfigAdapter, FeishuClientConfig } from "../../types";

function createFeishuConfigCollector(): ConfigAdapter<FeishuClientConfig> {
  return {
    async collect(ctx) {
      const appId = await ctx.input("Feishu App ID", {
        required: true,
        validate: (value) => (value ? null : "App ID is required"),
      });

      const appSecret = await ctx.input("Feishu App Secret", {
        required: true,
        secret: true,
        validate: (value) => (value ? null : "App Secret is required"),
      });

      const domain = await ctx.select("Feishu domain", [
        { label: "Feishu (default)", value: "feishu" },
        { label: "Lark", value: "lark" },
      ]);

      return {
        appId,
        appSecret,
        domain: domain as FeishuClientConfig["domain"],
      };
    },

    validate(config) {
      if (!config.appId.trim()) {
        throw new Error("Feishu appId is required");
      }
      if (!config.appSecret.trim()) {
        throw new Error("Feishu appSecret is required");
      }
      if (config.domain && !["feishu", "lark"].includes(config.domain)) {
        throw new Error("Feishu domain must be feishu or lark");
      }
    },

    summarize(config) {
      const masked =
        config.appId.length > 8
          ? `${config.appId.slice(0, 4)}****${config.appId.slice(-4)}`
          : "****";

      return `type=feishu appId=${masked} domain=${config.domain ?? "feishu"}`;
    },
  };
}

export const feishuClientModule: ClientModule<FeishuClientConfig> = {
  type: "feishu",
  createConfigCollector: createFeishuConfigCollector,
  createClientAdapter(config) {
    return new FeishuIMAdapter(config);
  },
};
