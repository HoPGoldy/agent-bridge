import { describe, expect, it } from "vitest";
import { getTranslator } from "../../../i18n";
import { renderStatusMarkdown } from "./status-markdown";

describe("renderStatusMarkdown", () => {
  it("renders localized markdown for agent.status.info", () => {
    const markdown = renderStatusMarkdown(
      {
        type: "agent.status.info",
        clientSessionId: "client-1",
        status: {
          sessionId: "agent-1",
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          thinkingLevel: "medium",
          context: {
            tokens: 60000,
            contextWindow: 200000,
            percent: 30,
          },
        },
      },
      getTranslator("en-US"),
    );

    expect(markdown).toBe(
      [
        "**Current session status**",
        "",
        "- Session ID: `agent-1`",
        "- Model: `anthropic/claude-sonnet-4-5`",
        "- Thinking level: `medium`",
        "- Context: `60,000 / 200,000 (30%)`",
      ].join("\n"),
    );
  });

  it("renders unavailable status errors in Chinese and includes optional detail", () => {
    const markdown = renderStatusMarkdown(
      {
        type: "error",
        clientSessionId: "client-1",
        kind: "agent.status.unavailable",
        detail: "RPC timeout",
      },
      getTranslator("zh-CN"),
    );

    expect(markdown).toBe(["**当前无法获取会话状态。**", "", "RPC timeout"].join("\n"));
  });

  it("returns null for unrelated client input events", () => {
    const markdown = renderStatusMarkdown(
      {
        type: "assistant.tool.running",
        clientSessionId: "client-1",
        toolName: "bash",
      },
      getTranslator("en-US"),
    );

    expect(markdown).toBeNull();
  });
});
