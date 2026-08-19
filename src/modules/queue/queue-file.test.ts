import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUEUES_DIR } from "../../config/channel-state";
import {
  DEFAULT_WORKERS,
  QUEUE_SESSION_PREFIX,
  deleteQueueTask,
  getQueuesDir,
  insertQueueTask,
  isValidQueueName,
  isValidTaskId,
  listQueueDefinitions,
  listQueueTasks,
  loadQueueDefinition,
  parseQueueDefinition,
  parseQueueTaskFile,
  setQueueTarget,
  setQueueTaskState,
  writeQueueDefinition,
} from "./queue-file";

const WELL_FORMED = `---
channel: feishu-dev
workers: 2
model: azure-openai-responses/gpt-5.6-terra
target: feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc
---

Shared context for every task of this queue.
`;

describe("constants and name validators", () => {
  it("exports the queue session prefix shared with the core", () => {
    expect(QUEUE_SESSION_PREFIX).toBe("queue:");
  });

  it("resolves the queues root next to the schedules root", () => {
    expect(QUEUES_DIR).toBe(path.join(os.homedir(), ".config", "agent-bridge", "queues"));
    expect(getQueuesDir()).toBe(QUEUES_DIR);
  });

  it("expands ~ in an overridden queues root", () => {
    expect(getQueuesDir("/tmp/root")).toBe("/tmp/root");
    expect(getQueuesDir("~/queues")).toBe(path.join(os.homedir(), "queues"));
    expect(getQueuesDir("~")).toBe(os.homedir());
  });

  it("accepts lowercase slugs for queue names and rejects everything else", () => {
    expect(isValidQueueName("ops")).toBe(true);
    expect(isValidQueueName("daily-report")).toBe(true);
    expect(isValidQueueName("a1-b2")).toBe(true);
    expect(isValidQueueName("OPS")).toBe(false);
    expect(isValidQueueName("ops_report")).toBe(false);
    expect(isValidQueueName("ops.report")).toBe(false);
    expect(isValidQueueName("")).toBe(false);
  });

  it("validates the <enqueueMs>-<random4> task id shape", () => {
    expect(isValidTaskId("1724000000000-ab12")).toBe(true);
    expect(isValidTaskId("1724000000000-ABCD")).toBe(false);
    expect(isValidTaskId("1724000000000-abc")).toBe(false);
    expect(isValidTaskId("abc-1234")).toBe(false);
    expect(isValidTaskId("1724000000000-ab12-extra")).toBe(false);
    expect(isValidTaskId("")).toBe(false);
  });
});

