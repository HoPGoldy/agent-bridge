import { describe, expect, it } from "vitest";
import { buildFeishuSessionId, parseFeishuSessionId } from "./feishu-session";

describe("feishu session helpers", () => {
  it("builds dm session ids", () => {
    expect(buildFeishuSessionId("p2p", "oc_123")).toBe("feishu:dm:oc_123");
  });

  it("builds group session ids", () => {
    expect(buildFeishuSessionId("group", "oc_456")).toBe("feishu:group:oc_456");
  });

  it("parses session ids", () => {
    expect(parseFeishuSessionId("feishu:group:oc_456")).toEqual({
      platform: "feishu",
      chatType: "group",
      chatId: "oc_456",
    });
  });
});
