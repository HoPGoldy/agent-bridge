import { describe, expect, it } from "vitest";
import { getTranslator } from "../../../i18n";
import { renderStatusMarkdown } from "./status-markdown";

describe("renderStatusMarkdown", () => {
  it("renders localized markdown for agent.model.list", () => {
    const markdown = renderStatusMarkdown(
      {
        type: "agent.model.list",
        clientSessionId: "client-1",
        models: [
          { provider: "anthropic", modelId: "claude-sonnet-4-5", isCurrent: true },
          { provider: "openai", modelId: "gpt-5", isCurrent: false },
        ],
      },
      getTranslator("en-US"),
    );

    expect(markdown).toBe(
      [
        "**Available models**",
        "",
        "- `anthropic/claude-sonnet-4-5` ✅ current",
        "- `openai/gpt-5`",
        "",
        "Use `/model provider/modelId` to switch.",
      ].join("\n"),
    );
  });

  it("renders localized markdown for agent.model.updated", () => {
    const markdown = renderStatusMarkdown(
      {
        type: "agent.model.updated",
        clientSessionId: "client-1",
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      },
      getTranslator("zh-CN"),
    );

    expect(markdown).toBe("当前模型已切换至 `anthropic/claude-sonnet-4-5`。");
  });

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

  it("renders status and model errors in Chinese and includes optional detail", () => {
    const statusMarkdown = renderStatusMarkdown(
      {
        type: "error",
        clientSessionId: "client-1",
        kind: "agent.status.unavailable",
        detail: "RPC timeout",
      },
      getTranslator("zh-CN"),
    );

    expect(statusMarkdown).toBe(["**当前无法获取会话状态。**", "", "RPC timeout"].join("\n"));

    const modelMarkdown = renderStatusMarkdown(
      {
        type: "error",
        clientSessionId: "client-1",
        kind: "agent.model.busy",
      },
      getTranslator("zh-CN"),
    );

    expect(modelMarkdown).toBe("当前正在运行，无法切换模型。请先使用 `/stop`。");
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