describe("parseQueueDefinition", () => {
  it("parses a well-formed queue definition", () => {
    const { definition, errors, warnings } = parseQueueDefinition("ops.md", WELL_FORMED);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(definition).toEqual({
      name: "ops",
      channel: "feishu-dev",
      workers: 2,
      model: "azure-openai-responses/gpt-5.6-terra",
      target: "feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc",
      body: "Shared context for every task of this queue.",
      filePath: "",
    });
  });

  it("applies defaults: workers 1, model/target absent, empty body", () => {
    const { definition, errors, warnings } = parseQueueDefinition(
      "minimal.md",
      "---\nchannel: wecom-dev\n---\n",
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(definition).toEqual({
      name: "minimal",
      channel: "wecom-dev",
      workers: DEFAULT_WORKERS,
      model: undefined,
      target: undefined,
      body: "",
      filePath: "",
    });
  });

  it("treats blank workers and blank model as unset", () => {
    for (const raw of ["workers:", "workers:  ", 'workers: ""']) {
      const { definition, errors } = parseQueueDefinition(
        "blank.md",
        `---\nchannel: feishu-dev\n${raw}\n---\nBody.\n`,
      );
      expect(errors).toEqual([]);
      expect(definition?.workers).toBe(1);
    }
    for (const raw of ["model:", 'model: ""', "model:   "]) {
      const { definition, errors } = parseQueueDefinition(
        "blank-model.md",
        `---\nchannel: feishu-dev\n${raw}\n---\nBody.\n`,
      );
      expect(errors).toEqual([]);
      expect(definition?.model).toBeUndefined();
    }
  });

  it("strips quotes and keeps colons inside values", () => {
    const { definition, errors } = parseQueueDefinition(
      "quoted.md",
      `---
channel: "feishu-dev"
workers: '3'
model: "azure-openai-responses/gpt-5.6-terra"
target: feishu:dm:oc_abc
---

Body.
`,
    );
    expect(errors).toEqual([]);
    expect(definition?.channel).toBe("feishu-dev");
    expect(definition?.workers).toBe(3);
    expect(definition?.model).toBe("azure-openai-responses/gpt-5.6-terra");
    expect(definition?.target).toBe("feishu:dm:oc_abc");
  });

  it("records unknown keys as warnings, not errors", () => {
    const { definition, errors, warnings } = parseQueueDefinition(
      "extra.md",
      "---\nchannel: feishu-dev\nfoo: bar\n---\nBody.\n",
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual(['unknown front matter key "foo"']);
    expect(definition?.name).toBe("extra");
  });

  it("rejects a definition missing the channel", () => {
    const { definition, errors } = parseQueueDefinition(
      "nofm.md",
      "---\nworkers: 2\n---\nBody.\n",
    );
    expect(errors).toEqual(['missing required front matter key "channel"']);
    expect(definition).toBeNull();
  });

  it("rejects invalid workers values (0, negative, non-integer, garbage)", () => {
    for (const raw of ["0", "-1", "2.5", "abc", "1e3"]) {
      const { definition, errors } = parseQueueDefinition(
        "bad-workers.md",
        `---\nchannel: feishu-dev\nworkers: ${raw}\n---\nBody.\n`,
      );
      expect(errors).toEqual([`invalid workers "${raw}": must be an integer >= 1`]);
      expect(definition).toBeNull();
    }
  });
});

describe("parseQueueTaskFile", () => {
  it("parses a well-formed task file", () => {
    const { task, errors, warnings } = parseQueueTaskFile(
      "1724000000000-ab12.md",
      `---
state: pending
enqueuedAt: 2026-08-19T08:00:00.000Z
---

Run the migration.
`,
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(task).toEqual({
      id: "1724000000000-ab12",
      state: "pending",
      enqueuedAt: "2026-08-19T08:00:00.000Z",
      prompt: "Run the migration.",
      filePath: "",
    });
  });

  it("accepts the running state and quoted values", () => {
    const { task, errors } = parseQueueTaskFile(
      "1724000000001-cd34.md",
      "---\nstate: 'running'\nenqueuedAt: \"2026-08-19T08:01:00.000Z\"\n---\nGo.\n",
    );
    expect(errors).toEqual([]);
    expect(task?.state).toBe("running");
    expect(task?.enqueuedAt).toBe("2026-08-19T08:01:00.000Z");
  });

  it("records unknown keys as warnings", () => {
    const { task, errors, warnings } = parseQueueTaskFile(
      "1724000000000-ab12.md",
      "---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\nfoo: bar\n---\nGo.\n",
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual(['unknown front matter key "foo"']);
    expect(task?.prompt).toBe("Go.");
  });

  it("rejects missing, empty and invalid state", () => {
    for (const raw of ["paused", "done"]) {
      const { task, errors } = parseQueueTaskFile(
        "1724000000000-ab12.md",
        `---\nstate: ${raw}\nenqueuedAt: 2026-08-19T08:00:00.000Z\n---\nGo.\n`,
      );
      expect(errors).toEqual([`invalid state "${raw}": must be "pending" or "running"`]);
      expect(task).toBeNull();
    }
    // `state:` with an empty value is an invalid state, not a missing key.
    const empty = parseQueueTaskFile(
      "1724000000000-ab12.md",
      "---\nstate:\nenqueuedAt: 2026-08-19T08:00:00.000Z\n---\nGo.\n",
    );
    expect(empty.errors).toEqual(['invalid state "": must be "pending" or "running"']);
    expect(empty.task).toBeNull();
    const missing = parseQueueTaskFile(
      "1724000000000-ab12.md",
      "---\nenqueuedAt: 2026-08-19T08:00:00.000Z\n---\nGo.\n",
    );
    expect(missing.errors).toEqual(['missing required front matter key "state"']);
    expect(missing.task).toBeNull();
  });

  it("rejects missing and invalid enqueuedAt", () => {
    const missing = parseQueueTaskFile(
      "1724000000000-ab12.md",
      "---\nstate: pending\n---\nGo.\n",
    );
    expect(missing.errors).toEqual(['missing required front matter key "enqueuedAt"']);
    expect(missing.task).toBeNull();

    const invalid = parseQueueTaskFile(
      "1724000000000-ab12.md",
      "---\nstate: pending\nenqueuedAt: yesterday\n---\nGo.\n",
    );
    expect(invalid.errors).toEqual(['invalid enqueuedAt "yesterday": not an ISO timestamp']);
    expect(invalid.task).toBeNull();
  });

  it("rejects an empty or whitespace-only prompt", () => {
    for (const body of ["", "   \n\t"]) {
      const { task, errors } = parseQueueTaskFile(
        "1724000000000-ab12.md",
        `---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\n---\n${body}`,
      );
      expect(errors).toEqual([
        "task body is empty — nothing would be sent when this task runs",
      ]);
      expect(task).toBeNull();
    }
  });
});

describe("listQueueDefinitions", () => {
  const tmpDirs: string[] = [];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("loads every valid queue definition sorted by name, ignoring tasks directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeFile(
      path.join(root, "b-queue.md"),
      "---\nchannel: wecom-dev\n---\nBody B.\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "a-queue.md"),
      "---\nchannel: feishu-dev\nworkers: 3\nmodel: azure-openai-responses/gpt-5.6-terra\n---\nBody A.\n",
      "utf8",
    );
    // A queue's task directory must be ignored, not parsed as a definition.
    await mkdir(path.join(root, "a-queue.tasks"), { recursive: true });
    await writeFile(
      path.join(root, "a-queue.tasks", "1724000000000-ab12.md"),
      "---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\n---\nTask.\n",
      "utf8",
    );

    const definitions = await listQueueDefinitions(root);
    expect(definitions.map((d) => d.name)).toEqual(["a-queue", "b-queue"]);
    expect(definitions[0].workers).toBe(3);
    expect(definitions[0].model).toBe("azure-openai-responses/gpt-5.6-terra");
    expect(definitions[1].workers).toBe(1);
    expect(definitions[1].channel).toBe("wecom-dev");
    expect(definitions[1].body).toBe("Body B.");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("skips invalid definitions (missing channel, bad workers) with a log", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeFile(path.join(root, "good.md"), "---\nchannel: feishu-dev\n---\nGood.\n", "utf8");
    await writeFile(path.join(root, "nochan.md"), "---\nworkers: 2\n---\nNo channel.\n", "utf8");
    await writeFile(path.join(root, "badworkers.md"), "---\nchannel: feishu-dev\nworkers: 0\n---\nBad.\n", "utf8");

    const definitions = await listQueueDefinitions(root);
    expect(definitions.map((d) => d.name)).toEqual(["good"]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const messages = warnSpy.mock.calls.map((call) => String(call[0]));
    for (const message of messages) {
      expect(message).toContain("[queue] skipping");
    }
    // readdir order is not guaranteed, so match on content, not call order.
    expect(messages.some((m) => m.includes('missing required front matter key "channel"'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('invalid workers "0": must be an integer >= 1'))).toBe(
      true,
    );
  });

  it("skips files whose names are not valid queue names and warns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeFile(path.join(root, "good.md"), "---\nchannel: feishu-dev\n---\nGood.\n", "utf8");
    await writeFile(path.join(root, "Bad Name.md"), "---\nchannel: feishu-dev\n---\nBad.\n", "utf8");
    await writeFile(path.join(root, "README.md"), "---\nchannel: feishu-dev\n---\nReadme.\n", "utf8");

    const definitions = await listQueueDefinitions(root);
    expect(definitions.map((d) => d.name)).toEqual(["good"]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).toContain("queue names must match [a-z0-9-]+");
    }
  });

  it("ignores non-.md files inside the queues directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeFile(path.join(root, "ops.md"), "---\nchannel: feishu-dev\n---\nOps.\n", "utf8");
    await writeFile(path.join(root, "notes.txt"), "not a queue", "utf8");

    const definitions = await listQueueDefinitions(root);
    expect(definitions.map((d) => d.name)).toEqual(["ops"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns an empty array when the queues directory does not exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await expect(listQueueDefinitions(path.join(root, "missing"))).resolves.toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("loadQueueDefinition", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("loads an existing definition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeFile(
      path.join(root, "ops.md"),
      "---\nchannel: feishu-dev\nworkers: 2\n---\nShared.\n",
      "utf8",
    );
    const definition = await loadQueueDefinition("ops", root);
    expect(definition?.name).toBe("ops");
    expect(definition?.channel).toBe("feishu-dev");
    expect(definition?.workers).toBe(2);
    expect(definition?.filePath).toBe(path.join(root, "ops.md"));
  });

  it("returns null for a missing queue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await expect(loadQueueDefinition("ghost", root)).resolves.toBeNull();
  });

  it("returns null for an invalid definition and an invalid name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeFile(path.join(root, "bad.md"), "---\nworkers: 0\n---\nBad.\n", "utf8");
    await expect(loadQueueDefinition("bad", root)).resolves.toBeNull();
    await expect(loadQueueDefinition("Bad_Name", root)).resolves.toBeNull();
  });
});

describe("writeQueueDefinition", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("creates a queue file with channel and default workers, model omitted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    const result = await writeQueueDefinition({ name: "ops", channel: "feishu-dev" }, root);
    expect(result).toEqual({ ok: true, filePath: path.join(root, "ops.md") });

    const content = await readFile(path.join(root, "ops.md"), "utf8");
    expect(content).toBe("---\nchannel: feishu-dev\nworkers: 1\n---\n\n");
    const definition = await loadQueueDefinition("ops", root);
    expect(definition?.workers).toBe(1);
    expect(definition?.model).toBeUndefined();
    expect(definition?.body).toBe("");
  });

  it("writes workers, model and body when provided", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    const result = await writeQueueDefinition(
      {
        name: "ops",
        channel: "wecom-dev",
        workers: 3,
        model: "azure-openai-responses/gpt-5.6-terra",
        body: "Shared context.",
      },
      root,
    );
    expect(result.ok).toBe(true);
    const definition = await loadQueueDefinition("ops", root);
    expect(definition?.workers).toBe(3);
    expect(definition?.model).toBe("azure-openai-responses/gpt-5.6-terra");
    expect(definition?.body).toBe("Shared context.");
  });

  it("refuses to overwrite an existing queue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops", channel: "feishu-dev" }, root);
    const result = await writeQueueDefinition(
      { name: "ops", channel: "wecom-dev", workers: 9 },
      root,
    );
    expect(result).toEqual({ ok: false, reason: 'queue "ops" already exists' });
    // The original file is untouched.
    const definition = await loadQueueDefinition("ops", root);
    expect(definition?.channel).toBe("feishu-dev");
    expect(definition?.workers).toBe(1);
  });

  it("returns error results for invalid input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    expect(await writeQueueDefinition({ name: "Bad_Name", channel: "feishu-dev" }, root)).toEqual({
      ok: false,
      reason: "invalid queue name",
    });
    expect(await writeQueueDefinition({ name: "ops", channel: "  " }, root)).toEqual({
      ok: false,
      reason: "channel must be a non-empty string",
    });
    for (const workers of [0, -1, 2.5]) {
      expect(await writeQueueDefinition({ name: "ops", channel: "feishu-dev", workers }, root)).toEqual({
        ok: false,
        reason: "workers must be an integer >= 1",
      });
    }
    expect(
      await writeQueueDefinition({ name: "ops", channel: "feishu-dev", model: "  " }, root),
    ).toEqual({ ok: false, reason: "model must be a non-empty string when present" });
  });
});

