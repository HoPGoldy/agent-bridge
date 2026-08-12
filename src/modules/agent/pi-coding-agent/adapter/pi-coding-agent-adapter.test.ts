import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The original realpath implementation, captured before the mock replaces the
// module. Only the adapter and working-directory helper consume the mocked
// binding; everything else passes through to the real implementation.
const realpathState = vi.hoisted(() => ({
  realRealpath: undefined as typeof import("node:fs/promises").realpath | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  realpathState.realRealpath = actual.realpath;
  return { ...actual, realpath: vi.fn(actual.realpath) };
});
import type { AgentOutputEvent, AgentSessionRecord, NewAgentSessionStateApi } from "../../../../types";
import { createAgentSessionStateRegistry } from "../../../../config/agent-session-state";
import { createInMemoryChannelStateStore } from "../../../../config/channel-state";
import { piCodingAgentSessionStateCodec, type PiCodingAgentSessionStateV1 } from "../index";

const rpcClients: Array<{
  options: { cwd?: string; agentSessionId?: string; piSessionId?: string };
  emit: (event: { type: string; [key: string]: unknown }) => void;
}> = [];

let mockedState: {
  sessionId?: string;
  sessionName?: string;
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
} = { sessionId: "agent-1", sessionName: "agent-1" };

let mockedSessionStats: {
  contextUsage?: { tokens?: number | null; contextWindow?: number | null; percent?: number | null };
} = {};

let mockedAvailableModels: Array<{ provider: string; id: string }> = [];
let setModelCalls: Array<{ provider: string; modelId: string }> = [];
let promptCalls: Array<{ message: string; streamingBehavior?: "steer" | "followUp" }> = [];
let abortCalls = 0;

vi.mock("./pi-rpc-client", () => {
  return {
    PiRpcClient: class FakePiRpcClient {
      #listener: ((event: { type: string; [key: string]: unknown }) => void) | null = null;

      constructor(options: { cwd?: string; agentSessionId?: string; piSessionId?: string }) {
        rpcClients.push({
          options,
          emit: (event) => {
            this.#listener?.(event);
          },
        });
      }

      onEvent(listener: (event: { type: string; [key: string]: unknown }) => void): void {
        this.#listener = listener;
      }

      async start(): Promise<void> {}

      async stop(): Promise<void> {}

      async abort(): Promise<void> {
        abortCalls += 1;
      }

      async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
        promptCalls.push({ message, streamingBehavior });
      }

      async compact(): Promise<{ estimatedTokensAfter?: number; summary?: string }> {
        return {};
      }

      async getState(): Promise<{
        sessionId?: string;
        sessionName?: string;
        model?: { provider?: string; id?: string };
        thinkingLevel?: string;
        isStreaming?: boolean;
        isCompacting?: boolean;
      }> {
        return mockedState;
      }

      async getSessionStats(): Promise<{
        contextUsage?: { tokens?: number | null; contextWindow?: number | null; percent?: number | null };
      }> {
        return mockedSessionStats;
      }

      async getAvailableModels(): Promise<Array<{ provider: string; id: string }>> {
        return mockedAvailableModels;
      }

      async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
        setModelCalls.push({ provider, modelId });
        return { provider, id: modelId };
      }

      async setSessionName(): Promise<void> {}
    },
  };
});

import { PiCodingAgentAdapter } from "./pi-coding-agent-adapter";

/**
 * Minimal create-phase fake state handle for behavioral tests that are not
 * about state: start() initializes it and the PiRpcClient mock records the
 * resolved cwd.
 */
function createFakeHandle(): NewAgentSessionStateApi<PiCodingAgentSessionStateV1> & {
  state: PiCodingAgentSessionStateV1 | null;
  initializeCalls: number;
} {
  const handle = {
    agentSessionId: "agent-1",
    state: null as PiCodingAgentSessionStateV1 | null,
    initializeCalls: 0,
    async initialize(initial: PiCodingAgentSessionStateV1): Promise<void> {
      handle.initializeCalls += 1;
      handle.state = initial;
    },
    async read(): Promise<Readonly<PiCodingAgentSessionStateV1>> {
      if (!handle.state) throw new Error("state not initialized");
      return handle.state;
    },
    async replace(next: PiCodingAgentSessionStateV1): Promise<void> {
      handle.state = next;
    },
    async update(
      updater: (current: Readonly<PiCodingAgentSessionStateV1>) => PiCodingAgentSessionStateV1,
    ): Promise<Readonly<PiCodingAgentSessionStateV1>> {
      const next = updater(handle.state);
      handle.state = next;
      return next;
    },
    async flush(): Promise<void> {},
  };
  return handle;
}

