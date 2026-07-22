import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientOutputEvent, FeishuInboundMessage } from "../../../../types";
import { createLogger } from "../../../../core/logger";
import { FeishuIMAdapter } from "./feishu-im-adapter";

type FakeClientInstance = {
  setOnMessage: (handler: (message: FeishuInboundMessage) => Promise<void> | void) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sendText: (chatId: string, text: string, replyToMessageId?: string) => Promise<void>;
  sendCard: (
    chatId: string,
    card: Record<string, unknown>,
    replyToMessageId?: string,
  ) => Promise<string | null>;
  updateCard: (messageId: string, card: Record<string, unknown>) => Promise<void>;
  startTyping: (chatId: string, messageId: string) => Promise<void>;
  stopTyping: (chatId: string) => Promise<void>;
  sendAttachment: (chatId: string, attachment: unknown, replyToMessageId?: string) => Promise<void>;
};

const fakeClientState: {
  onMessage: ((message: FeishuInboundMessage) => Promise<void> | void) | null;
  sendText: ReturnType<typeof vi.fn>;
  sendCard: ReturnType<typeof vi.fn>;
  updateCard: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  startTyping: ReturnType<typeof vi.fn>;
  stopTyping: ReturnType<typeof vi.fn>;
  sendAttachment: ReturnType<typeof vi.fn>;
} = {
  onMessage: null,
  sendText: vi.fn(async () => {}),
  sendCard: vi.fn(async () => "card-1"),
  updateCard: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  startTyping: vi.fn(async () => {}),
  stopTyping: vi.fn(async () => {}),
  sendAttachment: vi.fn(async () => {}),
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
        sendCard: fakeClientState.sendCard,
        updateCard: fakeClientState.updateCard,
        startTyping: fakeClientState.startTyping,
        stopTyping: fakeClientState.stopTyping,
        sendAttachment: fakeClientState.sendAttachment,
      }),
    ),
  };
});

