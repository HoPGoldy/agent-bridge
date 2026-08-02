import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Event, Provider, Session } from "@opencode-ai/sdk/v2/types";
import { MEDIA_CONVENTION_PROMPT } from "../../media-convention";
import { OpenCodeAgentAdapter } from "./opencode-agent-adapter";
import type { OpenCodeApi } from "./opencode-api";
import { OpenCodeRuntime } from "./opencode-runtime";

const mediaDir = realpathSync(mkdtempSync(join(tmpdir(), "opencode-media-test-")));
const mediaPath = join(mediaDir, "chart.png");
const mediaFilePath = join(mediaDir, "report.pdf");
writeFileSync(mediaPath, "fake-png-bytes");
writeFileSync(mediaFilePath, "fake-pdf-bytes");

afterAll(() => {
  rmSync(mediaDir, { recursive: true, force: true });
});

function provider(): Provider {
  return {
    id: "anthropic",
    name: "Anthropic",
    source: "config",
    env: [],
    options: {},
    models: {
      "claude-sonnet": {
        id: "claude-sonnet",
        providerID: "anthropic",
        api: { id: "claude-sonnet", url: "", npm: "" },
        name: "Claude Sonnet",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: true },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 200_000, output: 8_192 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2025-01-01",
      },
    },
  };
}

function createApi(overrides: Partial<OpenCodeApi> = {}): OpenCodeApi {
  return {
    health: vi.fn(async () => ({ healthy: true as const, version: "1.18.10" })),
    createSession: vi.fn(async () => ({ id: "ses-1" }) as Session),
    getSession: vi.fn(async () => ({ id: "ses-1" }) as Session),
    getSessionStatuses: vi.fn(async () => ({})),
    getMessages: vi.fn(async () => []),
    promptAsync: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    summarize: vi.fn(async () => undefined),
    getProviders: vi.fn(async () => ({
      all: [provider()],
      connected: ["anthropic"],
      default: { anthropic: "claude-sonnet" },
    })),
    listPermissions: vi.fn(async () => []),
    replyPermission: vi.fn(async () => undefined),
    listQuestions: vi.fn(async () => []),
    rejectQuestion: vi.fn(async () => undefined),
    subscribe: vi.fn(async ({ signal, onConnected }) => {
      await onConnected();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }),
    ...overrides,
  };
}

function createAdapter(api = createApi()) {
  const runtime = new OpenCodeRuntime({ api });
  const adapter = new OpenCodeAgentAdapter({
    agentSessionId: "opencode:ses-1",
    openCodeSessionId: "ses-1",
    config: { baseUrl: "http://127.0.0.1:4096", agent: "build" },
    runtime,
    initialModel: { providerID: "anthropic", modelID: "claude-sonnet" },
  });
  return { adapter, api };
}

function event(value: unknown): Event {
  return value as Event;
}

