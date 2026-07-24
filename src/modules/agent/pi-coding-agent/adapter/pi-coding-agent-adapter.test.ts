import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentOutputEvent } from "../../../../types";

const rpcClients: Array<{
  emit: (event: { type: string; [key: string]: unknown }) => void;
}> = [];

let mockedState: {
  sessionId?: string;
  sessionName?: string;
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
} = { sessionId: "agent-1", sessionName: "agent-1" };

let mockedSessionStats: {
  contextUsage?: { tokens?: number | null; contextWindow?: number | null; percent?: number | null };
} = {};

vi.mock("./pi-rpc-client", () => {
  return {
    PiRpcClient: class FakePiRpcClient {
      #listener: ((event: { type: string; [key: string]: unknown }) => void) | null = null;

      constructor() {
        rpcClients.push({
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

      async abort(): Promise<void> {}

      async prompt(): Promise<void> {}

      async compact(): Promise<{ estimatedTokensAfter?: number; summary?: string }> {
        return {};
      }

      async getState(): Promise<{
        sessionId?: string;
        sessionName?: string;
        model?: { provider?: string; id?: string };
        thinkingLevel?: string;
      }> {
        return mockedState;
      }

      async getSessionStats(): Promise<{
        contextUsage?: { tokens?: number | null; contextWindow?: number | null; percent?: number | null };
      }> {
        return mockedSessionStats;
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
});

describe("PiCodingAgentAdapter", () => {
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

    expect(outputs).toEqual([]);
  });
});
