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

describe("wecomClientModule validateSessionId", () => {
  it("accepts well-formed wecom session ids", () => {
    expect(wecomClientModule.validateSessionId("wecom:dm:wr_6f9d408e6300")).toBe(true);
    expect(wecomClientModule.validateSessionId("wecom:group:wr_6f9d408e6300")).toBe(true);
  });

  it("rejects malformed or foreign session ids", () => {
    expect(wecomClientModule.validateSessionId("feishu:dm:xxx")).toBe(false);
    expect(wecomClientModule.validateSessionId("wecom:chat:xxx")).toBe(false);
    expect(wecomClientModule.validateSessionId("bogus")).toBe(false);
    expect(wecomClientModule.validateSessionId("")).toBe(false);
  });
});
