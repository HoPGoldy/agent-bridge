import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../../../core/logger";
import type { OutboundAttachment } from "../../../../types";
import { WecomClient } from "./wecom-client";

type MessageHandler = ((event: { data: string }) => void) | null;
type VoidHandler = (() => void) | null;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: VoidHandler = null;
  onmessage: MessageHandler = null;
  onclose: VoidHandler = null;
  onerror: ((error: unknown) => void) | null = null;
  readonly sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function decodeLastSent(instance: FakeWebSocket): Record<string, any> {
  const raw = instance.sent.at(-1);
  if (!raw) throw new Error("no frame sent");
  return JSON.parse(raw);
}

async function waitFor(condition: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition not met in time");
}

describe("WecomClient", () => {
  afterEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.unstubAllGlobals();
  });

  it("subscribes on connect and emits inbound text messages", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    const onMessage = vi.fn(async () => {});
    client.setOnMessage(onMessage);

    const connecting = client.connect();
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    ws!.emitOpen();

    const subscribeFrame = decodeLastSent(ws!);
    expect(subscribeFrame.cmd).toBe("aibot_subscribe");
    expect(subscribeFrame.body).toMatchObject({
      bot_id: "bot-id",
      secret: "secret",
    });

    ws!.emitMessage({
      cmd: "aibot_subscribe",
      headers: { req_id: subscribeFrame.headers.req_id },
      errcode: 0,
    });

    await connecting;

    ws!.emitMessage({
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-in-1" },
      body: {
        msgid: "msg-1",
        chattype: "single",
        from: { userid: "user_1" },
        text: { content: "hello" },
        msgtype: "text",
      },
    });

    expect(onMessage).toHaveBeenCalledWith({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-1",
      text: "hello",
      mentionedBot: false,
      raw: expect.any(Object),
    });
  });

  it("detects group mentions and appends downloaded image paths", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    const fetchMock = vi.fn(async () =>
      new Response(Buffer.from("hello-image"), {
        headers: { "content-type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    const onMessage = vi.fn(async () => {});
    client.setOnMessage(onMessage);

    const connecting = client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    const subscribeFrame = decodeLastSent(ws);
    ws.emitMessage({
      cmd: "aibot_subscribe",
      headers: { req_id: subscribeFrame.headers.req_id },
      errcode: 0,
    });
    await connecting;

    ws.emitMessage({
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-group-1" },
      body: {
        msgid: "msg-2",
        chatid: "group_1",
        chattype: "group",
        from: { userid: "user_2" },
        msgtype: "image",
        text: { content: "@Bot please inspect this" },
        image: { url: "https://example.com/image.png" },
      },
    });
    await waitFor(() => onMessage.mock.calls.length === 1);

    const message = onMessage.mock.calls[0]?.[0] as { text: string; mentionedBot: boolean };
    expect(message.mentionedBot).toBe(true);
    expect(message.text).toContain("please inspect this");
    const match = message.text.match(/\[Received image: (.+)\]/);
    expect(match?.[1]).toBeTruthy();
    expect(existsSync(match![1]!)).toBe(true);
    rmSync(match![1]!, { force: true });
  });

  it("uses reply mode when reply context exists and falls back to proactive send", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    client.setOnMessage(async () => {});

    const connecting = client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    const subscribeFrame = decodeLastSent(ws);
    ws.emitMessage({
      cmd: "aibot_subscribe",
      headers: { req_id: subscribeFrame.headers.req_id },
      errcode: 0,
    });
    await connecting;

    ws.emitMessage({
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-reply-1" },
      body: {
        msgid: "msg-3",
        chattype: "single",
        from: { userid: "user_1" },
        msgtype: "text",
        text: { content: "hello" },
      },
    });

    const replySend = client.sendText("user_1", "hi back", "msg-3");
    const replyFrame = decodeLastSent(ws);
    expect(replyFrame.cmd).toBe("aibot_respond_msg");
    expect(replyFrame.headers.req_id).toBe("req-reply-1");
    ws.emitMessage({
      cmd: "aibot_respond_msg",
      headers: { req_id: "req-reply-1" },
      errcode: 0,
    });
    await replySend;

    const sendText = client.sendText("user_2", "proactive");
    const proactiveFrame = decodeLastSent(ws);
    expect(proactiveFrame.cmd).toBe("aibot_send_msg");
    const proactiveReqId = proactiveFrame.headers.req_id;
    ws.emitMessage({
      cmd: "aibot_send_msg",
      headers: { req_id: proactiveReqId },
      errcode: 0,
    });
    await sendText;
  });

  it("uploads attachments and sends a native image message", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    const filePath = join(tmpdir(), `wecom-client-test-${Date.now()}.png`);
    const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(filePath, pngBytes);

    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    client.setOnMessage(async () => {});

    const connecting = client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    const subscribeFrame = decodeLastSent(ws);
    ws.emitMessage({
      cmd: "aibot_subscribe",
      headers: { req_id: subscribeFrame.headers.req_id },
      errcode: 0,
    });
    await connecting;

    const sending = client.sendAttachment("user_1", { kind: "image", filePath } satisfies OutboundAttachment);
    await waitFor(() => ws.sent.length >= 2);

    const initFrame = decodeLastSent(ws);
    expect(initFrame.cmd).toBe("aibot_upload_media_init");
    const initReqId = initFrame.headers.req_id;
    ws.emitMessage({
      cmd: "aibot_upload_media_init",
      headers: { req_id: initReqId },
      errcode: 0,
      body: { upload_id: "upload-1" },
    });
    await waitFor(() => ws.sent.length >= 3);

    const chunkFrame = decodeLastSent(ws);
    expect(chunkFrame.cmd).toBe("aibot_upload_media_chunk");
    const chunkReqId = chunkFrame.headers.req_id;
    ws.emitMessage({
      cmd: "aibot_upload_media_chunk",
      headers: { req_id: chunkReqId },
      errcode: 0,
    });
    await waitFor(() => ws.sent.length >= 4);

    const finishFrame = decodeLastSent(ws);
    expect(finishFrame.cmd).toBe("aibot_upload_media_finish");
    const finishReqId = finishFrame.headers.req_id;
    ws.emitMessage({
      cmd: "aibot_upload_media_finish",
      headers: { req_id: finishReqId },
      errcode: 0,
      body: { media_id: "media-1", type: "image" },
    });
    await waitFor(() => ws.sent.length >= 5);

    const sendFrame = decodeLastSent(ws);
    expect(sendFrame.cmd).toBe("aibot_send_msg");
    expect(sendFrame.body).toMatchObject({
      chatid: "user_1",
      msgtype: "image",
      image: { media_id: "media-1" },
    });
    const sendReqId = sendFrame.headers.req_id;
    ws.emitMessage({
      cmd: "aibot_send_msg",
      headers: { req_id: sendReqId },
      errcode: 0,
    });

    await sending;
    rmSync(filePath, { force: true });
  });
});
