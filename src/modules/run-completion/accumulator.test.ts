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

  it("dispose deletes the accumulation file and is idempotent", async () => {
    const dir = await makeOutputsDir();
    const accumulator = createRunAccumulator({ sessionId: "schedule:t:1", outputsDir: dir });
    await accumulator.append("temp");
    await accumulator.dispose();
    await expect(stat(accumulator.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(accumulator.dispose()).resolves.toBeUndefined();
  });

  it("dispose does not touch sibling files", async () => {
    const dir = await makeOutputsDir();
    const a = createRunAccumulator({ sessionId: "queue:q:1-a", outputsDir: dir });
    const b = createRunAccumulator({ sessionId: "queue:q:2-b", outputsDir: dir });
    await a.append("a");
    await b.append("b");
    await a.dispose();
    expect(await b.readAll()).toBe("b\n\n");
  });

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
