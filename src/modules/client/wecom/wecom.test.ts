import { describe, expect, it, vi } from "vitest";
import { wecomClientModule } from "./index";

const { WecomIMAdapterMock } = vi.hoisted(() => ({ WecomIMAdapterMock: vi.fn() }));

vi.mock("./adapter/wecom-im-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapter/wecom-im-adapter")>();
  return { ...actual, WecomIMAdapter: WecomIMAdapterMock };
});

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

describe("wecomClientModule schedule and queue bridges", () => {
  it("passes onScheduleRun and onScheduleHere into the adapter constructor", () => {
    const onScheduleRun = vi.fn();
    const onScheduleHere = vi.fn();
    const sessionState = {} as never;

    wecomClientModule.createClientAdapter({
      config: { botId: "bot-id", secret: "secret" },
      common: { channelName: "demo", language: "en-US" },
      sessionState,
      onScheduleRun,
      onScheduleHere,
    });

    expect(WecomIMAdapterMock).toHaveBeenCalledWith(
      { botId: "bot-id", secret: "secret" },
      undefined,
      { channelName: "demo", language: "en-US" },
      sessionState,
      onScheduleRun,
      onScheduleHere,
      undefined,
    );
  });

  it("passes the onQueueHere queue bridge into the adapter constructor (T05)", () => {
    const onQueueHere = vi.fn();
    const sessionState = {} as never;

    wecomClientModule.createClientAdapter({
      config: { botId: "bot-id", secret: "secret" },
      common: { channelName: "demo", language: "en-US" },
      sessionState,
      onQueueHere,
    });

    expect(WecomIMAdapterMock).toHaveBeenCalledWith(
      { botId: "bot-id", secret: "secret" },
      undefined,
      { channelName: "demo", language: "en-US" },
      sessionState,
      undefined,
      undefined,
      onQueueHere,
    );
  });
});