async function makeCreateHandle(id: string) {
  const store = createInMemoryChannelStateStore();
  const registry = createAgentSessionStateRegistry(store);
  const handle = await registry.reserve({
    agentSessionId: id,
    agentType: "pi-coding-agent",
    codec: piCodingAgentSessionStateCodec,
  });
  return { store, registry, handle };
}

async function makeOpenHandle(id: string, state: unknown) {
  const store = createInMemoryChannelStateStore();
  const registry = createAgentSessionStateRegistry(store);
  const record: AgentSessionRecord = {
    recordVersion: 1,
    agentType: "pi-coding-agent",
    stateVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state,
  };
  await store.transaction((draft) => {
    draft.agentSessions[id] = record;
  });
  const handle = await registry.open({
    agentSessionId: id,
    agentType: "pi-coding-agent",
    codec: piCodingAgentSessionStateCodec,
  });
  return { store, registry, handle };
}

afterEach(() => {
  rpcClients.length = 0;
  // Drop queued mockImplementationOnce entries from TOCTOU tests and restore
  // the real pass-through default so sibling tests see normal fs behavior.
  const realpathMock = vi.mocked(realpath);
  realpathMock.mockReset();
  realpathMock.mockImplementation(realpathState.realRealpath!);
  mockedState = { sessionId: "agent-1", sessionName: "agent-1" };
  mockedSessionStats = {};
  mockedAvailableModels = [];
  setModelCalls = [];
  promptCalls = [];
  abortCalls = 0;
});

