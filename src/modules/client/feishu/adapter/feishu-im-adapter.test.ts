import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeishuInboundMessage } from "../../../../types";
import { createLogger } from "../../../../core/logger";
import { FeishuIMAdapter } from "./feishu-im-adapter";

type FakeClientInstance = {
  setOnMessage: (handler: (message: FeishuInboundMessage) => Promise<void> | void) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sendText: (chatId: string, text: string, replyToMessageId?: string) => Promise<void>;
  startTyping: (chatId: string, messageId: string) => Promise<void>;
  stopTyping: (chatId: string) => Promise<void>;
};

const fakeClientState: {
  onMessage: ((message: FeishuInboundMessage) => Promise<void> | void) | null;
  sendText: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  startTyping: ReturnType<typeof vi.fn>;
  stopTyping: ReturnType<typeof vi.fn>;
} = {
  onMessage: null,
  sendText: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  startTyping: vi.fn(async () => {}),
  stopTyping: vi.fn(async () => {}),
};

vi.mock("./feishu-client", () => {
  return {
    FeishuClient: vi.fn().mockImplementation(
      (): FakeClientInstance => ({
        setOnMessage(handler) {
          fakeClientState.onMessage = handler;
        },
        connect: fakeClientState.connect,
        disconnect: fakeClientState.disconnect,
        sendText: fakeClientState.sendText,
        startTyping: fakeClientState.startTyping,
        stopTyping: fakeClientState.stopTyping,
      }),
    ),
  };
});

function resetFakeClient(): void {
  fakeClientState.onMessage = null;
  fakeClientState.sendText.mockReset();
  fakeClientState.sendText.mockImplementation(async () => {});
  fakeClientState.connect.mockReset();
  fakeClientState.connect.mockImplementation(async () => {});
  fakeClientState.disconnect.mockReset();
  fakeClientState.disconnect.mockImplementation(async () => {});
  fakeClientState.startTyping.mockReset();
  fakeClientState.startTyping.mockImplementation(async () => {});
  fakeClientState.stopTyping.mockReset();
  fakeClientState.stopTyping.mockImplementation(async () => {});
}

async function waitFor(condition: () => boolean, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("condition not met in time");
}

describe("FeishuIMAdapter", () => {
  afterEach(() => {
    resetFakeClient();
  });

  it("ignores group messages without bot mention", async () => {
    const adapter = new FeishuIMAdapter(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "oc_group",
      chatType: "group",
      messageId: "msg-1",
      text: "hello",
      mentionedBot: false,
    });

    expect(onOutput).not.toHaveBeenCalled();
  });

  it("accepts direct messages without mention", async () => {
    const adapter = new FeishuIMAdapter(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "oc_dm",
      chatType: "p2p",
      messageId: "msg-2",
      text: "hello",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledWith({
      type: "user.message",
      clientSessionId: "feishu:dm:oc_dm",
      text: "hello",
    });
    expect(fakeClientState.startTyping).toHaveBeenCalledWith("oc_dm", "msg-2");
  });

  it("sends chunked replies sequentially and replies only on the first chunk", async () => {
    const adapter = new FeishuIMAdapter(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});
    const callOrder: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    fakeClientState.sendText.mockImplementation(
      async (_chatId: string, text: string, replyToMessageId?: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        callOrder.push(`${text.length}:${replyToMessageId ?? "none"}`);
        await Promise.resolve();
        inFlight -= 1;
      },
    );

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "oc_group",
      chatType: "group",
      messageId: "msg-3",
      text: "@bot hello",
      mentionedBot: true,
    });

    const longText = `${"a".repeat(3999)} ${"b".repeat(50)}`;
    await adapter.input({
      type: "assistant.message",
      clientSessionId: "feishu:group:oc_group",
      text: longText,
    });

    await waitFor(
      () =>
        fakeClientState.sendText.mock.calls.length === 2 &&
        fakeClientState.stopTyping.mock.calls.length === 1,
    );

    expect(fakeClientState.sendText).toHaveBeenCalledTimes(2);
    expect(fakeClientState.sendText.mock.calls[0]?.[2]).toBe("msg-3");
    expect(fakeClientState.sendText.mock.calls[1]?.[2]).toBeUndefined();
    expect(fakeClientState.stopTyping).toHaveBeenCalledWith("oc_group");
    expect(maxInFlight).toBe(1);
    expect(callOrder).toEqual(["4000:msg-3", "50:none"]);
  });

  it("notifies the user when delivery fails", async () => {
    const adapter = new FeishuIMAdapter(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});

    fakeClientState.sendText
      .mockRejectedValueOnce(new Error("field validation failed"))
      .mockResolvedValueOnce(undefined);

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "oc_group",
      chatType: "group",
      messageId: "msg-4",
      text: "@bot hello",
      mentionedBot: true,
    });

    await adapter.input({
      type: "assistant.message",
      clientSessionId: "feishu:group:oc_group",
      text: "reply body",
    });

    await waitFor(() => fakeClientState.sendText.mock.calls.length === 2);

    expect(fakeClientState.stopTyping).toHaveBeenCalledWith("oc_group");
    expect(fakeClientState.sendText.mock.calls[1]?.[0]).toBe("oc_group");
    expect(fakeClientState.sendText.mock.calls[1]?.[1]).toContain(
      "[agent-bridge error] Message delivery failed",
    );
    expect(fakeClientState.sendText.mock.calls[1]?.[1]).toContain("field validation failed");
  });
});