describe("insertQueueTask / listQueueTasks", () => {
  const tmpDirs: string[] = [];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("creates the tasks directory and task file on demand with a well-formed id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops", channel: "feishu-dev" }, root);

    const taskId = await insertQueueTask("ops", "Run the migration.", root);
    expect(isValidTaskId(taskId)).toBe(true);

    const tasks = await listQueueTasks("ops", root);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(taskId);
    expect(tasks[0].state).toBe("pending");
    expect(tasks[0].prompt).toBe("Run the migration.");
    expect(Number.isNaN(Date.parse(tasks[0].enqueuedAt))).toBe(false);

    const content = await readFile(path.join(root, "ops.tasks", `${taskId}.md`), "utf8");
    expect(content).toBe(
      `---\nstate: pending\nenqueuedAt: ${tasks[0].enqueuedAt}\n---\n\nRun the migration.\n`,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("inserts tasks with distinct, monotonic ids and lists them in FIFO order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops", channel: "feishu-dev" }, root);

    const ids: string[] = [];
    for (const prompt of ["first", "second", "third"]) {
      ids.push(await insertQueueTask("ops", prompt, root));
    }
    // Distinct ids whose lexicographic order is the insertion order.
    expect(new Set(ids).size).toBe(3);
    expect([...ids].sort()).toEqual(ids);
    // The enqueuedAt timestamps follow the same monotonic clock as the ids.
    const tasks = await listQueueTasks("ops", root);
    expect(tasks.map((t) => t.id)).toEqual(ids);
    expect(tasks.map((t) => t.prompt)).toEqual(["first", "second", "third"]);
    expect(tasks.every((t) => t.state === "pending")).toBe(true);
    for (const t of tasks) {
      expect(Number.isNaN(Date.parse(t.enqueuedAt))).toBe(false);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("rejects when the queue definition does not exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await expect(insertQueueTask("ghost", "prompt", root)).rejects.toThrow(
      'queue "ghost" not found',
    );
    // No stray directory is created for a missing queue.
    await expect(insertQueueTask("Bad_Name", "prompt", root)).rejects.toThrow(
      'invalid queue name "Bad_Name"',
    );
  });

  it("rejects an empty prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops", channel: "feishu-dev" }, root);
    await expect(insertQueueTask("ops", "   ", root)).rejects.toThrow(
      "task prompt must be a non-empty string",
    );
  });

  it("returns an empty list when the tasks directory does not exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await expect(listQueueTasks("ops", root)).resolves.toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("skips task files with an invalid state with a log", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops", channel: "feishu-dev" }, root);
    await insertQueueTask("ops", "good", root);
    await writeFile(
      path.join(root, "ops.tasks", "1724000000000-dead.md"),
      "---\nstate: paused\nenqueuedAt: 2026-08-19T08:00:00.000Z\n---\nBad state.\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "ops.tasks", "not-an-id.md"),
      "---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\n---\nBad id.\n",
      "utf8",
    );

    const tasks = await listQueueTasks("ops", root);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe("good");
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[0][0])).toContain('invalid state "paused"');
    expect(String(warnSpy.mock.calls[1][0])).toContain("task ids must match");
  });
});

