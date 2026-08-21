import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_OUTPUTS_DIR } from "../../config/channel-state";
import { createRunAccumulator, sanitizeSessionId } from "./accumulator";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function makeOutputsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-run-outputs-"));
  tmpDirs.push(dir);
  return dir;
}

describe("sanitizeSessionId", () => {
  it("maps a synthetic run id to a safe file stem", () => {
    expect(sanitizeSessionId("schedule:nightly-report:3")).toBe(
      "schedule_nightly-report_3",
    );
    expect(sanitizeSessionId("queue:builds:1700000000-ab12")).toBe(
      "queue_builds_1700000000-ab12",
    );
  });

  it("replaces every character outside [A-Za-z0-9._-] and bounds the length", () => {
    expect(sanitizeSessionId("a/b\\c d?e")).toBe("a_b_c_d_e");
    expect(sanitizeSessionId("x".repeat(300))).toHaveLength(128);
  });
});

describe("createRunAccumulator", () => {
  it("defaults to the shared RUN_OUTPUTS_DIR root with the sanitized stem", () => {
    const accumulator = createRunAccumulator({ sessionId: "schedule:t:1" });
    expect(accumulator.filePath).toBe(
      path.join(RUN_OUTPUTS_DIR, "schedule_t_1.md"),
    );
  });

  it("appends many messages in order and readAll returns them all", async () => {
    const dir = await makeOutputsDir();
    const accumulator = createRunAccumulator({ sessionId: "schedule:t:1", outputsDir: dir });

    for (let i = 1; i <= 50; i++) {
      await accumulator.append(`message ${i}`);
    }
    await accumulator.append("final with marker", [
      { kind: "file", filePath: "/tmp/report.pdf", fileName: "report.pdf" },
      { kind: "image", filePath: "/tmp/chart.png" },
    ]);

    const all = await accumulator.readAll();
    expect(all.startsWith("message 1\n\nmessage 2\n\n")).toBe(true);
    expect(all.endsWith("final with marker\n\n")).toBe(true);
    for (let i = 1; i <= 50; i++) {
      expect(all).toContain(`message ${i}\n`);
    }

    expect(accumulator.collectedAttachments).toEqual([
      { filePath: "/tmp/report.pdf", fileName: "report.pdf" },
      { filePath: "/tmp/chart.png" },
    ]);
    // lastMessage tracks the most recently appended message (marker already
    // stripped by the caller) — what a controller delivers.
    expect(accumulator.lastMessage).toBe("final with marker");
  });

  it("tracks lastMessage across appends (last write wins)", async () => {
    const dir = await makeOutputsDir();
    const accumulator = createRunAccumulator({ sessionId: "schedule:t:9", outputsDir: dir });
    expect(accumulator.lastMessage).toBe("");
    await accumulator.append("first");
    expect(accumulator.lastMessage).toBe("first");
    await accumulator.append("");
    expect(accumulator.lastMessage).toBe("");
    await accumulator.append("third");
    expect(accumulator.lastMessage).toBe("third");
  });

  it("writes the file under the outputs dir (created lazily)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-run-outputs-root-"));
    tmpDirs.push(root);
    const dir = path.join(root, "run-outputs"); // does not exist yet
    const accumulator = createRunAccumulator({ sessionId: "queue:q:1-a", outputsDir: dir });

    await accumulator.append("hello");
    const info = await stat(accumulator.filePath);
    expect(info.isFile()).toBe(true);
    expect(await readFile(accumulator.filePath, "utf8")).toBe("hello\n\n");
  });

  it("accumulates across concurrent appends without losing messages", async () => {
    const dir = await makeOutputsDir();
    const accumulator = createRunAccumulator({ sessionId: "queue:q:1-a", outputsDir: dir });

    await Promise.all(
      Array.from({ length: 30 }, (_, i) => accumulator.append(`m${i}`)),
    );
    const all = await accumulator.readAll();
    for (let i = 0; i < 30; i++) {
      expect(all).toContain(`m${i}\n`);
    }
    // Every message separator survived: 30 blocks of "m<i>\n\n".
    expect((all.match(/\n\n/g) ?? []).length).toBe(30);
  });

  it("readAll on a fresh accumulator returns an empty string (no file)", async () => {
    const dir = await makeOutputsDir();
    const accumulator = createRunAccumulator({ sessionId: "queue:q:9-z", outputsDir: dir });
    expect(await accumulator.readAll()).toBe("");
  });

  it("readAll is unaffected by foreign file content and never throws on ENOENT", async () => {
    const dir = await makeOutputsDir();
    const a = createRunAccumulator({ sessionId: "queue:q:1-a", outputsDir: dir });
    await a.append("mine");
    // A sibling file must not interfere.
    await writeFile(path.join(dir, "other.md"), "not mine", "utf8");
    expect(await a.readAll()).toBe("mine\n\n");
  });

  // T2 decision: accumulation files are KEPT after delivery and on stop —
  // there is no dispose(). The file is a durable transcript that the delivery
  // suffix references.

  it("collects attachments from every message in arrival order", async () => {
    const dir = await makeOutputsDir();
    const accumulator = createRunAccumulator({ sessionId: "queue:q:3-c", outputsDir: dir });
    await accumulator.append("with image", [
      { kind: "image", filePath: "/tmp/a.png", fileName: "a.png" },
    ]);
    await accumulator.append("no attachments");
    await accumulator.append("with file", [{ kind: "file", filePath: "/tmp/b.zip" }]);

    expect(accumulator.collectedAttachments).toEqual([
      { filePath: "/tmp/a.png", fileName: "a.png" },
      { filePath: "/tmp/b.zip" },
    ]);
    // Attachment metadata never leaks into the accumulated text.
    expect(await accumulator.readAll()).not.toContain("/tmp/a.png");
  });
});