describe("PiCodingAgentAdapter", () => {
  it("delegates busy-message steering to Pi and tracks the run until it settles", async () => {
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1", mode: "create", sessionState: createFakeHandle() });

    await adapter.start(() => {});
    await adapter.input({ type: "user.message", text: "long-running task" });

    expect(promptCalls).toEqual([
      { message: "long-running task", streamingBehavior: "steer" },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await adapter.isBusy()).toBe(true);

    await adapter.input({ type: "user.message", text: "change direction" });
    expect(promptCalls).toEqual([
      { message: "long-running task", streamingBehavior: "steer" },
      { message: "change direction", streamingBehavior: "steer" },
    ]);

    await adapter.abort();
    expect(abortCalls).toBe(1);

    rpcClients[0]?.emit({ type: "agent_settled" });
    await vi.waitFor(async () => {
      expect(await adapter.isBusy()).toBe(false);
    });
  });

  it("forwards the persisted working directory to the pi RPC client on resume", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-adapter-cwd-"));
    try {
      const canonical = await realpath(dir);
      const { handle } = await makeOpenHandle("pi-coding-agent:cwd", {
        version: 1,
        workingDirectory: canonical,
        workingDirectorySource: "user",
      });
      const adapter = new PiCodingAgentAdapter({
        agentSessionId: "pi-coding-agent:cwd",
        mode: "resume",
        sessionState: handle,
      });

      await adapter.start(() => {});

      expect(rpcClients[0]?.options).toEqual(
        expect.objectContaining({ cwd: canonical, agentSessionId: "pi-coding-agent:cwd" }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forwards tool execution events with tool ids and labels but without generic display text", async () => {
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1", mode: "create", sessionState: createFakeHandle() });
    const outputs: AgentOutputEvent[] = [];

    await adapter.start((event) => {
      outputs.push(event);
    });

    rpcClients[0]?.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls -la" },
    });
    rpcClients[0]?.emit({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls -la" },
      partialResult: { content: [{ type: "text", text: "partial output" }] },
    });
    rpcClients[0]?.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    });

    expect(outputs).toEqual([
      {
        type: "assistant.tool.running",
        agentSessionId: "agent-1",
        toolName: "bash",
        toolCallId: "call-1",
        toolInput: { command: "ls -la" },
        toolLabel: "ls -la",
        text: undefined,
      },
      {
        type: "assistant.tool.update",
        agentSessionId: "agent-1",
        toolName: "bash",
        toolCallId: "call-1",
        toolInput: { command: "ls -la" },
        toolLabel: "ls -la",
        partialResult: { content: [{ type: "text", text: "partial output" }] },
        text: undefined,
      },
      {
        type: "assistant.tool.done",
        agentSessionId: "agent-1",
        toolName: "bash",
        toolCallId: "call-1",
        toolInput: { command: "ls -la" },
        toolLabel: "ls -la",
        result: { content: [{ type: "text", text: "done" }] },
        text: undefined,
      },
    ]);
  });

  it("omits redundant generic text for tool execution errors", async () => {
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1", mode: "create", sessionState: createFakeHandle() });
    const outputs: AgentOutputEvent[] = [];

    await adapter.start((event) => {
      outputs.push(event);
    });

    rpcClients[0]?.emit({
      type: "tool_execution_start",
      toolCallId: "call-err-1",
      toolName: "read",
      args: { path: "/tmp/demo.txt" },
    });
    rpcClients[0]?.emit({
      type: "tool_execution_end",
      toolCallId: "call-err-1",
      toolName: "read",
      result: { error: "ENOENT" },
      isError: true,
    });

    expect(outputs).toEqual([
      {
        type: "assistant.tool.running",
        agentSessionId: "agent-1",
        toolName: "read",
        toolCallId: "call-err-1",
        toolInput: { path: "/tmp/demo.txt" },
        toolLabel: "/tmp/demo.txt",
        text: undefined,
      },
      {
        type: "assistant.tool.error",
        agentSessionId: "agent-1",
        toolName: "read",
        toolCallId: "call-err-1",
        toolInput: { path: "/tmp/demo.txt" },
        toolLabel: "/tmp/demo.txt",
        result: { error: "ENOENT" },
        text: undefined,
      },
    ]);
  });

  it("returns structured session status from Pi RPC state and session stats", async () => {
    mockedState = {
      sessionId: "pi-session-1",
      sessionName: "agent-1",
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
      },
      thinkingLevel: "medium",
    };
    mockedSessionStats = {
      contextUsage: {
        tokens: 60_000,
        contextWindow: 200_000,
        percent: 30,
      },
    };

    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1", mode: "create", sessionState: createFakeHandle() });

    await adapter.start(() => {});
    const status = await adapter.getStatus?.();

    expect(status).toEqual({
      sessionId: "pi-session-1",
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      thinkingLevel: "medium",
      context: {
        tokens: 60_000,
        contextWindow: 200_000,
        percent: 30,
      },
    });
  });

  it("returns available models with the current model flagged", async () => {
    mockedState = {
      sessionId: "pi-session-1",
      sessionName: "agent-1",
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
      },
    };
    mockedAvailableModels = [
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "openai", id: "gpt-5" },
    ];

    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1", mode: "create", sessionState: createFakeHandle() });

    await adapter.start(() => {});
    const models = await adapter.getAvailableModels?.();

    expect(models).toEqual([
      { provider: "anthropic", modelId: "claude-sonnet-4-5", isCurrent: true },
      { provider: "openai", modelId: "gpt-5", isCurrent: false },
    ]);
  });

  it("sets the current model when the agent is idle", async () => {
    mockedState = {
      sessionId: "pi-session-1",
      sessionName: "agent-1",
      isStreaming: false,
      isCompacting: false,
    };

    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1", mode: "create", sessionState: createFakeHandle() });

    await adapter.start(() => {});
    const result = await adapter.setModel?.("anthropic/claude-sonnet-4-5");

    expect(setModelCalls).toEqual([{ provider: "anthropic", modelId: "claude-sonnet-4-5" }]);
    expect(result).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
  });

  it("rejects model switching while the agent is running", async () => {
    mockedState = {
      sessionId: "pi-session-1",
      sessionName: "agent-1",
      isStreaming: true,
      isCompacting: false,
    };

    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1", mode: "create", sessionState: createFakeHandle() });

    await adapter.start(() => {});

    await expect(adapter.setModel?.("anthropic/claude-sonnet-4-5")).rejects.toMatchObject({
      kind: "agent.model.busy",
    });
    expect(setModelCalls).toEqual([]);
  });

  it("forwards assistant text from Pi message_end text blocks", async () => {
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1", mode: "create", sessionState: createFakeHandle() });
    const outputs: AgentOutputEvent[] = [];

    await adapter.start((event) => {
      outputs.push(event);
    });

    rpcClients[0]?.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "第一段" },
          { type: "image", mimeType: "image/png", data: "ignored" },
          { type: "text", text: "第二段" },
        ],
      },
    });

    expect(outputs).toEqual([
      {
        type: "assistant.message",
        agentSessionId: "agent-1",
        text: "第一段第二段",
        attachments: [],
      },
    ]);
  });

  it("forwards failed assistant turns as agent.run.failed errors", async () => {
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1", mode: "create", sessionState: createFakeHandle() });
    const outputs: AgentOutputEvent[] = [];

    await adapter.start((event) => {
      outputs.push(event);
    });

    rpcClients[0]?.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Unknown error (no error details in response)",
        responseId: "resp-123",
        provider: "azure-openai-responses",
        model: "gpt-5.6-sol",
      },
    });

    await vi.waitFor(() => {
      expect(outputs).toEqual([
        {
          type: "error",
          agentSessionId: "agent-1",
          kind: "agent.run.failed",
          detail: "Unknown error (no error details in response)",
        },
      ]);
    });
  });

  it("uses fallback detail when a failed assistant turn has no error message", async () => {
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1", mode: "create", sessionState: createFakeHandle() });
    const outputs: AgentOutputEvent[] = [];

    await adapter.start((event) => {
      outputs.push(event);
    });

    rpcClients[0]?.emit({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error" },
    });

    await vi.waitFor(() => {
      expect(outputs[0]).toEqual({
        type: "error",
        agentSessionId: "agent-1",
        kind: "agent.run.failed",
        detail: "The agent run failed without additional error details.",
      });
    });
  });

  it("ignores assistant message_end without visible text or attachments", async () => {
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1", mode: "create", sessionState: createFakeHandle() });
    const outputs: AgentOutputEvent[] = [];

    await adapter.start((event) => {
      outputs.push(event);
    });

    rpcClients[0]?.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
        ],
      },
    });
    rpcClients[0]?.emit({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "aborted" },
    });

    expect(outputs).toEqual([]);
  });
});

