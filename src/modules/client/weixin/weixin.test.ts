import { describe, expect, it } from "vitest";
import { weixinClientModule } from "./index";

describe("weixinClientModule config collector", () => {
  it("accepts a valid config", () => {
    const collector = weixinClientModule.createConfigCollector?.();
    expect(collector).toBeDefined();
    expect(() =>
      collector!.validate({
        accountId: "bot-account",
        token: "bot-token",
        baseUrl: "https://ilinkai.weixin.qq.com",
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      }),
    ).not.toThrow();
  });

  it("rejects invalid base URLs", () => {
    const collector = weixinClientModule.createConfigCollector?.();
    expect(() =>
      collector!.validate({
        accountId: "bot-account",
        token: "bot-token",
        baseUrl: "ws://example.com",
      }),
    ).toThrow("Weixin baseUrl must start with http:// or https://");
  });
});

describe("weixinClientModule validateSessionId", () => {
  it("accepts well-formed weixin session ids", () => {
    expect(weixinClientModule.validateSessionId("weixin:dm:wx_6f9d408e6300")).toBe(true);
    expect(weixinClientModule.validateSessionId("weixin:group:wx_6f9d408e6300")).toBe(true);
  });

  it("rejects malformed or foreign session ids", () => {
    expect(weixinClientModule.validateSessionId("wecom:dm:xxx")).toBe(false);
    expect(weixinClientModule.validateSessionId("weixin:chat:xxx")).toBe(false);
    expect(weixinClientModule.validateSessionId("bogus")).toBe(false);
    expect(weixinClientModule.validateSessionId("")).toBe(false);
  });
});
