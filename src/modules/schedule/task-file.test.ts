import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  getSchedulesDir,
  isValidTaskName,
  loadChannelTasks,
  parseTaskFile,
  setTaskTarget,
} from "./task-file";

const WELL_FORMED = `---
schedule: daily 09:00
directory: ~/reports
timeout: 30m
enabled: true
target: feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc
---

Read the logs and produce a summary of yesterday's errors.
`;

describe("isValidTaskName", () => {
  it("accepts lowercase slugs and rejects everything else", () => {
    expect(isValidTaskName("daily-report")).toBe(true);
    expect(isValidTaskName("a1-b2")).toBe(true);
    expect(isValidTaskName("Daily")).toBe(false);
    expect(isValidTaskName("daily_report")).toBe(false);
    expect(isValidTaskName("daily.report")).toBe(false);
    expect(isValidTaskName("")).toBe(false);
  });
});

describe("parseTaskFile", () => {
  it("parses a well-formed task file", () => {
    const { task, errors, warnings } = parseTaskFile("report.md", WELL_FORMED);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(task).toEqual({
      name: "report",
      scheduleRaw: "daily 09:00",
      schedule: { type: "daily", hour: 9, minute: 0 },
      directory: "~/reports",
      timeoutMs: 30 * 60_000,
      enabled: true,
      target: "feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc",
      prompt: "Read the logs and produce a summary of yesterday's errors.",
    });
  });

  it("applies defaults: timeout 10m, enabled true, optional keys absent", () => {
    const { task, errors } = parseTaskFile(
      "minimal.md",
      "---\nschedule: every 30m\n---\nDo the thing.\n",
    );
    expect(errors).toEqual([]);
    expect(task.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(task.enabled).toBe(true);
    expect(task.directory).toBeUndefined();
    expect(task.target).toBeUndefined();
    expect(task.schedule).toEqual({ type: "every", intervalMs: 30 * 60_000 });
  });

  it("treats a file without front matter as an all-body prompt and flags the missing schedule", () => {
    const content = "Just a prompt, no front matter at all.\nSecond line.\n";
    const { task, errors, warnings } = parseTaskFile("nofm.md", content);
    expect(errors).toEqual(['missing required front matter key "schedule"']);
    expect(warnings).toEqual([]);
    expect(task.prompt).toBe("Just a prompt, no front matter at all.\nSecond line.");
    expect(task.schedule).toBeNull();
  });

  it("strips surrounding single and double quotes from values", () => {
    const content = `---
schedule: "daily 09:00"
directory: '~/quoted dir'
timeout: "20m"
target: 'feishu:dm:oc_123'
---

Body.
`;
    const { task, errors } = parseTaskFile("quoted.md", content);
    expect(errors).toEqual([]);
    expect(task.scheduleRaw).toBe("daily 09:00");
    expect(task.directory).toBe("~/quoted dir");
    expect(task.timeoutMs).toBe(20 * 60_000);
    expect(task.target).toBe("feishu:dm:oc_123");
  });

  it("ignores blank lines and # comment lines in front matter", () => {
    const content = `---
# this is a comment
schedule: daily 08:00

# another comment
timeout: 5m
---

Body.
`;
    const { task, errors, warnings } = parseTaskFile("comments.md", content);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(task.schedule).toEqual({ type: "daily", hour: 8, minute: 0 });
    expect(task.timeoutMs).toBe(5 * 60_000);
  });

  it("records unknown keys as warnings, not errors", () => {
    const content = `---
schedule: daily 09:00
foo: bar
baz: qux
---

Body.
`;
    const { task, errors, warnings } = parseTaskFile("unknown.md", content);
    expect(errors).toEqual([]);
    expect(warnings).toEqual(["unknown front matter key \"foo\"", "unknown front matter key \"baz\""]);
    expect(task.name).toBe("unknown");
    expect(task.schedule).toEqual({ type: "daily", hour: 9, minute: 0 });
  });

  it("records invalid schedule and timeout strings as errors and keeps the task listable", () => {
    const content = `---
schedule: sometimes soon
timeout: 10
---

Body.
`;
    const { task, errors, warnings } = parseTaskFile("bad.md", content);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("invalid schedule \"sometimes soon\"");
    expect(errors[1]).toContain("invalid timeout \"10\"");
    expect(warnings).toEqual([]);
    expect(task.schedule).toBeNull();
    // Invalid timeout falls back to the default.
    expect(task.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(task.prompt).toBe("Body.");
  });

  it("rejects an empty schedule value", () => {
    const content = "---\nschedule:\n---\nBody.\n";
    const { task, errors } = parseTaskFile("empty-schedule.md", content);
    expect(errors).toEqual(["invalid schedule \"\": schedule is empty"]);
    expect(task.schedule).toBeNull();
  });

  it("honors enabled: false (plain and quoted) and case-insensitivity", () => {
    for (const raw of ["false", '"false"', "FALSE"]) {
      const { task } = parseTaskFile(
        "disabled.md",
        `---\nschedule: daily 09:00\nenabled: ${raw}\n---\nBody.\n`,
      );
      expect(task.enabled).toBe(false);
    }
    const enabled = parseTaskFile(
      "enabled.md",
      "---\nschedule: daily 09:00\nenabled: true\n---\nBody.\n",
    );
    expect(enabled.task.enabled).toBe(true);
    // Any non-false value is treated as enabled.
    const weird = parseTaskFile(
      "weird.md",
      "---\nschedule: daily 09:00\nenabled: maybe\n---\nBody.\n",
    );
    expect(weird.task.enabled).toBe(true);
  });

  it("flags an empty body as an error", () => {
    const { task, errors } = parseTaskFile("nobody.md", "---\nschedule: daily 09:00\n---\n\n");
    expect(errors).toEqual(["task body is empty — nothing would be sent when this task fires"]);
    expect(task.prompt).toBe("");
  });

  it("flags a body of only whitespace as an error", () => {
    const { errors } = parseTaskFile("blankbody.md", "---\nschedule: daily 09:00\n---\n   \n\t\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("task body is empty");
  });

  it("treats empty target and directory values as unset", () => {
    const { task, errors } = parseTaskFile(
      "empties.md",
      "---\nschedule: daily 09:00\ntarget:\ndirectory:   \n---\nBody.\n",
    );
    expect(errors).toEqual([]);
    expect(task.target).toBeUndefined();
    expect(task.directory).toBeUndefined();
  });

  it("keeps colons inside values intact", () => {
    const { task } = parseTaskFile(
      "colon.md",
      "---\nschedule: daily 09:00\ntarget: feishu:dm:oc_abc\n---\nBody.\n",
    );
    expect(task.target).toBe("feishu:dm:oc_abc");
  });

  it("warns on malformed front matter lines that are not key: value", () => {
    const { task, errors, warnings } = parseTaskFile(
      "malformed.md",
      "---\nschedule: daily 09:00\nthis line has no colon\n---\nBody.\n",
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      'ignoring malformed front matter line "this line has no colon" — expected "key: value"',
    ]);
    expect(task.schedule).toEqual({ type: "daily", hour: 9, minute: 0 });
  });

  it("keeps the last occurrence of a duplicated key", () => {
    const { task } = parseTaskFile(
      "dup.md",
      "---\nschedule: daily 09:00\nschedule: every 10m\n---\nBody.\n",
    );
    expect(task.schedule).toEqual({ type: "every", intervalMs: 10 * 60_000 });
    expect(task.scheduleRaw).toBe("every 10m");
  });

  it("treats an unterminated front matter block as all-front-matter with an empty body", () => {
    const { task, errors } = parseTaskFile(
      "unterminated.md",
      "---\nschedule: daily 09:00\nbody text never separated\n",
    );
    expect(task.prompt).toBe("");
    expect(errors).toEqual(["task body is empty — nothing would be sent when this task fires"]);
    expect(task.schedule).toEqual({ type: "daily", hour: 9, minute: 0 });
  });

  it("accepts CRLF line endings", () => {
    const content = "---\r\nschedule: daily 09:00\r\n---\r\nBody.\r\n";
    const { task, errors } = parseTaskFile("crlf.md", content);
    expect(errors).toEqual([]);
    expect(task.prompt).toBe("Body.");
    expect(task.schedule).toEqual({ type: "daily", hour: 9, minute: 0 });
  });
});

describe("loadChannelTasks", () => {
  const tmpDirs: string[] = [];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  async function makeChannelDir(root: string, channel: string): Promise<string> {
    const dir = path.join(root, encodeURIComponent(channel));
    await mkdir(dir, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("loads every .md file in the channel directory, sorted by name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-schedules-"));
    tmpDirs.push(root);
    const dir = await makeChannelDir(root, "test");
    await writeFile(
      path.join(dir, "b-task.md"),
      "---\nschedule: daily 09:00\n---\nBody B.\n",
      "utf8",
    );
    await writeFile(
      path.join(dir, "a-task.md"),
      "---\nschedule: every 5m\ntimeout: 1h\nenabled: false\n---\nBody A.\n",
      "utf8",
    );

    const results = await loadChannelTasks("test", root);
    expect(results.map((r) => r.task.name)).toEqual(["a-task", "b-task"]);
    expect(results[0].task.timeoutMs).toBe(3_600_000);
    expect(results[0].task.enabled).toBe(false);
    expect(results[1].task.prompt).toBe("Body B.");
    expect(results.every((r) => r.errors.length === 0)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("skips files whose names are not valid task names and warns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-schedules-"));
    tmpDirs.push(root);
    const dir = await makeChannelDir(root, "test");
    await writeFile(path.join(dir, "good.md"), "---\nschedule: daily 09:00\n---\nBody.\n", "utf8");
    await writeFile(path.join(dir, "Bad Name.md"), "---\nschedule: daily 09:00\n---\nBody.\n", "utf8");
    await writeFile(path.join(dir, "README.md"), "---\nschedule: daily 09:00\n---\nBody.\n", "utf8");

    const results = await loadChannelTasks("test", root);
    expect(results.map((r) => r.task.name)).toEqual(["good"]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).toContain("[schedule] skipping");
      expect(String(call[0])).toContain("task names must match [a-z0-9-]+");
    }
  });

  it("ignores non-.md files and directories inside the channel directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-schedules-"));
    tmpDirs.push(root);
    const dir = await makeChannelDir(root, "test");
    await writeFile(path.join(dir, "task.md"), "---\nschedule: daily 09:00\n---\nBody.\n", "utf8");
    await writeFile(path.join(dir, "notes.txt"), "not a task", "utf8");
    await mkdir(path.join(dir, "subdir"));

    const results = await loadChannelTasks("test", root);
    expect(results.map((r) => r.task.name)).toEqual(["task"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("collects per-file errors for the CLI to display", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-schedules-"));
    tmpDirs.push(root);
    const dir = await makeChannelDir(root, "test");
    await writeFile(path.join(dir, "broken.md"), "no front matter, just a prompt", "utf8");

    const results = await loadChannelTasks("test", root);
    expect(results).toHaveLength(1);
    expect(results[0].task.name).toBe("broken");
    expect(results[0].errors).toEqual(['missing required front matter key "schedule"']);
    expect(results[0].task.prompt).toBe("no front matter, just a prompt");
  });

  it("returns an empty array when the channel directory does not exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-schedules-"));
    tmpDirs.push(root);
    await expect(loadChannelTasks("ghost", root)).resolves.toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("setTaskTarget", () => {
  let tmpRoot: string;
  let dir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-settarget-"));
    dir = path.join(tmpRoot, "test");
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function readTaskFile(taskName: string): Promise<string> {
    return readFile(path.join(dir, `${taskName}.md`), "utf8");
  }

  it("replaces an existing target line in place, preserving the rest byte-for-byte", async () => {
    const original = `---
# keep this comment
schedule: daily 09:00
target: feishu:dm:oc_old
# comment with trailing spaces${"  "}

timeout: 5m
---

Body line 1

Body line 2 with 中文 🎉 and trailing spaces${"  "}
`;
    await writeFile(path.join(dir, "payroll.md"), original, "utf8");

    const result = await setTaskTarget(
      "test",
      "payroll",
      "feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc",
      tmpRoot,
    );
    expect(result).toEqual({ ok: true });

    const updated = await readTaskFile("payroll");
    expect(updated).toBe(
      `---
# keep this comment
schedule: daily 09:00
target: feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc
# comment with trailing spaces${"  "}

timeout: 5m
---

Body line 1

Body line 2 with 中文 🎉 and trailing spaces${"  "}
`,
    );
    // The parsed task now carries the new target.
    const { task } = parseTaskFile("payroll.md", updated);
    expect(task.target).toBe("feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc");
    expect(task.prompt).toBe("Body line 1\n\nBody line 2 with 中文 🎉 and trailing spaces");
  });

  it("inserts a target line just before the closing --- when none exists", async () => {
    const original = `---
# a comment
schedule: daily 09:00

# another comment
timeout: 5m
---

Body.
`;
    await writeFile(path.join(dir, "report.md"), original, "utf8");

    const result = await setTaskTarget("test", "report", "feishu:group:oc_123", tmpRoot);
    expect(result).toEqual({ ok: true });

    const updated = await readTaskFile("report");
    expect(updated).toBe(
      `---
# a comment
schedule: daily 09:00

# another comment
timeout: 5m
target: feishu:group:oc_123
---

Body.
`,
    );
    const { task, errors } = parseTaskFile("report.md", updated);
    expect(errors).toEqual([]);
    expect(task.target).toBe("feishu:group:oc_123");
    expect(task.prompt).toBe("Body.");
  });

  it("creates a front matter block containing only the target line when the file has none", async () => {
    const original = "Just a prompt with <&>\"'\` chars and 中文.\nSecond line   \n";
    await writeFile(path.join(dir, "raw.md"), original, "utf8");

    const result = await setTaskTarget("test", "raw", "wecom:dm:oc_xyz", tmpRoot);
    expect(result).toEqual({ ok: true });

    const updated = await readTaskFile("raw");
    expect(updated).toBe(
      `---
target: wecom:dm:oc_xyz
---
Just a prompt with <&>"'\` chars and 中文.
Second line${"   "}
`,
    );
    const { task, errors } = parseTaskFile("raw.md", updated);
    expect(errors).toEqual(['missing required front matter key "schedule"']);
    expect(task.target).toBe("wecom:dm:oc_xyz");
    // The original body is intact (sans the added front matter).
    expect(task.prompt).toBe("Just a prompt with <&>\"'` chars and 中文.\nSecond line");
  });

  it("preserves CRLF line endings and uses them for the inserted line", async () => {
    const original = "---\r\nschedule: daily 09:00\r\n---\r\nBody.\r\n";
    await writeFile(path.join(dir, "crlf.md"), original, "utf8");

    const result = await setTaskTarget("test", "crlf", "feishu:dm:oc_123", tmpRoot);
    expect(result).toEqual({ ok: true });

    const updated = await readTaskFile("crlf");
    expect(updated).toBe("---\r\nschedule: daily 09:00\r\ntarget: feishu:dm:oc_123\r\n---\r\nBody.\r\n");
  });

  it("re-claiming with a different chat replaces the target line", async () => {
    await writeFile(
      path.join(dir, "moving.md"),
      "---\nschedule: daily 09:00\n---\nBody.\n",
      "utf8",
    );

    await setTaskTarget("test", "moving", "feishu:dm:oc_first", tmpRoot);
    await setTaskTarget("test", "moving", "feishu:dm:oc_second", tmpRoot);

    const updated = await readTaskFile("moving");
    expect(updated).toBe("---\nschedule: daily 09:00\ntarget: feishu:dm:oc_second\n---\nBody.\n");
    expect(updated.match(/target:/g)).toHaveLength(1);
  });

  it("returns an error result for a missing task file without throwing", async () => {
    const result = await setTaskTarget("test", "ghost", "feishu:dm:oc_1", tmpRoot);
    expect(result).toEqual({ ok: false, reason: "task not found" });
  });

  it("returns an error result for an invalid task name without throwing", async () => {
    const result = await setTaskTarget("test", "Bad_Name", "feishu:dm:oc_1", tmpRoot);
    expect(result).toEqual({ ok: false, reason: "invalid task name" });
  });
});

describe("getSchedulesDir", () => {
  it("joins the root with the percent-encoded channel name", () => {
    expect(getSchedulesDir("feishu-dev", "/tmp/root")).toBe("/tmp/root/feishu-dev");
    expect(getSchedulesDir("my channel", "/tmp/root")).toBe("/tmp/root/my%20channel");
  });
});
