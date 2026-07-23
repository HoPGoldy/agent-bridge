import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "../../../../core/logger";
import type { OutboundAttachment } from "../../../../types";
import { WeixinClient } from "./weixin-client";

const mocks = vi.hoisted(() => ({
  monitorMock: vi.fn(async () => {}),
  pushMock: vi.fn(async () => "msg-1"),
  getContextTokenMock: vi.fn(() => "ctx-1"),
  getConfigMock: vi.fn(async () => ({ typing_ticket: "ticket-1" })),
  sendTypingMock: vi.fn(async () => {}),
  sendMediaFileMock: vi.fn(async () => {}),
  downloadMediaMock: vi.fn(async () => new Uint8Array([1, 2, 3])),
  extractTextMock: vi.fn(() => "hello"),
}));

vi.mock("@openilink/openilink-sdk-node", () => {
  class FakeClient {
    constructor(_token = "", _config: Record<string, unknown> = {}) {}
    monitor = mocks.monitorMock;
    push = mocks.pushMock;
    getContextToken = mocks.getContextTokenMock;
    getConfig = mocks.getConfigMock;
    sendTyping = mocks.sendTypingMock;
    sendMediaFile = mocks.sendMediaFileMock;
    downloadMedia = mocks.downloadMediaMock;
  }

  return {
    Client: FakeClient,
    extractText: mocks.extractTextMock,
    TYPING: 1,
    CANCEL_TYPING: 2,
  };
});

describe("WeixinClient", () => {
  afterEach(() => {
    mocks.monitorMock.mockReset();
    mocks.monitorMock.mockImplementation(async () => {});
    mocks.pushMock.mockReset();
    mocks.pushMock.mockImplementation(async () => "msg-1");
    mocks.getContextTokenMock.mockReset();
    mocks.getContextTokenMock.mockImplementation(() => "ctx-1");
    mocks.getConfigMock.mockReset();
    mocks.getConfigMock.mockImplementation(async () => ({ typing_ticket: "ticket-1" }));
    mocks.sendTypingMock.mockReset();
    mocks.sendTypingMock.mockImplementation(async () => {});
    mocks.sendMediaFileMock.mockReset();
    mocks.sendMediaFileMock.mockImplementation(async () => {});
    mocks.downloadMediaMock.mockReset();
    mocks.downloadMediaMock.mockImplementation(async () => new Uint8Array([1, 2, 3]));
    mocks.extractTextMock.mockReset();
    mocks.extractTextMock.mockImplementation(() => "hello");
  });

  it("starts monitor on connect and emits inbound text messages", async () => {
    const client = new WeixinClient(
      { accountId: "bot-account", token: "bot-token" },
      createLogger("test"),
    );
    const onMessage = vi.fn(async () => {});
    client.setOnMessage(onMessage);

    mocks.monitorMock.mockImplementationOnce(async (handler: (message: any) => Promise<void>) => {
      await handler({
        from_user_id: "wxid_user_1",
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      });
    });

    await client.connect();
    await Promise.resolve();

    expect(onMessage).toHaveBeenCalledWith({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: expect.any(String),
      text: "hello",
      mentionedBot: false,
      raw: expect.any(Object),
    });
  });

  it("sends text via proactive push", async () => {
    const client = new WeixinClient(
      { accountId: "bot-account", token: "bot-token" },
      createLogger("test"),
    );

    await client.connect();
    await client.sendText("wxid_user_1", "hello");

    expect(mocks.pushMock).toHaveBeenCalledWith("wxid_user_1", "hello");
  });

  it("refreshes typing ticket and sends typing state", async () => {
    const client = new WeixinClient(
      { accountId: "bot-account", token: "bot-token" },
      createLogger("test"),
    );

    await client.connect();
    await client.sendTyping("wxid_user_1");
    await client.stopTyping("wxid_user_1");

    expect(mocks.getConfigMock).toHaveBeenCalledWith("wxid_user_1", "ctx-1");
    expect(mocks.sendTypingMock).toHaveBeenNthCalledWith(1, "wxid_user_1", "ticket-1", 1);
    expect(mocks.sendTypingMock).toHaveBeenNthCalledWith(2, "wxid_user_1", "ticket-1", 2);
  });

  it("maps stale-session API errors to a clearer Weixin error", async () => {
    const client = new WeixinClient(
      { accountId: "bot-account", token: "bot-token" },
      createLogger("test"),
    );

    await client.connect();
    const staleError = Object.assign(
      new Error("ilink: api error ret=-2 errcode=-2 errmsg=unknown error"),
      { ret: -2, errCode: -2, errMsg: "unknown error" },
    );
    mocks.pushMock.mockRejectedValueOnce(staleError);

    await expect(client.sendText("wxid_user_1", "hello")).rejects.toMatchObject({
      name: "WeixinStaleSessionError",
      message: expect.stringContaining("stale"),
    });
  });

  it("uploads outbound attachments via sendMediaFile", async () => {
    const client = new WeixinClient(
      { accountId: "bot-account", token: "bot-token" },
      createLogger("test"),
    );
    const attachment: OutboundAttachment = {
      kind: "image",
      filePath: "/tmp/demo.png",
      fileName: "demo.png",
      caption: "caption",
    };

    await client.connect();

    const filePath = join(tmpdir(), `weixin-client-test-${Date.now()}.png`);
    writeFileSync(filePath, Buffer.from("abc"));
    attachment.filePath = filePath;

    try {
      await client.sendAttachment("wxid_user_1", attachment);
    } finally {
      rmSync(filePath, { force: true });
    }

    expect(mocks.sendMediaFileMock).toHaveBeenCalledWith(
      "wxid_user_1",
      "ctx-1",
      expect.any(Buffer),
      "demo.png",
      "caption",
    );
  });
});