describe("setQueueTaskState / deleteQueueTask", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  async function setUpQueue(root: string): Promise<string> {
    await writeQueueDefinition({ name: "ops", channel: "feishu-dev" }, root);
    return insertQueueTask("ops", "Run the migration.", root);
  }

  it("round-trips task state pending -> running -> pending, preserving the rest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    const taskId = await setUpQueue(root);
    const before = (await listQueueTasks("ops", root))[0];

    await setQueueTaskState("ops", taskId, "running", root);
    const running = (await listQueueTasks("ops", root))[0];
    expect(running.state).toBe("running");
    expect(running.prompt).toBe(before.prompt);
    expect(running.enqueuedAt).toBe(before.enqueuedAt);

    await setQueueTaskState("ops", taskId, "pending", root);
    const back = (await listQueueTasks("ops", root))[0];
    expect(back.state).toBe("pending");
    expect(back.prompt).toBe(before.prompt);
    expect(back.enqueuedAt).toBe(before.enqueuedAt);
  });

  it("changes only the state line in the file, byte-for-byte elsewhere", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    const taskId = await setUpQueue(root);
    await setQueueTaskState("ops", taskId, "running", root);
    const content = await readFile(path.join(root, "ops.tasks", `${taskId}.md`), "utf8");
    expect(content).toBe(
      `---\nstate: running\nenqueuedAt: ${(await listQueueTasks("ops", root))[0].enqueuedAt}\n---\n\nRun the migration.\n`,
    );
  });

  it("deletes a task file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops", channel: "feishu-dev" }, root);
    const first = await insertQueueTask("ops", "first", root);
    const second = await insertQueueTask("ops", "second", root);

    await deleteQueueTask("ops", first, root);
    const remaining = await listQueueTasks("ops", root);
    expect(remaining.map((t) => t.id)).toEqual([second]);
  });

  it("throws for missing tasks and invalid ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops", channel: "feishu-dev" }, root);
    await expect(setQueueTaskState("ops", "1724000000000-ab12", "running", root)).rejects.toThrow(
      'task "1724000000000-ab12" not found in queue "ops"',
    );
    await expect(deleteQueueTask("ops", "1724000000000-ab12", root)).rejects.toThrow(
      'task "1724000000000-ab12" not found in queue "ops"',
    );
    await expect(setQueueTaskState("ops", "not-an-id", "running", root)).rejects.toThrow(
      'invalid task id "not-an-id"',
    );
    await expect(deleteQueueTask("Bad_Name", "1724000000000-ab12", root)).rejects.toThrow(
      'invalid queue name "Bad_Name"',
    );
  });
});

