import type { ConfigAdapter, FeishuChannelConfig } from "../../types";

export const feishuConfigAdapter: ConfigAdapter<FeishuChannelConfig> = {
  type: "feishu",

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
      type: "feishu",
      appId,
      appSecret,
      domain: domain as FeishuChannelConfig["domain"],
    };
  },

  validate(config) {
    if (config.type !== "feishu") {
      throw new Error("Invalid Feishu config");
    }
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