describe("OpenCodeAgentAdapter", () => {
  it("sends prompts with the selected model and accepts follow-up while busy", async () => {
    const { adapter, api } = createAdapter();
    const output = vi.fn();
    await adapter.start(output);

    await adapter.input({ type: "user.message", text: "first" });
    await adapter.input({ type: "user.message", text: "follow-up" });

    expect(api.promptAsync).toHaveBeenNthCalledWith(1, "ses-1", {
      text: "first",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
      system: MEDIA_CONVENTION_PROMPT,
    });
    expect(api.promptAsync).toHaveBeenNthCalledWith(2, "ses-1", {
      text: "follow-up",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
      system: MEDIA_CONVENTION_PROMPT,
    });
    expect(await adapter.isBusy()).toBe(true);

    await adapter.stop();
  });

  it("maps assistant text and tool progress without mixing user text", async () => {
    const { adapter } = createAdapter();
    const output = vi.fn();
    await adapter.start(output);

    await adapter.handleOpenCodeEvent(
      event({
        id: "1",
        type: "message.part.updated",
        properties: {
          sessionID: "ses-1",
          time: 1,
          part: { id: "user-part", sessionID: "ses-1", messageID: "user-1", type: "text", text: "question" },
        },
      }),
    );
    await adapter.handleOpenCodeEvent(
      event({
        id: "2",
        type: "message.updated",
        properties: {
          sessionID: "ses-1",
          info: {
            id: "assistant-1",
            sessionID: "ses-1",
            role: "assistant",
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      }),
    );
    await adapter.handleOpenCodeEvent(
      event({
        id: "3",
        type: "message.part.updated",
        properties: {
          sessionID: "ses-1",
          time: 2,
          part: {
            id: "tool-1",
            sessionID: "ses-1",
            messageID: "assistant-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: "running", input: { command: "pwd" }, title: "Run command", time: { start: 1 } },
          },
        },
      }),
    );
    await adapter.handleOpenCodeEvent(
      event({
        id: "4",
        type: "message.part.updated",
        properties: {
          sessionID: "ses-1",
          time: 3,
          part: { id: "text-1", sessionID: "ses-1", messageID: "assistant-1", type: "text", text: "answer" },
        },
      }),
    );
    await adapter.handleOpenCodeEvent(
      event({ id: "5", type: "session.idle", properties: { sessionID: "ses-1" } }),
    );

    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "assistant.tool.running",
        agentSessionId: "opencode:ses-1",
        toolName: "bash",
        toolCallId: "call-1",
      }),
    );
    expect(output).toHaveBeenCalledWith({
      type: "assistant.message",
      agentSessionId: "opencode:ses-1",
      text: "answer",
      attachments: undefined,
    });
    expect(output).not.toHaveBeenCalledWith(expect.objectContaining({ type: "assistant.message", text: "question" }));

    await adapter.stop();
  });

  it("turns MEDIA markers into attachments and deduplicates native file parts", async () => {
    const { adapter } = createAdapter();
    const output = vi.fn();
    await adapter.start(output);

    await adapter.handleOpenCodeEvent(
      event({
        id: "media-message",
        type: "message.updated",
        properties: {
          sessionID: "ses-1",
          info: {
            id: "assistant-media",
            sessionID: "ses-1",
            role: "assistant",
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      }),
    );
    await adapter.handleOpenCodeEvent(
      event({
        id: "native-file",
        type: "message.part.updated",
        properties: {
          sessionID: "ses-1",
          time: 1,
          part: {
            id: "file-1",
            sessionID: "ses-1",
            messageID: "assistant-media",
            type: "file",
            mime: "image/png",
            filename: "chart.png",
            url: `file://${mediaPath}`,
          },
        },
      }),
    );
    await adapter.handleOpenCodeEvent(
      event({
        id: "media-text",
        type: "message.part.updated",
        properties: {
          sessionID: "ses-1",
          time: 2,
          part: {
            id: "text-media",
            sessionID: "ses-1",
            messageID: "assistant-media",
            type: "text",
            text: `Chart and report attached. MEDIA:${mediaPath} MEDIA:${mediaFilePath}`,
          },
        },
      }),
    );
    await adapter.handleOpenCodeEvent(
      event({ id: "media-idle", type: "session.idle", properties: { sessionID: "ses-1" } }),
    );

    expect(output).toHaveBeenCalledWith({
      type: "assistant.message",
      agentSessionId: "opencode:ses-1",
      text: "Chart and report attached.",
      attachments: [
        { kind: "image", filePath: mediaPath, fileName: "chart.png" },
        { kind: "file", filePath: mediaFilePath },
      ],
    });
    await adapter.stop();
  });

  it("does not expose OpenCode's internal compaction summary as an assistant reply", async () => {
    const { adapter } = createAdapter();
    const output = vi.fn();
    await adapter.start(output);

    await adapter.handleOpenCodeEvent(
      event({
        id: "summary-message",
        type: "message.updated",
        properties: {
          sessionID: "ses-1",
          info: {
            id: "assistant-summary",
            sessionID: "ses-1",
            role: "assistant",
            summary: true,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      }),
    );
    await adapter.handleOpenCodeEvent(
      event({
        id: "summary-text",
        type: "message.part.updated",
        properties: {
          sessionID: "ses-1",
          time: 1,
          part: {
            id: "summary-part",
            sessionID: "ses-1",
            messageID: "assistant-summary",
            type: "text",
            text: "## Objective\nInternal compacted context",
          },
        },
      }),
    );
    await adapter.handleOpenCodeEvent(
      event({ id: "summary-idle", type: "session.idle", properties: { sessionID: "ses-1" } }),
    );

    expect(output).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "assistant.message", text: expect.stringContaining("Objective") }),
    );
    await adapter.stop();
  });

  it("automatically allows only routed permissions and rejects questions", async () => {
    const { adapter, api } = createAdapter();
    const output = vi.fn();
    await adapter.start(output);

    await adapter.handleOpenCodeEvent(
      event({ id: "p", type: "permission.asked", properties: { id: "perm-1", sessionID: "ses-1" } }),
    );
    await adapter.handleOpenCodeEvent(
      event({ id: "p2", type: "permission.asked", properties: { id: "perm-1", sessionID: "ses-1" } }),
    );
    await adapter.handleOpenCodeEvent(
      event({ id: "q", type: "question.asked", properties: { id: "question-1", sessionID: "ses-1", questions: [] } }),
    );

    expect(api.replyPermission).toHaveBeenCalledOnce();
    expect(api.replyPermission).toHaveBeenCalledWith("perm-1", "once");
    expect(api.rejectQuestion).toHaveBeenCalledWith("question-1");
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", kind: "agent.question.unsupported" }),
    );

    await adapter.stop();
  });

  it("lists only connected provider models and applies a model to the next prompt", async () => {
    const { adapter, api } = createAdapter();
    await adapter.start(vi.fn());

    expect(await adapter.getAvailableModels()).toEqual([
      { provider: "anthropic", modelId: "claude-sonnet", isCurrent: true },
    ]);
    expect(await adapter.setModel("anthropic/claude-sonnet")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet",
    });
    await adapter.input({ type: "user.message", text: "hello" });

    expect(api.promptAsync).toHaveBeenCalledWith(
      "ses-1",
      expect.objectContaining({ model: { providerID: "anthropic", modelID: "claude-sonnet" } }),
    );
    await adapter.stop();
  });

  it("compacts and aborts only the current session", async () => {
    const { adapter, api } = createAdapter();
    const output = vi.fn();
    await adapter.start(output);

    const compacting = adapter.input({ type: "command.session.compact" });
    await vi.waitFor(() => {
      expect(api.summarize).toHaveBeenCalledWith("ses-1", {
        providerID: "anthropic",
        modelID: "claude-sonnet",
      });
    });
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.compacting", agentSessionId: "opencode:ses-1" }),
    );
    expect(output).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "assistant.message", text: "Context compacted." }),
    );
    await adapter.handleOpenCodeEvent(
      event({ id: "compacted", type: "session.compacted", properties: { sessionID: "ses-1" } }),
    );
    await compacting;
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ type: "assistant.message", text: "Context compacted." }),
    );

    await adapter.abort();
    expect(api.abort).toHaveBeenCalledWith("ses-1");
    expect(await adapter.isBusy()).toBe(false);
    await adapter.stop();
  });
});
