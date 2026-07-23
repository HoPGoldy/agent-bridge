import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientOutputEvent, WeixinInboundMessage } from "../../../../types";
import { createLogger } from "../../../../core/logger";
import { WeixinIMAdapter } from "./weixin-im-adapter";

type FakeClientInstance = {
  setOnMessage: (handler: (message: WeixinInboundMessage) => Promise<void> | void) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sendText: (chatId: string, text: string) => Promise<void>;
  sendAttachment: (chatId: string, attachment: unknown) => Promise<void>;
  sendTyping: (chatId: string) => Promise<void>;
  stopTyping: (chatId: string) => Promise<void>;
};

const fakeClientState: {
  onMessage: ((message: WeixinInboundMessage) => Promise<void> | void) | null;
  sendText: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  sendAttachment: ReturnType<typeof vi.fn>;
  sendTyping: ReturnType<typeof vi.fn>;
  stopTyping: ReturnType<typeof vi.fn>;
} = {
  onMessage: null,
  sendText: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  sendAttachment: vi.fn(async () => {}),
  sendTyping: vi.fn(async () => {}),
  stopTyping: vi.fn(async () => {}),
};

vi.mock("./weixin-client", () => {
  return {
    WeixinClient: vi.fn().mockImplementation(
      (): FakeClientInstance => ({
        setOnMessage(handler) {
          fakeClientState.onMessage = handler;
        },
        connect: fakeClientState.connect,
        disconnect: fakeClientState.disconnect,
        sendText: fakeClientState.sendText,
        sendAttachment: fakeClientState.sendAttachment,
        sendTyping: fakeClientState.sendTyping,
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
  fakeClientState.sendAttachment.mockReset();
  fakeClientState.sendAttachment.mockImplementation(async () => {});
  fakeClientState.sendTyping.mockReset();
  fakeClientState.sendTyping.mockImplementation(async () => {});
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

describe("WeixinIMAdapter", () => {
  afterEach(() => {
    resetFakeClient();
    vi.useRealTimers();
  });

  it("ignores all Weixin group messages because group chats are unsupported", async () => {
    const adapter = new WeixinIMAdapter(
      {
        accountId: "bot-account",
        token: "bot-token",
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "room_1@chatroom",
      chatType: "group",
      messageId: "msg-1",
      text: "hello",
      mentionedBot: true,
    });

    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendTyping).not.toHaveBeenCalled();
  });

  it("drops duplicate inbound messages with the same message id", async () => {
    const adapter = new WeixinIMAdapter(
      {
        accountId: "bot-account",
        token: "bot-token",
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: "dup-1",
      text: "hello",
      mentionedBot: false,
    });
    await fakeClientState.onMessage?.({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: "dup-1",
      text: "hello",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledTimes(1);
  });

  it("drops duplicate inbound content delivered with different message ids", async () => {
    const adapter = new WeixinIMAdapter(
      {
        accountId: "bot-account",
        token: "bot-token",
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: "dup-a",
      text: "same content",
      mentionedBot: false,
    });
    await fakeClientState.onMessage?.({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: "dup-b",
      text: "same content",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledTimes(1);
  });

  it("accepts direct messages and starts typing immediately", async () => {
    const adapter = new WeixinIMAdapter(
      {
        accountId: "bot-account",
        token: "bot-token",
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: "msg-2",
      text: "hello",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledWith({
      type: "user.message",
      clientSessionId: "weixin:dm:wxid_user_1",
      text: "hello",
    });
    expect(fakeClientState.sendTyping).toHaveBeenCalledWith("wxid_user_1");
  });

  it("forwards /stop to the core as a command event", async () => {
    const adapter = new WeixinIMAdapter(
      {
        accountId: "bot-account",
        token: "bot-token",
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: "msg-stop",
      text: "/stop",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledWith({
      type: "command.session.stop",
      clientSessionId: "weixin:dm:wxid_user_1",
    });
  });

  it("sends chunked replies sequentially and stops typing after the final reply", async () => {
    const adapter = new WeixinIMAdapter(
      {
        accountId: "bot-account",
        token: "bot-token",
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});
    const callOrder: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    fakeClientState.sendText.mockImplementation(async (_chatId: string, text: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      callOrder.push(String(text.length));
      await Promise.resolve();
      inFlight -= 1;
    });

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: "msg-3",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendText.mockClear();
    fakeClientState.stopTyping.mockClear();
    callOrder.length = 0;

    const longText = `${"a".repeat(1999)} ${"b".repeat(50)}`;
    await adapter.input({
      type: "assistant.message",
      clientSessionId: "weixin:dm:wxid_user_1",
      text: longText,
    });

    await waitFor(() => fakeClientState.sendText.mock.calls.length === 2);

    expect(fakeClientState.sendText).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(callOrder).toEqual(["2000", "50"]);
    expect(fakeClientState.stopTyping).toHaveBeenCalledWith("wxid_user_1");
  });

  it("sends one progress summary per minute when progress changes", async () => {
    vi.useFakeTimers();

    const adapter = new WeixinIMAdapter(
      {
        accountId: "bot-account",
        token: "bot-token",
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: "msg-progress-1",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendText.mockClear();

    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "weixin:dm:wxid_user_1",
      agentSessionId: "agent-1",
      toolName: "web_search",
      text: "Running web_search",
    });
    await adapter.input({
      type: "assistant.tool.done",
      clientSessionId: "weixin:dm:wxid_user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      text: "Finished bash",
    });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(fakeClientState.sendText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => fakeClientState.sendText.mock.calls.length === 1);

    expect(fakeClientState.sendText.mock.calls[0]?.[1]).toBe(
      ["- Running web_search", "- Finished bash"].join("\n"),
    );
  });

  it("sends attachments after the text reply", async () => {
    const adapter = new WeixinIMAdapter(
      {
        accountId: "bot-account",
        token: "bot-token",
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: "msg-attach",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendText.mockClear();

    await adapter.input({
      type: "assistant.message",
      clientSessionId: "weixin:dm:wxid_user_1",
      text: "Here you go",
      attachments: [{ kind: "image", filePath: "/tmp/image.png" }],
    });

    await waitFor(
      () => fakeClientState.sendText.mock.calls.length === 1 && fakeClientState.sendAttachment.mock.calls.length === 1,
    );

    expect(fakeClientState.sendText.mock.invocationCallOrder[0]).toBeLessThan(
      fakeClientState.sendAttachment.mock.invocationCallOrder[0],
    );
  });

  it("opens a rate-limit cooldown after repeated frequency-limit failures and fails later sends fast", async () => {
    vi.useFakeTimers();

    const adapter = new WeixinIMAdapter(
      {
        accountId: "bot-account",
        token: "bot-token",
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: "msg-rate-limit",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendText.mockClear();
    fakeClientState.sendText
      .mockRejectedValueOnce(new Error("frequency limit"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("frequency limit"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await adapter.input({
      type: "assistant.message",
      clientSessionId: "weixin:dm:wxid_user_1",
      text: "first",
    });
    await adapter.input({
      type: "assistant.message",
      clientSessionId: "weixin:dm:wxid_user_1",
      text: "second",
    });
    await adapter.input({
      type: "assistant.message",
      clientSessionId: "weixin:dm:wxid_user_1",
      text: "third",
    });

    const sentTexts = fakeClientState.sendText.mock.calls.map((call) => call[1]);
    expect(sentTexts).toEqual([
      "first",
      expect.stringContaining("Message delivery failed"),
      "second",
      expect.stringContaining("Message delivery failed"),
      expect.stringContaining("cooling down"),
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    await adapter.input({
      type: "assistant.message",
      clientSessionId: "weixin:dm:wxid_user_1",
      text: "after cooldown",
    });

    expect(fakeClientState.sendText.mock.calls.at(-1)?.[1]).toBe("after cooldown");
  });

  it("treats stale-session send failures separately from rate limits", async () => {
    const adapter = new WeixinIMAdapter(
      {
        accountId: "bot-account",
        token: "bot-token",
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: "msg-stale",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendText.mockClear();
    const staleError = Object.assign(new Error("Weixin conversation context became stale"), {
      name: "WeixinStaleSessionError",
    });
    fakeClientState.sendText
      .mockRejectedValueOnce(staleError)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await adapter.input({
      type: "assistant.message",
      clientSessionId: "weixin:dm:wxid_user_1",
      text: "first",
    });
    await adapter.input({
      type: "assistant.message",
      clientSessionId: "weixin:dm:wxid_user_1",
      text: "second",
    });

    const sentTexts = fakeClientState.sendText.mock.calls.map((call) => call[1]);
    expect(sentTexts).toEqual([
      "first",
      expect.stringContaining("Message delivery failed"),
      "second",
    ]);
  });

  it("notifies the user when delivery fails", async () => {
    const adapter = new WeixinIMAdapter(
      {
        accountId: "bot-account",
        token: "bot-token",
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "wxid_user_1",
      chatType: "dm",
      messageId: "msg-fail",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendText.mockClear();
    fakeClientState.sendText
      .mockRejectedValueOnce(new Error("frequency limit"))
      .mockResolvedValueOnce(undefined);

    await adapter.input({
      type: "assistant.message",
      clientSessionId: "weixin:dm:wxid_user_1",
      text: "reply body",
    });

    await waitFor(() => fakeClientState.sendText.mock.calls.length === 2);

    expect(fakeClientState.sendText.mock.calls[1]?.[0]).toBe("wxid_user_1");
    expect(fakeClientState.sendText.mock.calls[1]?.[1]).toContain(
      "[agent-bridge error] Message delivery failed",
    );
    expect(fakeClientState.sendText.mock.calls[1]?.[1]).toContain("frequency limit");
    expect(fakeClientState.stopTyping).toHaveBeenCalledWith("wxid_user_1");
  });
});
