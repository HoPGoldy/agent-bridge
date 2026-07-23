import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientOutputEvent, WecomInboundMessage } from "../../../../types";
import { createLogger } from "../../../../core/logger";
import { WecomIMAdapter } from "./wecom-im-adapter";

type FakeClientInstance = {
  setOnMessage: (handler: (message: WecomInboundMessage) => Promise<void> | void) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sendText: (chatId: string, text: string, replyToMessageId?: string) => Promise<void>;
  sendAttachment: (chatId: string, attachment: unknown, replyToMessageId?: string) => Promise<void>;
};

const fakeClientState: {
  onMessage: ((message: WecomInboundMessage) => Promise<void> | void) | null;
  sendText: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  sendAttachment: ReturnType<typeof vi.fn>;
} = {
  onMessage: null,
  sendText: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  sendAttachment: vi.fn(async () => {}),
};

vi.mock("./wecom-client", () => {
  return {
    WecomClient: vi.fn().mockImplementation(
      (): FakeClientInstance => ({
        setOnMessage(handler) {
          fakeClientState.onMessage = handler;
        },
        connect: fakeClientState.connect,
        disconnect: fakeClientState.disconnect,
        sendText: fakeClientState.sendText,
        sendAttachment: fakeClientState.sendAttachment,
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

describe("WecomIMAdapter", () => {
  afterEach(() => {
    resetFakeClient();
    vi.useRealTimers();
  });

  it("ignores group messages without bot mention", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-1",
      text: "hello",
      mentionedBot: false,
    });

    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).not.toHaveBeenCalled();
  });

  it("accepts direct messages and immediately acknowledges in English", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-2",
      text: "hello",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledWith({
      type: "user.message",
      clientSessionId: "wecom:dm:user_1",
      text: "hello",
    });
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      "I’m starting now — I’ll share a progress update in about a minute.",
      "msg-2",
    );
  });

  it("forwards /stop to the core as a command event", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-stop",
      text: "/stop",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledWith({
      type: "command.session.stop",
      clientSessionId: "wecom:dm:user_1",
    });
  });

  it("sends chunked replies sequentially and replies only on the first chunk", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});
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
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-3",
      text: "hello",
      mentionedBot: true,
    });

    fakeClientState.sendText.mockClear();
    callOrder.length = 0;

    const longText = `${"a".repeat(3999)} ${"b".repeat(50)}`;
    await adapter.input({
      type: "assistant.message",
      clientSessionId: "wecom:group:group_1",
      text: longText,
    });

    await waitFor(() => fakeClientState.sendText.mock.calls.length === 2);

    expect(fakeClientState.sendText).toHaveBeenCalledTimes(2);
    expect(fakeClientState.sendText.mock.calls[0]?.[2]).toBe("msg-3");
    expect(fakeClientState.sendText.mock.calls[1]?.[2]).toBeUndefined();
    expect(maxInFlight).toBe(1);
    expect(callOrder).toEqual(["4000:msg-3", "50:none"]);
  });

  it("notifies the user when delivery fails", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-4",
      text: "hello",
      mentionedBot: true,
    });

    fakeClientState.sendText.mockClear();
    fakeClientState.sendText
      .mockRejectedValueOnce(new Error("field validation failed"))
      .mockResolvedValueOnce(undefined);

    await adapter.input({
      type: "assistant.message",
      clientSessionId: "wecom:group:group_1",
      text: "reply body",
    });

    await waitFor(() => fakeClientState.sendText.mock.calls.length === 2);

    expect(fakeClientState.sendText.mock.calls[1]?.[0]).toBe("group_1");
    expect(fakeClientState.sendText.mock.calls[1]?.[1]).toContain(
      "[agent-bridge error] Message delivery failed",
    );
    expect(fakeClientState.sendText.mock.calls[1]?.[1]).toContain("field validation failed");
  });

  it("sends one progress summary per minute using the same body text as feishu", async () => {
    vi.useFakeTimers();

    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-progress-1",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendText.mockClear();

    await adapter.input({
      type: "assistant.thinking",
      clientSessionId: "wecom:dm:user_1",
      text: "Planning",
    });
    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "web_search",
      text: "Running web_search",
    });
    await adapter.input({
      type: "assistant.tool.done",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      text: "Finished bash",
    });
    await adapter.input({
      type: "assistant.tool.error",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      text: "Failed bash",
    });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(fakeClientState.sendText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => fakeClientState.sendText.mock.calls.length === 1);

    expect(fakeClientState.sendText.mock.calls[0]?.[1]).toBe(
      ["- Running web_search", "- Finished bash", "- Failed bash"].join("\n"),
    );
  });

  it("shows a collapsed-updates summary after more than ten progress entries", async () => {
    vi.useFakeTimers();

    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-collapse",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendText.mockClear();

    for (let index = 1; index <= 12; index += 1) {
      await adapter.input({
        type: "assistant.tool.running",
        clientSessionId: "wecom:dm:user_1",
        agentSessionId: "agent-1",
        toolName: `tool_${index}`,
        text: `Running tool_${index}`,
      });
    }

    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => fakeClientState.sendText.mock.calls.length === 1);

    expect(fakeClientState.sendText.mock.calls[0]?.[1]).toBe(
      [
        "- Collapsed 2 earlier updates.",
        "- Running tool_3",
        "- Running tool_4",
        "- Running tool_5",
        "- Running tool_6",
        "- Running tool_7",
        "- Running tool_8",
        "- Running tool_9",
        "- Running tool_10",
        "- Running tool_11",
        "- Running tool_12",
      ].join("\n"),
    );
  });

  it("sends attachments after the text reply", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-attach",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendText.mockClear();

    await adapter.input({
      type: "assistant.message",
      clientSessionId: "wecom:dm:user_1",
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
});
