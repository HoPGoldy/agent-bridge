import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_HISTORY_DIR } from "../../config/channel-state";
import type { Logger } from "../../core/logger";
import {
  appendRunHistory,
  readRunHistory,
  runHistoryFilePath,
  type RunHistoryRecord,
} from "./history";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-run-history-"));
  tmpDirs.push(dir);
  return dir;
}

/** Logger fake whose warns the tests can assert on. */
function makeLogger(): Logger & { warns: unknown[][] } {
  const warns: unknown[][] = [];
  return {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warns,
    warn: (...args: unknown[]) => {
      warns.push(args);
    },
  };
}

function makeRecord(overrides: Partial<RunHistoryRecord> = {}): RunHistoryRecord {
  return {
    runId: "schedule:report:20260820-090000-1",
    ts: "2026-08-20T01:00:00.000Z",
    ms: 252_000,
    outcome: "completed",
    channel: "feishu-dev",
    file: "/home/wesley/.config/agent-bridge/run-outputs/schedule_report_20260820-090000-1.md",
    ...overrides,
  };
}

describe("runHistoryFilePath", () => {
  it("defaults to the shared RUN_HISTORY_DIR and routes kinds to separate files", () => {
    expect(runHistoryFilePath("schedule")).toBe(path.join(RUN_HISTORY_DIR, "schedule.jsonl"));
    expect(runHistoryFilePath("queue")).toBe(path.join(RUN_HISTORY_DIR, "queue.jsonl"));
  });

  it("uses the provided root when given", () => {
    expect(runHistoryFilePath("queue", "/tmp/hist")).toBe("/tmp/hist/queue.jsonl");
  });
});

describe("appendRunHistory", () => {
  it("writes one JSON line per record and appends (never truncates)", async () => {
    const root = await makeRoot();
    const first = makeRecord();
    const second = makeRecord({
      runId: "schedule:report:20260820-090500-2",
      outcome: "failed",
      reason: "boom",
    });

    await appendRunHistory("schedule", first, root);
    await appendRunHistory("schedule", second, root);

    const content = await readFile(path.join(root, "schedule.jsonl"), "utf8");
    const lines = content.split("\n");
    expect(lines).toHaveLength(3); // two records + trailing newline
    expect(lines[0]).toBe(JSON.stringify(first));
    expect(lines[1]).toBe(JSON.stringify(second));
    expect(lines[2]).toBe("");
  });

  it("routes kinds to different files under the same root", async () => {
    const root = await makeRoot();
    await appendRunHistory("schedule", makeRecord(), root);
    await appendRunHistory("queue", makeRecord({ runId: "queue:build:1700000000-ab12" }), root);

    expect((await readRunHistory("schedule", root)).map((r) => r.runId)).toEqual([
      "schedule:report:20260820-090000-1",
    ]);
    expect((await readRunHistory("queue", root)).map((r) => r.runId)).toEqual([
      "queue:build:1700000000-ab12",
    ]);
  });

  it("creates the directory lazily (nested root)", async () => {
    const root = await makeRoot();
    const nested = path.join(root, "run-history", "deep");
    await appendRunHistory("schedule", makeRecord(), nested);
    await expect(stat(path.join(nested, "schedule.jsonl"))).resolves.toBeDefined();
  });

  it("never throws on an unwritable root, only warns through the logger", async () => {
    const root = await makeRoot();
    // Occupy the path the writer wants to mkdir with a regular FILE: the
    // recursive mkdir then fails with ENOTDIR (and the append with ENOTDIR),
    // exercising the swallow-everything contract without needing root-owned
    // directories or permission tricks.
    const blocker = path.join(root, "blocked");
    await writeFile(blocker, "not a directory", "utf8");

    const logger = makeLogger();
    await expect(
      appendRunHistory("schedule", makeRecord(), path.join(blocker, "run-history"), logger),
    ).resolves.toBeUndefined();
    expect(logger.warns.length).toBeGreaterThan(0);
    expect(logger.warns[0]![0]).toContain("failed to append schedule history line");
  });
});

describe("readRunHistory", () => {
  it("returns an empty array when the file does not exist", async () => {
    const root = await makeRoot();
    await expect(readRunHistory("schedule", root)).resolves.toEqual([]);
  });

  it("throws on non-ENOENT read errors (the path is a directory → EISDIR)", async () => {
    const root = await makeRoot();
    // Occupy the history file's path with a DIRECTORY: reading it fails with
    // EISDIR, which is not the missing-file case — the reader must let the
    // error propagate to the caller instead of masking it as an empty list.
    await mkdir(path.join(root, "schedule.jsonl"), { recursive: true });

    await expect(readRunHistory("schedule", root)).rejects.toThrow();
    await expect(readRunHistory("schedule", root)).rejects.toMatchObject({
      code: expect.stringMatching(/EISDIR|ERR_FS_EISDIR/),
    });
  });

  it("round-trips written records with optional fields intact", async () => {
    const root = await makeRoot();
    const completed = makeRecord();
    const failed = makeRecord({
      runId: "queue:build:1700000000-ab12",
      outcome: "fire-failed",
      reason: "boom: model not available",
      agent: "pi-coding-agent:a8b7c75f-ebd9-4dac-8300-df779cdc1bae",
      ms: 1_500,
    });
    await appendRunHistory("queue", completed, root);
    await appendRunHistory("queue", failed, root);

    await expect(readRunHistory("queue", root)).resolves.toEqual([completed, failed]);
  });

  it("skips malformed and invalid lines, keeping the good ones", async () => {
    const root = await makeRoot();
    const good = makeRecord();
    const lines = [
      JSON.stringify(good), // good
      "{not json", // unparseable
      JSON.stringify({ runId: "x", ts: "2026-08-20T01:00:00.000Z" }), // missing required fields
      JSON.stringify({ ...good, ms: "252000" }), // wrong type: ms as string
      JSON.stringify({ ...good, outcome: "mystery" }), // unknown outcome
      JSON.stringify({ ...good, agent: 42 }), // wrong type: optional agent as number
      "", // empty line (trailing newline)
    ].join("\n");
    await writeFile(path.join(root, "schedule.jsonl"), `${lines}\n`, "utf8");

    const logger = makeLogger();
    await expect(readRunHistory("schedule", root, logger)).resolves.toEqual([good]);
    expect(logger.warns.length).toBe(5);
  });

  it("keeps a record whose optional reason is present but agent absent", async () => {
    const root = await makeRoot();
    const timedOut = makeRecord({ outcome: "timeout", reason: "exceeded 10m" });
    await appendRunHistory("schedule", timedOut, root);
    const [record] = await readRunHistory("schedule", root);
    expect(record).toEqual(timedOut);
    expect("agent" in record).toBe(false);
    expect("reason" in record).toBe(true);
  });
});
