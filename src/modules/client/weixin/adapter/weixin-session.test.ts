import { describe, expect, it } from "vitest";
import { buildWeixinSessionId, parseWeixinSessionId } from "./weixin-session";

describe("weixin session helpers", () => {
  it("builds dm session ids", () => {
    expect(buildWeixinSessionId("dm", "wxid_123")).toBe("weixin:dm:wxid_123");
  });

  it("builds group session ids", () => {
    expect(buildWeixinSessionId("group", "room_456@chatroom")).toBe("weixin:group:room_456@chatroom");
  });

  it("parses session ids", () => {
    expect(parseWeixinSessionId("weixin:group:room_456@chatroom")).toEqual({
      platform: "weixin",
      chatType: "group",
      chatId: "room_456@chatroom",
    });
  });
});