describe("PiCodingAgentAdapter session working directory state", () => {
  let base: string;

  beforeEach(async () => {
    rpcClients.length = 0;
    base = await mkdtemp(path.join(os.tmpdir(), "pi-adapter-state-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("initializes persisted state with the canonical working directory and source before spawning", async () => {
    const dir = path.join(base, "project a 中文");
    await mkdir(dir, { recursive: true });
    const canonical = await realpath(dir);
    const { store, handle } = await makeCreateHandle("pi-coding-agent:t1");

    const adapter = new PiCodingAgentAdapter({
      agentSessionId: "pi-coding-agent:t1",
      mode: "create",
      sessionState: handle,
      workingDirectory: dir,
    });
    await adapter.start(() => {});

    expect(rpcClients[0]?.options.cwd).toBe(canonical);
    const document = await store.load();
    expect(document.agentSessions["pi-coding-agent:t1"]!.state).toEqual({
      version: 1,
      workingDirectory: canonical,
      workingDirectorySource: "user",
    });
  });

  it("persists the canonical default cwd for a bare /new", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-adapter-bare-"));
    const canonical = await realpath(dir);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    const { store, handle } = await makeCreateHandle("pi-coding-agent:bare");

    try {
      const adapter = new PiCodingAgentAdapter({
        agentSessionId: "pi-coding-agent:bare",
        mode: "create",
        sessionState: handle,
      });
      await adapter.start(() => {});

      expect(rpcClients[0]?.options.cwd).toBe(canonical);
      const document = await store.load();
      expect(document.agentSessions["pi-coding-agent:bare"]!.state).toEqual({
        version: 1,
        workingDirectory: canonical,
        workingDirectorySource: "default",
      });
    } finally {
      cwdSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resumes in the persisted directory even when process.cwd changed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-adapter-resume-"));
    const canonical = await realpath(dir);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/unrelated/elsewhere");
    const { handle } = await makeOpenHandle("pi-coding-agent:resume", {
      version: 1,
      workingDirectory: canonical,
      workingDirectorySource: "default",
    });

    try {
      const adapter = new PiCodingAgentAdapter({
        agentSessionId: "pi-coding-agent:resume",
        mode: "resume",
        sessionState: handle,
      });
      await adapter.start(() => {});

      // The persisted canonical directory wins over the (different) cwd.
      expect(rpcClients[0]?.options.cwd).toBe(canonical);
    } finally {
      cwdSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not rewrite canonical state when it is unchanged on resume", async () => {
    const dir = path.join(base, "stable");
    await mkdir(dir, { recursive: true });
    const canonical = await realpath(dir);
    const { store, handle } = await makeOpenHandle("pi-coding-agent:stable", {
      version: 1,
      workingDirectory: canonical,
      workingDirectorySource: "user",
    });

    const adapter = new PiCodingAgentAdapter({
      agentSessionId: "pi-coding-agent:stable",
      mode: "resume",
      sessionState: handle,
    });
    await adapter.start(() => {});

    expect(rpcClients[0]?.options.cwd).toBe(canonical);
    // updatedAt is untouched: no rewrite happened.
    const document = await store.load();
    expect(document.agentSessions["pi-coding-agent:stable"]!.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("enforces the user allowlist on resume for user-sourced directories", async () => {
    const root = path.join(base, "projects");
    await mkdir(root, { recursive: true });
    const outside = path.join(base, "outside");
    await mkdir(outside, { recursive: true });
    const { handle } = await makeOpenHandle("pi-coding-agent:user-out", {
      version: 1,
      workingDirectory: outside,
      workingDirectorySource: "user",
    });

    const adapter = new PiCodingAgentAdapter({
      agentSessionId: "pi-coding-agent:user-out",
      mode: "resume",
      sessionState: handle,
      allowedWorkingDirectoryRoots: [root],
    });

    await expect(adapter.start(() => {})).rejects.toThrow(/not inside an allowed root/);
    expect(rpcClients).toHaveLength(0);
    await expect(adapter.stop()).resolves.toBeUndefined();
  });

  it("does not apply the user allowlist on resume for default-sourced directories", async () => {
    const root = path.join(base, "projects");
    const outside = path.join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    const canonical = await realpath(outside);
    const { handle } = await makeOpenHandle("pi-coding-agent:default-out", {
      version: 1,
      workingDirectory: canonical,
      workingDirectorySource: "default",
    });

    const adapter = new PiCodingAgentAdapter({
      agentSessionId: "pi-coding-agent:default-out",
      mode: "resume",
      sessionState: handle,
      allowedWorkingDirectoryRoots: [root],
    });
    await adapter.start(() => {});

    expect(rpcClients[0]?.options.cwd).toBe(canonical);
  });

  it("upgrades a legacy migrated record with a working directory to canonical V1 on first resume", async () => {
    const dir = path.join(base, "legacy-user");
    await mkdir(dir, { recursive: true });
    const canonical = await realpath(dir);
    const { store, handle } = await makeOpenHandle("pi-coding-agent:legacy", {
      migratedFromBinding: true,
      workingDirectory: dir,
    });

    const adapter = new PiCodingAgentAdapter({
      agentSessionId: "pi-coding-agent:legacy",
      mode: "resume",
      sessionState: handle,
    });
    await adapter.start(() => {});

    expect(rpcClients[0]?.options.cwd).toBe(canonical);
    const document = await store.load();
    expect(document.agentSessions["pi-coding-agent:legacy"]!.state).toEqual({
      version: 1,
      workingDirectory: canonical,
      workingDirectorySource: "user",
    });
  });

  it("upgrades a legacy migrated record without a working directory to the current cwd as default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-adapter-legacy-bare-"));
    const canonical = await realpath(dir);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    // The registry.open eager decode must run while the cwd mock is active.
    const { store, handle } = await makeOpenHandle("pi-coding-agent:legacy-bare", {
      migratedFromBinding: true,
    });

    try {
      const adapter = new PiCodingAgentAdapter({
        agentSessionId: "pi-coding-agent:legacy-bare",
        mode: "resume",
        sessionState: handle,
      });
      await adapter.start(() => {});

      expect(rpcClients[0]?.options.cwd).toBe(canonical);
      const document = await store.load();
      expect(document.agentSessions["pi-coding-agent:legacy-bare"]!.state).toEqual({
        version: 1,
        workingDirectory: canonical,
        workingDirectorySource: "default",
      });
    } finally {
      cwdSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails before spawning when the working directory does not exist", async () => {
    const missing = path.join(base, "missing");
    const { handle } = await makeCreateHandle("pi-coding-agent:missing");

    const adapter = new PiCodingAgentAdapter({
      agentSessionId: "pi-coding-agent:missing",
      mode: "create",
      sessionState: handle,
      workingDirectory: missing,
    });

    await expect(adapter.start(() => {})).rejects.toThrow(/invalid working directory.*no such file or directory/);
    expect(rpcClients).toHaveLength(0);
    await expect(adapter.stop()).resolves.toBeUndefined();
  });

  it("fails before spawning when the working directory is not readable", async () => {
    // Root ignores permission bits, so skip the assertion in that environment.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    const dir = path.join(base, "locked");
    await mkdir(dir);
    await chmod(dir, 0o000);
    const { handle } = await makeCreateHandle("pi-coding-agent:locked");

    try {
      const adapter = new PiCodingAgentAdapter({
        agentSessionId: "pi-coding-agent:locked",
        mode: "create",
        sessionState: handle,
        workingDirectory: dir,
      });

      await expect(adapter.start(() => {})).rejects.toThrow(/invalid working directory.*permission denied/);
      expect(rpcClients).toHaveLength(0);
      await expect(adapter.stop()).resolves.toBeUndefined();
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it("cannot persist through a revoked handle", async () => {
    const { registry, handle } = await makeCreateHandle("pi-coding-agent:revoked");
    await registry.revoke("pi-coding-agent:revoked");

    const adapter = new PiCodingAgentAdapter({
      agentSessionId: "pi-coding-agent:revoked",
      mode: "create",
      sessionState: handle,
    });

    await expect(adapter.start(() => {})).rejects.toThrow(/revoked/);
    expect(rpcClients).toHaveLength(0);
  });

  describe("working directory TOCTOU hardening", () => {
    it("resolves a user-supplied directory exactly once and persists/spawns that checked result", async () => {
      const dir = path.join(base, "user-project");
      await mkdir(dir, { recursive: true });
      const canonical = await realpath(dir);
      const { store, handle } = await makeCreateHandle("pi-coding-agent:touctou-user");

      const realpathMock = vi.mocked(realpath);
      realpathMock.mockClear();
      // Arm a hypothetical second resolution: if the adapter ever re-resolved
      // the already-checked path (TOCTOU), this un-checked outside-allowlist
      // result would be what gets persisted and spawned. It must never fire.
      realpathMock.mockImplementationOnce(realpathState.realRealpath!);
      realpathMock.mockImplementationOnce(async () => "/tmp/outside-allowlist/evil");

      const adapter = new PiCodingAgentAdapter({
        agentSessionId: "pi-coding-agent:touctou-user",
        mode: "create",
        sessionState: handle,
        workingDirectory: dir,
      });
      await adapter.start(() => {});

      // Exactly one realpath: the helper's canonicalization. The adapter must
      // not re-resolve the returned path.
      expect(realpathMock).toHaveBeenCalledTimes(1);
      expect(rpcClients[0]?.options.cwd).toBe(canonical);
      const document = await store.load();
      expect(document.agentSessions["pi-coding-agent:touctou-user"]!.state).toEqual({
        version: 1,
        workingDirectory: canonical,
        workingDirectorySource: "user",
      });
    });

    it("canonicalizes the default cwd exactly once for a bare /new and persists it as default", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-adapter-bare-touctou-"));
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
      const { store, handle } = await makeCreateHandle("pi-coding-agent:touctou-default");

      try {
        const adapter = new PiCodingAgentAdapter({
          agentSessionId: "pi-coding-agent:touctou-default",
          mode: "create",
          sessionState: handle,
        });

        const realpathMock = vi.mocked(realpath);
        realpathMock.mockClear();
        await adapter.start(() => {});

        const canonical = await realpathState.realRealpath!(dir);
        expect(realpathMock).toHaveBeenCalledTimes(1);
        expect(rpcClients[0]?.options.cwd).toBe(canonical);
        const document = await store.load();
        expect(document.agentSessions["pi-coding-agent:touctou-default"]!.state).toEqual({
          version: 1,
          workingDirectory: canonical,
          workingDirectorySource: "default",
        });
      } finally {
        cwdSpy.mockRestore();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
