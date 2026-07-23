import { describe, expect, it } from "vitest";
import { buildWecomSessionId, parseWecomSessionId } from "./wecom-session";

describe("wecom session helpers", () => {
  it("builds dm session ids", () => {
    expect(buildWecomSessionId("dm", "user_123")).toBe("wecom:dm:user_123");
  });

  it("builds group session ids", () => {
    expect(buildWecomSessionId("group", "group_456")).toBe("wecom:group:group_456");
  });

  it("parses session ids", () => {
    expect(parseWecomSessionId("wecom:group:group_456")).toEqual({
      platform: "wecom",
      chatType: "group",
      chatId: "group_456",
    });
  });
});
