import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentOutputEvent } from "../../../../types";

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

afterEach(() => {
  rpcClients.length = 0;
  mockedState = { sessionId: "agent-1", sessionName: "agent-1" };
  mockedSessionStats = {};
  mockedAvailableModels = [];
  setModelCalls = [];
  promptCalls = [];
  abortCalls = 0;
});

describe("PiCodingAgentAdapter", () => {
  it("delegates busy-message steering to Pi and tracks the run until it settles", async () => {
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1" });

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

  it("forwards the configured cwd to the pi RPC client", async () => {
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1", cwd: "/tmp/workspace" });

    await adapter.start(() => {});

    expect(rpcClients[0]?.options).toEqual(
      expect.objectContaining({ cwd: "/tmp/workspace", agentSessionId: "agent-1" }),
    );
  });

  it("forwards tool execution events with tool ids and labels but without generic display text", async () => {
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1" });
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
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1" });
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

    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1" });

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

    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1" });

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

    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1" });

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

    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1" });

    await adapter.start(() => {});

    await expect(adapter.setModel?.("anthropic/claude-sonnet-4-5")).rejects.toMatchObject({
      kind: "agent.model.busy",
    });
    expect(setModelCalls).toEqual([]);
  });

  it("forwards assistant text from Pi message_end text blocks", async () => {
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1" });
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
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1" });
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
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1" });
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
    const adapter = new PiCodingAgentAdapter({ agentSessionId: "agent-1" });
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