function resetFakeClient(): void {
  fakeClientState.onMessage = null;
  fakeClientState.sendText.mockReset();
  fakeClientState.sendText.mockImplementation(async () => {});
  fakeClientState.sendCard.mockReset();
  fakeClientState.sendCard.mockImplementation(async () => "card-1");
  fakeClientState.updateCard.mockReset();
  fakeClientState.updateCard.mockImplementation(async () => {});
  fakeClientState.connect.mockReset();
  fakeClientState.connect.mockImplementation(async () => {});
  fakeClientState.disconnect.mockReset();
  fakeClientState.disconnect.mockImplementation(async () => {});
  fakeClientState.startTyping.mockReset();
  fakeClientState.startTyping.mockImplementation(async () => {});
  fakeClientState.stopTyping.mockReset();
  fakeClientState.stopTyping.mockImplementation(async () => {});
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
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

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

  it("forwards /stop to the core as a command event", async () => {
    const adapter = new FeishuIMAdapter(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "oc_dm",
      chatType: "p2p",
      messageId: "msg-stop",
      text: "/stop",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledWith({
      type: "command.session.stop",
      clientSessionId: "feishu:dm:oc_dm",
    });
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

  it("renders progress cards with friendly labels and skips thinking events", async () => {
    const adapter = new FeishuIMAdapter(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "oc_dm",
      chatType: "p2p",
      messageId: "msg-progress-1",
      text: "hello",
      mentionedBot: false,
    });

    await adapter.input({
      type: "assistant.thinking",
      clientSessionId: "feishu:dm:oc_dm",
      text: "Planning",
    });
    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "feishu:dm:oc_dm",
      agentSessionId: "agent-1",
      toolName: "web_search",
      text: "Running web_search",
    });
    await adapter.input({
      type: "assistant.tool.done",
      clientSessionId: "feishu:dm:oc_dm",
      agentSessionId: "agent-1",
      toolName: "bash",
      text: "Finished bash",
    });
    await adapter.input({
      type: "assistant.tool.error",
      clientSessionId: "feishu:dm:oc_dm",
      agentSessionId: "agent-1",
      toolName: "bash",
      text: "Failed bash",
    });

    await waitFor(
      () =>
        fakeClientState.sendCard.mock.calls.length === 1 &&
        fakeClientState.updateCard.mock.calls.length === 2,
    );

    expect(fakeClientState.sendCard).toHaveBeenCalledTimes(1);
    const firstCard = fakeClientState.sendCard.mock.calls[0]?.[1] as {
      header?: unknown;
      body: { elements: Array<{ content: string }> };
    };
    expect(firstCard.header).toBeUndefined();
    expect(firstCard.body.elements[0]?.content).toBe("- Running web_search");

    const updatedCard = fakeClientState.updateCard.mock.calls[1]?.[1] as {
      header?: unknown;
      body: { elements: Array<{ content: string }> };
    };
    expect(updatedCard.header).toBeUndefined();
    expect(updatedCard.body.elements[0]?.content).toBe(
      ["- Running web_search", "- Finished bash", "- Failed bash"].join("\n"),
    );
  });

  it("keeps multiple tool updates in the same card within one user turn", async () => {
    const adapter = new FeishuIMAdapter(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    fakeClientState.sendCard.mockResolvedValueOnce("card-1").mockResolvedValueOnce("card-2");

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "oc_dm",
      chatType: "p2p",
      messageId: "msg-progress-2",
      text: "hello",
      mentionedBot: false,
    });

    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "feishu:dm:oc_dm",
      agentSessionId: "agent-1",
      toolName: "web_search",
      text: "Running web_search",
    });
    await adapter.input({
      type: "assistant.tool.done",
      clientSessionId: "feishu:dm:oc_dm",
      agentSessionId: "agent-1",
      toolName: "web_search",
      text: "Finished web_search",
    });
    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "feishu:dm:oc_dm",
      agentSessionId: "agent-1",
      toolName: "read_file",
      text: "Running read_file",
    });

    await waitFor(
      () =>
        fakeClientState.sendCard.mock.calls.length === 1 &&
        fakeClientState.updateCard.mock.calls.length === 2,
    );

    const finalCard = fakeClientState.updateCard.mock.calls[1]?.[1] as {
      body: { elements: Array<{ content: string }> };
    };
    expect(finalCard.body.elements[0]?.content).toBe(
      ["- Running web_search", "- Finished web_search", "- Running read_file"].join("\n"),
    );
  });

  it("starts a fresh progress card only after the next user message", async () => {
    const adapter = new FeishuIMAdapter(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    fakeClientState.sendCard.mockResolvedValueOnce("card-1").mockResolvedValueOnce("card-2");

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "oc_dm",
      chatType: "p2p",
      messageId: "msg-turn-1",
      text: "first question",
      mentionedBot: false,
    });

    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "feishu:dm:oc_dm",
      agentSessionId: "agent-1",
      toolName: "web_search",
      text: "Running web_search",
    });
    await adapter.input({
      type: "assistant.tool.done",
      clientSessionId: "feishu:dm:oc_dm",
      agentSessionId: "agent-1",
      toolName: "web_search",
      text: "Finished web_search",
    });

    await waitFor(() => fakeClientState.sendCard.mock.calls.length === 1);

    await fakeClientState.onMessage?.({
      chatId: "oc_dm",
      chatType: "p2p",
      messageId: "msg-turn-2",
      text: "second question",
      mentionedBot: false,
    });

    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "feishu:dm:oc_dm",
      agentSessionId: "agent-1",
      toolName: "read_file",
      text: "Running read_file",
    });

    await waitFor(() => fakeClientState.sendCard.mock.calls.length === 2);

    const secondCard = fakeClientState.sendCard.mock.calls[1]?.[1] as {
      body: { elements: Array<{ content: string }> };
    };
    expect(secondCard.body.elements[0]?.content).toBe("- Running read_file");
  });

  it("shows a collapsed-updates summary after more than ten progress entries", async () => {
    const adapter = new FeishuIMAdapter(
      {
        appId: "cli_xxx",
        appSecret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "oc_dm",
      chatType: "p2p",
      messageId: "msg-collapse",
      text: "hello",
      mentionedBot: false,
    });

    for (let index = 1; index <= 12; index += 1) {
      await adapter.input({
        type: "assistant.tool.running",
        clientSessionId: "feishu:dm:oc_dm",
        agentSessionId: "agent-1",
        toolName: `tool_${index}`,
        text: `Running tool_${index}`,
      });
    }

    await waitFor(() => fakeClientState.updateCard.mock.calls.length >= 11);

    const finalCard = fakeClientState.updateCard.mock.calls.at(-1)?.[1] as {
      body: { elements: Array<{ content: string }> };
    };
    expect(finalCard.body.elements[0]?.content).toBe(
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
});
