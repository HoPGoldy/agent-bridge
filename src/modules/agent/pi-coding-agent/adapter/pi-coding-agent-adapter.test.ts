import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentOutputEvent } from "../../../../types";

const rpcClients: Array<{
  emit: (event: { type: string; [key: string]: unknown }) => void;
}> = [];

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
    },
  };
});

import { PiCodingAgentAdapter } from "./pi-coding-agent-adapter";

afterEach(() => {
  rpcClients.length = 0;
});

describe("PiCodingAgentAdapter", () => {
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
