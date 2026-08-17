import { describe, expect, it, vi } from "vitest";
import { feishuClientModule } from "./index";

const { FeishuIMAdapterMock } = vi.hoisted(() => ({ FeishuIMAdapterMock: vi.fn() }));

vi.mock("./adapter/feishu-im-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapter/feishu-im-adapter")>();
  return { ...actual, FeishuIMAdapter: FeishuIMAdapterMock };
});

describe("feishuClientModule config collector", () => {
  it("accepts a valid config", () => {
    const collector = feishuClientModule.createConfigCollector?.();
    expect(collector).toBeDefined();
    expect(() =>
      collector!.validate({
        appId: "cli_xxx",
        appSecret: "secret",
        domain: "feishu",
      }),
    ).not.toThrow();
  });

  it("rejects invalid domain", () => {
    const collector = feishuClientModule.createConfigCollector?.();
    expect(() =>
      collector!.validate({
        appId: "cli_xxx",
        appSecret: "secret",
        domain: "bad" as "feishu",
      }),
    ).toThrow("Feishu domain must be feishu or lark");
  });
});

describe("feishuClientModule validateSessionId", () => {
  it("accepts well-formed feishu session ids", () => {
    expect(feishuClientModule.validateSessionId("feishu:dm:oc_6f9d408e6300")).toBe(true);
    expect(feishuClientModule.validateSessionId("feishu:group:oc_6f9d408e6300")).toBe(true);
  });

  it("rejects malformed or foreign session ids", () => {
    expect(feishuClientModule.validateSessionId("wecom:dm:xxx")).toBe(false);
    expect(feishuClientModule.validateSessionId("feishu:chat:xxx")).toBe(false);
    expect(feishuClientModule.validateSessionId("bogus")).toBe(false);
    expect(feishuClientModule.validateSessionId("")).toBe(false);
  });
});

describe("feishuClientModule schedule bridges", () => {
  it("passes onScheduleRun and onScheduleHere into the adapter constructor", () => {
    const onScheduleRun = vi.fn();
    const onScheduleHere = vi.fn();
    const sessionState = {} as never;

    feishuClientModule.createClientAdapter({
      config: { appId: "cli_x", appSecret: "secret" },
      common: { channelName: "demo", language: "en-US" },
      sessionState,
      onScheduleRun,
      onScheduleHere,
    });

    expect(FeishuIMAdapterMock).toHaveBeenCalledWith(
      { appId: "cli_x", appSecret: "secret" },
      undefined,
      { channelName: "demo", language: "en-US" },
      sessionState,
      onScheduleRun,
      onScheduleHere,
    );
  });
});
