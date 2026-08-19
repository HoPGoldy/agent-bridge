import { describe, expect, it } from "vitest";
import {
  DONE_MARKER,
  buildProbeMessage,
  buildTaskPrompt,
  classifyMessage,
} from "./protocol";

describe("DONE_MARKER", () => {
  it("is the agreed fixed marker string", () => {
    expect(DONE_MARKER).toBe("BRIDGE_TASK_STATUS_DONE");
  });
});

describe("buildTaskPrompt", () => {
  it("appends the protocol block containing the marker and the async-waiting instruction", () => {
    const wrapped = buildTaskPrompt("", "do the thing");
    expect(wrapped).toContain("do the thing");
    expect(wrapped).toContain(DONE_MARKER);
    // The async-waiting instruction: fully done includes async follow-ups.
    expect(wrapped).toContain("async follow-ups");
    // Honesty clause for the probe Q&A.
    expect(wrapped.toLowerCase()).toContain("honestly");
    // Final-message placement instruction.
    expect(wrapped).toContain("last line");
  });

  it("places a non-empty queue body before the task prompt", () => {
    const wrapped = buildTaskPrompt("Shared context.\nSecond line.", "do the thing");
    expect(wrapped.indexOf("Shared context.")).toBeLessThan(wrapped.indexOf("do the thing"));
    expect(wrapped).toContain("Second line.");
  });

  it("omits the body slot entirely when the body is blank", () => {
    const wrapped = buildTaskPrompt("   \n\t", "do the thing");
    expect(wrapped.startsWith("do the thing")).toBe(true);
  });

  it("is deterministic for identical inputs", () => {
    expect(buildTaskPrompt("b", "p")).toBe(buildTaskPrompt("b", "p"));
  });
});

describe("buildProbeMessage", () => {
  it("mentions the silent minutes, the marker, and continuing / waiting", () => {
    const message = buildProbeMessage(10);
    expect(message).toContain("10 minutes");
    expect(message).toContain(DONE_MARKER);
    expect(message).toContain("last line");
    expect(message).toContain("continue working");
    expect(message).toContain("async callbacks");
  });
});

describe("classifyMessage", () => {
  it("detects a marker-only final line and returns empty content", () => {
    expect(classifyMessage(`working...\n\n${DONE_MARKER}`)).toEqual({
      done: true,
      content: "working...",
    });
  });

  it("detects a bare marker-only message (empty content after strip)", () => {
    expect(classifyMessage(DONE_MARKER)).toEqual({ done: true, content: "" });
  });

  it("tolerates trailing whitespace after the marker", () => {
    expect(classifyMessage(`done\n${DONE_MARKER}   \t`)).toEqual({
      done: true,
      content: "done",
    });
  });

  it("tolerates trailing blank lines after the marker line", () => {
    expect(classifyMessage(`done\n${DONE_MARKER}\n\n\n`)).toEqual({
      done: true,
      content: "done",
    });
  });

  it("accepts the marker anywhere in the last non-empty line", () => {
    expect(classifyMessage(`All tests green. ${DONE_MARKER}`)).toEqual({
      done: true,
      content: "",
    });
  });

  it("finds the marker on the last non-empty line even with blank lines after it", () => {
    expect(classifyMessage(`result\n\n${DONE_MARKER}\n\n`)).toEqual({
      done: true,
      content: "result",
    });
  });

  it("normalizes CRLF", () => {
    expect(classifyMessage(`partial output\r\n${DONE_MARKER}\r\n`)).toEqual({
      done: true,
      content: "partial output",
    });
  });

  it("does NOT classify a marker mid-text (earlier line) as done", () => {
    const text = `${DONE_MARKER}\nbut actually still working`;
    expect(classifyMessage(text)).toEqual({ done: false, content: text });
  });

  it("does not classify a substring/misspelled marker", () => {
    expect(classifyMessage(`BRIDGE_TASK_STATUS\n${DONE_MARKER.toLowerCase()}`).done).toBe(false);
    expect(classifyMessage(`BRIDGE_TASK_STATUS_PARTIALLY_DONE`).done).toBe(false);
  });

  it("passes plain text through unchanged (not done)", () => {
    const text = "still working on it\nwill continue";
    expect(classifyMessage(text)).toEqual({ done: false, content: text });
  });

  it("keeps earlier content lines when stripping the marker line", () => {
    const result = classifyMessage(`line one\nline two\n${DONE_MARKER}`);
    expect(result).toEqual({ done: true, content: "line one\nline two" });
  });
});
