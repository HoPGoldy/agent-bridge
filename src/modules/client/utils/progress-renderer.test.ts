import { describe, expect, it } from "vitest";
import { NO_PROGRESS_MARKDOWN, ProgressRenderer, type ProgressEvent } from "./progress-renderer";
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

  it("renders a placeholder when no progress has been recorded", () => {
    const renderer = new ProgressRenderer();

    expect(renderer.getCurrentProgress()).toEqual({
      markdown: NO_PROGRESS_MARKDOWN,
      status: "running",
      collapsedCount: 0,
    });
  });

  it("formats legacy tool running/done/error and session.compacting lines", () => {
    const renderer = new ProgressRenderer();
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
    const renderer = new ProgressRenderer();

    renderer.takeProgressEvent({ type: "assistant.tool.error", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().markdown).toBe("- Failed bash");

    const renderer2 = new ProgressRenderer();
    renderer2.takeProgressEvent({
      type: "assistant.tool.error",
      clientSessionId: "s1",
      toolName: "bash",
      text: "bash",
    });
    expect(renderer2.getCurrentProgress().markdown).toBe("- Failed bash");

    const renderer3 = new ProgressRenderer();
    renderer3.takeProgressEvent({
      type: "assistant.tool.error",
      clientSessionId: "s1",
      toolName: "bash",
      text: "permission denied",
    });
    expect(renderer3.getCurrentProgress().markdown).toBe("- Failed bash: permission denied");
  });

  it("updates the same tool row in place when toolCallId is present", () => {
    const renderer = new ProgressRenderer();

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
    const renderer = new ProgressRenderer();

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
    const renderer = new ProgressRenderer();

    renderer.takeProgressEvent({ type: "assistant.tool.running", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().status).toBe("running");

    renderer.takeProgressEvent({ type: "assistant.tool.update", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().status).toBe("running");

    renderer.takeProgressEvent({ type: "assistant.tool.done", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().status).toBe("done");

    renderer.takeProgressEvent({ type: "assistant.tool.error", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().status).toBe("error");
  });

  it("moves an updated tool row to the end so recent activity stays visible", () => {
    const renderer = new ProgressRenderer({ collapseThreshold: 2 });

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

    expect(renderer.getCurrentProgress().markdown).toBe(["- Collapsed 1 earlier updates.", "- Running b", "- Running c"].join("\n"));

    renderer.takeProgressEvent({
      type: "assistant.tool.done",
      clientSessionId: "s1",
      toolName: "a",
      toolCallId: "call-a",
    });

    expect(renderer.getCurrentProgress().markdown).toBe(["- Collapsed 1 earlier updates.", "- Running c", "- Finished a"].join("\n"));
  });

  it("collapses lines beyond the default threshold of 10", () => {
    const renderer = new ProgressRenderer();

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
    const renderer = new ProgressRenderer({ collapseThreshold: 2 });

    renderer.takeProgressEvent({ type: "assistant.tool.running", clientSessionId: "s1", toolName: "a" });
    renderer.takeProgressEvent({ type: "assistant.tool.running", clientSessionId: "s1", toolName: "b" });
    renderer.takeProgressEvent({ type: "assistant.tool.running", clientSessionId: "s1", toolName: "c" });

    const progress = renderer.getCurrentProgress();
    expect(progress.collapsedCount).toBe(1);
    expect(progress.markdown).toBe(
      ["- Collapsed 1 earlier updates.", "- Running b", "- Running c"].join("\n"),
    );
  });
});
