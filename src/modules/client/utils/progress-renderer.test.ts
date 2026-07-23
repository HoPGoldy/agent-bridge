import { describe, expect, it } from "vitest";
import { getTranslator } from "../../../i18n";
import { ProgressRenderer, type ProgressEvent } from "./progress-renderer";
import type { ClientInputEvent } from "../../../types";

describe("ProgressRenderer", () => {
  it("reports assistant.message and assistant.thinking as non-progress events", () => {
    const renderer = new ProgressRenderer();

    expect(
      renderer.isProgressEvent({
        type: "assistant.message",
        clientSessionId: "s1",
        text: "hi",
      }),
    ).toBe(false);
    expect(
      renderer.isProgressEvent({
        type: "assistant.thinking",
        clientSessionId: "s1",
        text: "Planning",
      }),
    ).toBe(false);
  });

  it("reports tool and compacting events as progress events", () => {
    const renderer = new ProgressRenderer();
    const events: ClientInputEvent[] = [
      { type: "session.compacting", clientSessionId: "s1" },
      { type: "assistant.tool.running", clientSessionId: "s1", toolName: "bash" },
      { type: "assistant.tool.update", clientSessionId: "s1", toolName: "bash" },
      { type: "assistant.tool.done", clientSessionId: "s1", toolName: "bash" },
      { type: "assistant.tool.error", clientSessionId: "s1", toolName: "bash" },
    ];

    for (const event of events) {
      expect(renderer.isProgressEvent(event)).toBe(true);
    }
  });

  it("renders an English placeholder when no progress has been recorded", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    expect(renderer.getCurrentProgress()).toEqual({
      markdown: "No progress yet.",
      status: "running",
      collapsedCount: 0,
      isEmpty: true,
    });
  });

  it("renders a Chinese placeholder when no progress has been recorded", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("zh-CN") });

    expect(renderer.getCurrentProgress()).toEqual({
      markdown: "暂无进度。",
      status: "running",
      collapsedCount: 0,
      isEmpty: true,
    });
  });

  it("formats legacy tool running/done/error and session.compacting lines in English", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });
    const events: ProgressEvent[] = [
      { type: "assistant.tool.running", clientSessionId: "s1", toolName: "web_search" },
      { type: "assistant.tool.done", clientSessionId: "s1", toolName: "bash" },
      { type: "assistant.tool.error", clientSessionId: "s1", toolName: "bash", text: "Failed bash" },
      { type: "session.compacting", clientSessionId: "s1", text: "trimming history" },
    ];

    for (const event of events) {
      renderer.takeProgressEvent(event);
    }

    const progress = renderer.getCurrentProgress();
    expect(progress.markdown).toBe(
      [
        "- Running web_search",
        "- Finished bash",
        "- Failed bash",
        "- Compacting session: trimming history",
      ].join("\n"),
    );
    expect(progress.status).toBe("running");
    expect(progress.collapsedCount).toBe(0);
  });

  it("dedupes redundant error text and falls back to a humanized message", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    renderer.takeProgressEvent({ type: "assistant.tool.error", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().markdown).toBe("- Failed bash");

    const renderer2 = new ProgressRenderer({ t: getTranslator("en-US") });
    renderer2.takeProgressEvent({
      type: "assistant.tool.error",
      clientSessionId: "s1",
      toolName: "bash",
      text: "bash",
    });
    expect(renderer2.getCurrentProgress().markdown).toBe("- Failed bash");

    const renderer3 = new ProgressRenderer({ t: getTranslator("en-US") });
    renderer3.takeProgressEvent({
      type: "assistant.tool.error",
      clientSessionId: "s1",
      toolName: "bash",
      text: "permission denied",
    });
    expect(renderer3.getCurrentProgress().markdown).toBe("- Failed bash: permission denied");
  });

  it("renders tool labels on error lines without appending a redundant generic failure suffix", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    renderer.takeProgressEvent({
      type: "assistant.tool.error",
      clientSessionId: "s1",
      toolName: "read",
      toolCallId: "call-1",
      toolLabel: "/home/leefoundy/demo.txt",
    });

    expect(renderer.getCurrentProgress().markdown).toBe("- Failed read: /home/leefoundy…");
  });

  it("updates the same tool row in place when toolCallId is present", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "bash",
      toolCallId: "call-1",
      toolLabel: "ls -la",
    });
    expect(renderer.getCurrentProgress().markdown).toBe("- Running bash: ls -la");

    renderer.takeProgressEvent({
      type: "assistant.tool.update",
      clientSessionId: "s1",
      toolName: "bash",
      toolCallId: "call-1",
      toolLabel: "ls -la",
    });
    expect(renderer.getCurrentProgress().markdown).toBe("- Running bash: ls -la");

    renderer.takeProgressEvent({
      type: "assistant.tool.done",
      clientSessionId: "s1",
      toolName: "bash",
      toolCallId: "call-1",
      toolLabel: "ls -la",
    });
    expect(renderer.getCurrentProgress().markdown).toBe("- Finished bash: ls -la");
  });

  it("truncates long tool labels in rendered progress", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "bash",
      toolCallId: "call-1",
      toolLabel: "12345678901234567890",
    });

    expect(renderer.getCurrentProgress().markdown).toBe("- Running bash: 123456789012345…");
  });

  it("tracks status across the most recent event", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    renderer.takeProgressEvent({ type: "assistant.tool.running", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().status).toBe("running");

    renderer.takeProgressEvent({ type: "assistant.tool.update", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().status).toBe("running");

    renderer.takeProgressEvent({ type: "assistant.tool.done", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().status).toBe("done");

    renderer.takeProgressEvent({ type: "assistant.tool.error", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().status).toBe("error");
  });

  it("keeps tool row order stable when a tool status updates", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "a",
      toolCallId: "call-a",
    });
    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "b",
      toolCallId: "call-b",
    });
    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "c",
      toolCallId: "call-c",
    });

    renderer.takeProgressEvent({
      type: "assistant.tool.done",
      clientSessionId: "s1",
      toolName: "b",
      toolCallId: "call-b",
    });

    expect(renderer.getCurrentProgress().markdown).toBe(
      ["- Running a", "- Finished b", "- Running c"].join("\n"),
    );
  });

  it("collapses lines beyond the default threshold of 10", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    for (let index = 1; index <= 12; index += 1) {
      renderer.takeProgressEvent({
        type: "assistant.tool.running",
        clientSessionId: "s1",
        toolName: `tool_${index}`,
      });
    }

    const progress = renderer.getCurrentProgress();
    expect(progress.collapsedCount).toBe(2);
    expect(progress.markdown).toBe(
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

  it("honors a custom collapseThreshold", () => {
    const renderer = new ProgressRenderer({ collapseThreshold: 2, t: getTranslator("en-US") });

    renderer.takeProgressEvent({ type: "assistant.tool.running", clientSessionId: "s1", toolName: "a" });
    renderer.takeProgressEvent({ type: "assistant.tool.running", clientSessionId: "s1", toolName: "b" });
    renderer.takeProgressEvent({ type: "assistant.tool.running", clientSessionId: "s1", toolName: "c" });

    const progress = renderer.getCurrentProgress();
    expect(progress.collapsedCount).toBe(1);
    expect(progress.markdown).toBe(
      ["- Collapsed 1 earlier updates.", "- Running b", "- Running c"].join("\n"),
    );
  });

  it("renders progress lines in Chinese when configured", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("zh-CN") });
    const events: ProgressEvent[] = [
      { type: "assistant.tool.running", clientSessionId: "s1", toolName: "web_search" },
      { type: "assistant.tool.done", clientSessionId: "s1", toolName: "bash" },
      { type: "assistant.tool.error", clientSessionId: "s1", toolName: "read", toolLabel: "/tmp/demo.txt" },
      { type: "session.compacting", clientSessionId: "s1", text: "压缩上下文" },
    ];

    for (const event of events) {
      renderer.takeProgressEvent(event);
    }

    expect(renderer.getCurrentProgress().markdown).toBe(
      ["- 正在执行 web_search", "- 已完成 bash", "- read: /tmp/demo.txt 执行失败", "- 正在压缩会话: 压缩上下文"].join(
        "\n",
      ),
    );
  });
});