describe("writeHeader (run-history spec D6)", () => {
  it("creates the directory and file with the header content, followed by appends", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-run-outputs-root-"));
    tmpDirs.push(root);
    const dir = path.join(root, "run-outputs"); // does not exist yet
    const accumulator = createRunAccumulator({ sessionId: "schedule:t:1", outputsDir: dir });

    const header = [
      "---",
      "runId: schedule:t:1",
      "channel: feishu-dev",
      "---",
      "# Prompt",
      "",
      "do the thing",
      "",
      "---",
      "",
    ].join("\n");
    await accumulator.writeHeader(`${header}\n`);
    await accumulator.append("first assistant message");

    const content = await readFile(accumulator.filePath, "utf8");
    // The header sits at the very start and the message follows it.
    expect(content.startsWith(header)).toBe(true);
    expect(content).toBe(`${header}\nfirst assistant message\n\n`);
  });

  it("normalizes the header tail to exactly one blank line before the first append", async () => {
    const dir = await makeOutputsDir();
    const a = createRunAccumulator({ sessionId: "schedule:t:2", outputsDir: dir });
    await a.writeHeader("---\nrunId: schedule:t:2\n---\n# Prompt\n\ndo it\n\n---\n\n");
    await a.append("msg");
    expect(await a.readAll()).toBe(
      "---\nrunId: schedule:t:2\n---\n# Prompt\n\ndo it\n\n---\n\nmsg\n\n",
    );

    // No trailing newline at all: one is added so the header stays separated.
    const b = createRunAccumulator({ sessionId: "schedule:t:3", outputsDir: dir });
    await b.writeHeader("---\nrunId: schedule:t:3\n---");
    await b.append("msg");
    expect(await b.readAll()).toBe("---\nrunId: schedule:t:3\n---\n\nmsg\n\n");
  });

  it("throws on a second writeHeader and on a writeHeader after an append", async () => {
    const dir = await makeOutputsDir();
    const accumulator = createRunAccumulator({ sessionId: "schedule:t:4", outputsDir: dir });

    await accumulator.writeHeader("---\nrunId: schedule:t:4\n---\n");
    await expect(accumulator.writeHeader("---\nagain\n---\n")).rejects.toThrow(
      /already written/,
    );

    const second = createRunAccumulator({ sessionId: "schedule:t:5", outputsDir: dir });
    await second.append("message first");
    await expect(second.writeHeader("---\nrunId: schedule:t:5\n---\n")).rejects.toThrow(
      /before any append/,
    );
    // The failed header did not reach the file: only the message is there.
    expect(await second.readAll()).toBe("message first\n\n");
  });
});
