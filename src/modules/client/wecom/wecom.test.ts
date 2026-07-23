import { describe, expect, it } from "vitest";
import { wecomClientModule } from "./index";

describe("wecomClientModule config collector", () => {
  it("accepts a valid config", () => {
    const collector = wecomClientModule.createConfigCollector?.();
    expect(collector).toBeDefined();
    expect(() =>
      collector!.validate({
        botId: "bot-id",
        secret: "secret",
        websocketUrl: "wss://openws.work.weixin.qq.com",
      }),
    ).not.toThrow();
  });

  it("rejects invalid websocket URLs", () => {
    const collector = wecomClientModule.createConfigCollector?.();
    expect(() =>
      collector!.validate({
        botId: "bot-id",
        secret: "secret",
        websocketUrl: "https://example.com/ws",
      }),
    ).toThrow("WeCom websocketUrl must start with ws:// or wss://");
  });
});