describe("setQueueTarget", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  async function writeBoundQueue(root: string): Promise<void> {
    await writeFile(
      path.join(root, "ops.md"),
      `---
# keep this comment
channel: feishu-dev
workers: 2
model: azure-openai-responses/gpt-5.6-terra
target: feishu:dm:oc_old
---

Body line 1

Body line 2 with 中文 🎉
`,
      "utf8",
    );
  }

  it("replaces an existing target line, preserving body and other front matter byte-for-byte", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeBoundQueue(root);

    const result = await setQueueTarget("ops", "feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc", root);
    expect(result).toEqual({ ok: true });

    const updated = await readFile(path.join(root, "ops.md"), "utf8");
    expect(updated).toBe(
      `---
# keep this comment
channel: feishu-dev
workers: 2
model: azure-openai-responses/gpt-5.6-terra
target: feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc
---

Body line 1

Body line 2 with 中文 🎉
`,
    );
    const definition = await loadQueueDefinition("ops", root);
    expect(definition?.target).toBe("feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc");
    expect(definition?.model).toBe("azure-openai-responses/gpt-5.6-terra");
    expect(definition?.workers).toBe(2);
    expect(definition?.body).toBe("Body line 1\n\nBody line 2 with 中文 🎉");
  });

  it("inserts a target line just before the closing --- when none exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeFile(
      path.join(root, "ops.md"),
      `---
channel: feishu-dev
workers: 2
---

Body.
`,
      "utf8",
    );

    const result = await setQueueTarget("ops", "feishu:group:oc_123", root);
    expect(result).toEqual({ ok: true });
    const updated = await readFile(path.join(root, "ops.md"), "utf8");
    expect(updated).toBe(
      `---
channel: feishu-dev
workers: 2
target: feishu:group:oc_123
---

Body.
`,
    );
    expect((await loadQueueDefinition("ops", root))?.target).toBe("feishu:group:oc_123");
  });

  it("creates a front matter block when the file has none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeFile(path.join(root, "ops.md"), "Just a raw body.\n", "utf8");

    const result = await setQueueTarget("ops", "wecom:dm:oc_xyz", root);
    expect(result).toEqual({ ok: true });
    const updated = await readFile(path.join(root, "ops.md"), "utf8");
    expect(updated).toBe("---\ntarget: wecom:dm:oc_xyz\n---\nJust a raw body.\n");
  });

  it("re-binding replaces the previous target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeBoundQueue(root);
    await setQueueTarget("ops", "feishu:dm:oc_first", root);
    await setQueueTarget("ops", "feishu:dm:oc_second", root);
    const updated = await readFile(path.join(root, "ops.md"), "utf8");
    expect(updated.match(/target:/g)).toHaveLength(1);
    expect(updated).toContain("target: feishu:dm:oc_second");
    expect(updated).toContain("Body line 1");
  });

  it("returns error results for a missing queue, invalid name and empty target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    expect(await setQueueTarget("ghost", "feishu:dm:oc_1", root)).toEqual({
      ok: false,
      reason: "queue not found",
    });
    expect(await setQueueTarget("Bad_Name", "feishu:dm:oc_1", root)).toEqual({
      ok: false,
      reason: "invalid queue name",
    });
    expect(await setQueueTarget("ghost", "   ", root)).toEqual({
      ok: false,
      reason: "target must be a non-empty string",
    });
  });
});
