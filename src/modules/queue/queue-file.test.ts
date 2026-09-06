import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUEUES_DIR } from "../../config/channel-state";
import { DEFAULT_SILENCE_MS } from "../schedule/task-file";
import {
  DEFAULT_WORKERS,
  QUEUE_SESSION_PREFIX,
  deleteQueueTask,
  failQueueTask,
  getQueuesDir,
  insertQueueTask,
  isValidQueueName,
  isValidTaskId,
  listQueueDefinitions,
  listQueueTasks,
  loadQueueDefinition,
  parseQueueDefinition,
  parseQueueTaskFile,
  bindQueue,
  retryQueueTask,
  setQueueEnabled,
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
      silenceMs: DEFAULT_SILENCE_MS,
      timeoutMs: undefined,
      model: "azure-openai-responses/gpt-5.6-terra",
      target: "feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc",
      enabled: true,
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
      silenceMs: DEFAULT_SILENCE_MS,
      timeoutMs: undefined,
      model: undefined,
      target: undefined,
      enabled: true,
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

  it("parses the optional silence duration with the timeout syntax, defaulting to 30m", () => {
    const { definition, errors, warnings } = parseQueueDefinition(
      "silence.md",
      "---\nchannel: feishu-dev\nsilence: 5m\n---\nBody.\n",
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(definition?.silenceMs).toBe(5 * 60_000);
  });

  it("parses the optional timeout duration with the timeout syntax, absent by default", () => {
    const { definition, errors, warnings } = parseQueueDefinition(
      "timeout.md",
      "---\nchannel: feishu-dev\ntimeout: 1h\n---\nBody.\n",
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(definition?.timeoutMs).toBe(60 * 60_000);
  });

  it("leaves timeoutMs undefined when the field is absent or blank", () => {
    for (const raw of [null, "timeout:", "timeout:  ", 'timeout: ""']) {
      const frontMatter = raw === null ? "" : `${raw}\n`;
      const { definition, errors } = parseQueueDefinition(
        "no-timeout.md",
        `---\nchannel: feishu-dev\n${frontMatter}---\nBody.\n`,
      );
      expect(errors).toEqual([]);
      expect(definition?.timeoutMs).toBeUndefined();
    }
  });

  it("rejects an invalid timeout value and drops the definition", () => {
    const { definition, errors } = parseQueueDefinition(
      "bad-timeout.md",
      "---\nchannel: feishu-dev\ntimeout: 10x\n---\nBody.\n",
    );
    expect(errors).toEqual([
      'invalid timeout "10x": invalid timeout "10x" — expected like "10m", "1h" or "90s"',
    ]);
    expect(definition).toBeNull();
  });

  it("parses the optional directory as a plain string, absent or blank by default", () => {
    const { definition, errors } = parseQueueDefinition(
      "with-dir.md",
      "---\nchannel: feishu-dev\ndirectory: ~/project/foo\n---\nBody.\n",
    );
    expect(errors).toEqual([]);
    expect(definition?.directory).toBe("~/project/foo");

    for (const raw of ["directory:", "directory:  ", 'directory: ""']) {
      const blank = parseQueueDefinition(
        "blank-dir.md",
        `---\nchannel: feishu-dev\n${raw}\n---\nBody.\n`,
      );
      expect(blank.errors).toEqual([]);
      expect(blank.definition?.directory).toBeUndefined();
    }

    const absent = parseQueueDefinition("no-dir.md", "---\nchannel: feishu-dev\n---\nBody.\n");
    expect(absent.errors).toEqual([]);
    expect(absent.definition?.directory).toBeUndefined();
  });

  it("treats a blank silence as unset (defaults to 30m)", () => {
    for (const raw of ["silence:", "silence:  ", 'silence: ""']) {
      const { definition, errors } = parseQueueDefinition(
        "blank-silence.md",
        `---\nchannel: feishu-dev\n${raw}\n---\nBody.\n`,
      );
      expect(errors).toEqual([]);
      expect(definition?.silenceMs).toBe(DEFAULT_SILENCE_MS);
    }
  });

  it("rejects an invalid silence value and drops the definition", () => {
    const { definition, errors } = parseQueueDefinition(
      "bad-silence.md",
      "---\nchannel: feishu-dev\nsilence: nope\n---\nBody.\n",
    );
    expect(errors).toEqual([
      'invalid silence "nope": invalid timeout "nope" — expected like "10m", "1h" or "90s"',
    ]);
    expect(definition).toBeNull();
  });

  it("accepts a definition without the channel field (unbound queue, T1)", () => {
    const { definition, errors, warnings } = parseQueueDefinition(
      "nofm.md",
      "---\nworkers: 2\n---\nBody.\n",
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(definition).toEqual({
      name: "nofm",
      channel: undefined,
      workers: 2,
      silenceMs: DEFAULT_SILENCE_MS,
      model: undefined,
      target: undefined,
      enabled: true,
      body: "Body.",
      filePath: "",
    });
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

  it("parses the optional task-level directory override", () => {
    const { task, errors, warnings } = parseQueueTaskFile(
      "1724000000000-ab12.md",
      "---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\ndirectory: /srv/work\n---\nGo.\n",
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(task?.directory).toBe("/srv/work");

    const blank = parseQueueTaskFile(
      "1724000000001-cd34.md",
      "---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\ndirectory:\n---\nGo.\n",
    );
    expect(blank.errors).toEqual([]);
    expect(blank.task?.directory).toBeUndefined();

    const absent = parseQueueTaskFile(
      "1724000000002-ef56.md",
      "---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\n---\nGo.\n",
    );
    expect(absent.errors).toEqual([]);
    expect(absent.task?.directory).toBeUndefined();
  });

  it("parses the optional task-level model/timeout/silence run parameters (T03)", () => {
    const all = parseQueueTaskFile(
      "1724000000000-ab12.md",
      "---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\nmodel: azure-openai-responses/gpt-5.6-terra\ntimeout: 30m\nsilence: 5m\n---\nGo.\n",
    );
    expect(all.errors).toEqual([]);
    expect(all.warnings).toEqual([]);
    expect(all.task?.model).toBe("azure-openai-responses/gpt-5.6-terra");
    expect(all.task?.timeoutMs).toBe(30 * 60_000);
    expect(all.task?.silenceMs).toBe(5 * 60_000);

    // Blank values behave like the definition side's optional fields: absent.
    const blank = parseQueueTaskFile(
      "1724000000001-cd34.md",
      "---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\nmodel:\ntimeout:  \nsilence:\n---\nGo.\n",
    );
    expect(blank.errors).toEqual([]);
    expect(blank.task?.model).toBeUndefined();
    expect(blank.task?.timeoutMs).toBeUndefined();
    expect(blank.task?.silenceMs).toBeUndefined();

    const absent = parseQueueTaskFile(
      "1724000000002-ef56.md",
      "---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\n---\nGo.\n",
    );
    expect(absent.errors).toEqual([]);
    expect(absent.task?.model).toBeUndefined();
    expect(absent.task?.timeoutMs).toBeUndefined();
    expect(absent.task?.silenceMs).toBeUndefined();
  });

  it("rejects an invalid task-level timeout or silence: the error lands in errors and the task is null (T03)", () => {
    for (const [key, raw] of [
      ["timeout", "10x"],
      ["timeout", "0"],
      ["silence", "forever"],
    ] as const) {
      const { task, errors } = parseQueueTaskFile(
        "1724000000000-ab12.md",
        `---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\n${key}: ${raw}\n---\nGo.\n`,
      );
      expect(task).toBeNull();
      expect(errors).toEqual([
        expect.stringMatching(new RegExp(`^invalid ${key} "${raw}":`)),
      ]);
    }
    // The reason text comes from parseTimeout itself.
    const { errors } = parseQueueTaskFile(
      "1724000000000-ab12.md",
      "---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\ntimeout: 10x\n---\nGo.\n",
    );
    expect(errors).toEqual([
      `invalid timeout "10x": invalid timeout "10x" — expected like "10m", "1h" or "90s"`,
    ]);
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
      expect(errors).toEqual([
        `invalid state "${raw}": must be "pending", "running" or "failed"`,
      ]);
      expect(task).toBeNull();
    }
    // `state:` with an empty value is an invalid state, not a missing key.
    const empty = parseQueueTaskFile(
      "1724000000000-ab12.md",
      "---\nstate:\nenqueuedAt: 2026-08-19T08:00:00.000Z\n---\nGo.\n",
    );
    expect(empty.errors).toEqual(['invalid state "": must be "pending", "running" or "failed"']);
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

  it("skips invalid definitions (bad workers) with a log, keeping channel-less queues (T1)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeFile(path.join(root, "good.md"), "---\nchannel: feishu-dev\n---\nGood.\n", "utf8");
    // A queue without `channel` is valid now (unbound, owned by no controller).
    await writeFile(path.join(root, "nochan.md"), "---\nworkers: 2\n---\nNo channel.\n", "utf8");
    await writeFile(path.join(root, "badworkers.md"), "---\nchannel: feishu-dev\nworkers: 0\n---\nBad.\n", "utf8");

    const definitions = await listQueueDefinitions(root);
    expect(definitions.map((d) => d.name)).toEqual(["good", "nochan"]);
    expect(definitions.find((d) => d.name === "nochan")?.channel).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const messages = warnSpy.mock.calls.map((call) => String(call[0]));
    for (const message of messages) {
      expect(message).toContain("[queue] skipping");
    }
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

  it("creates a queue file with default workers and no channel (T1)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    const result = await writeQueueDefinition({ name: "ops" }, root);
    expect(result).toEqual({ ok: true, filePath: path.join(root, "ops.md") });

    const content = await readFile(path.join(root, "ops.md"), "utf8");
    expect(content).toBe("---\nworkers: 1\n---\n\n");
    expect(content).not.toContain("channel:");
    const definition = await loadQueueDefinition("ops", root);
    expect(definition?.workers).toBe(1);
    expect(definition?.model).toBeUndefined();
    expect(definition?.body).toBe("");
    expect(definition?.channel).toBeUndefined();
  });

  it("writes workers, model and body when provided", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    const result = await writeQueueDefinition(
      {
        name: "ops",
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
    await writeQueueDefinition({ name: "ops" }, root);
    const result = await writeQueueDefinition({ name: "ops", workers: 9 }, root);
    expect(result).toEqual({ ok: false, reason: 'queue "ops" already exists' });
    // The original file is untouched.
    const definition = await loadQueueDefinition("ops", root);
    expect(definition?.channel).toBeUndefined();
    expect(definition?.workers).toBe(1);
  });

  it("returns error results for invalid input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    expect(await writeQueueDefinition({ name: "Bad_Name" }, root)).toEqual({
      ok: false,
      reason: "invalid queue name",
    });
    for (const workers of [0, -1, 2.5]) {
      expect(await writeQueueDefinition({ name: "ops", workers }, root)).toEqual({
        ok: false,
        reason: "workers must be an integer >= 1",
      });
    }
    expect(await writeQueueDefinition({ name: "ops", model: "  " }, root)).toEqual({
      ok: false,
      reason: "model must be a non-empty string when present",
    });
    expect(await writeQueueDefinition({ name: "ops", directory: "  " }, root)).toEqual({
      ok: false,
      reason: "directory must be a non-empty string when present",
    });
  });

  it("writes the directory line only when provided", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    const withDir = await writeQueueDefinition(
      { name: "with-dir", directory: " ~/project/foo " },
      root,
    );
    expect(withDir.ok).toBe(true);
    const content = await readFile(path.join(root, "with-dir.md"), "utf8");
    expect(content).toContain("directory: ~/project/foo");
    const definition = await loadQueueDefinition("with-dir", root);
    expect(definition?.directory).toBe("~/project/foo");

    const noDir = await writeQueueDefinition({ name: "no-dir" }, root);
    expect(noDir.ok).toBe(true);
    const noDirContent = await readFile(path.join(root, "no-dir.md"), "utf8");
    expect(noDirContent).not.toContain("directory:");
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
    await writeQueueDefinition({ name: "ops" }, root);

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

  it("writes a task-level directory line only when the option is given", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops" }, root);

    const withDir = await insertQueueTask("ops", "With dir.", root, { directory: " /srv/work " });
    const withDirContent = await readFile(path.join(root, "ops.tasks", `${withDir}.md`), "utf8");
    expect(withDirContent).toContain("directory: /srv/work");
    const withDirTasks = await listQueueTasks("ops", root);
    expect(withDirTasks[0].directory).toBe("/srv/work");

    const noDir = await insertQueueTask("ops", "No dir.", root);
    const noDirContent = await readFile(path.join(root, "ops.tasks", `${noDir}.md`), "utf8");
    expect(noDirContent).not.toContain("directory:");
    const tasks = await listQueueTasks("ops", root);
    expect(tasks.find((t) => t.id === noDir)?.directory).toBeUndefined();

    // Blank option behaves like absent (no line written).
    const blankDir = await insertQueueTask("ops", "Blank dir.", root, { directory: "  " });
    const blankContent = await readFile(path.join(root, "ops.tasks", `${blankDir}.md`), "utf8");
    expect(blankContent).not.toContain("directory:");
  });

  it("writes task-level model/timeout/silence lines only when the options are given (T03)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops" }, root);

    const withAll = await insertQueueTask("ops", "Pinned.", root, {
      model: " azure-openai-responses/gpt-5.6-terra ",
      timeout: " 30m ",
      silence: " 5m ",
    });
    const withAllContent = await readFile(path.join(root, "ops.tasks", `${withAll}.md`), "utf8");
    expect(withAllContent).toContain("model: azure-openai-responses/gpt-5.6-terra");
    expect(withAllContent).toContain("timeout: 30m");
    expect(withAllContent).toContain("silence: 5m");
    const withAllTasks = await listQueueTasks("ops", root);
    const withAllTask = withAllTasks.find((t) => t.id === withAll);
    expect(withAllTask?.model).toBe("azure-openai-responses/gpt-5.6-terra");
    expect(withAllTask?.timeoutMs).toBe(30 * 60_000);
    expect(withAllTask?.silenceMs).toBe(5 * 60_000);

    // No options → no lines (byte shape identical to the plain insert).
    const bare = await insertQueueTask("ops", "Bare.", root);
    const bareContent = await readFile(path.join(root, "ops.tasks", `${bare}.md`), "utf8");
    expect(bareContent).not.toContain("model:");
    expect(bareContent).not.toContain("timeout:");
    expect(bareContent).not.toContain("silence:");
    const bareTasks = await listQueueTasks("ops", root);
    const bareTask = bareTasks.find((t) => t.id === bare);
    expect(bareTask?.model).toBeUndefined();
    expect(bareTask?.timeoutMs).toBeUndefined();
    expect(bareTask?.silenceMs).toBeUndefined();

    // Blank options behave like absent (no line written).
    const blank = await insertQueueTask("ops", "Blank.", root, { model: "  ", silence: "" });
    const blankContent = await readFile(path.join(root, "ops.tasks", `${blank}.md`), "utf8");
    expect(blankContent).not.toContain("model:");
    expect(blankContent).not.toContain("silence:");

    // A partially-set insert only writes the given lines (stable order:
    // directory, model, timeout, silence).
    const partial = await insertQueueTask("ops", "Partial.", root, { silence: "2m" });
    const partialContent = await readFile(path.join(root, "ops.tasks", `${partial}.md`), "utf8");
    expect(partialContent).toContain("silence: 2m");
    expect(partialContent).not.toContain("model:");
    expect(partialContent).not.toContain("timeout:");
  });

  it("inserts tasks with distinct, monotonic ids and lists them in FIFO order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops" }, root);

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
    await writeQueueDefinition({ name: "ops" }, root);
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
    await writeQueueDefinition({ name: "ops" }, root);
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
    await writeQueueDefinition({ name: "ops" }, root);
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

  it("preserves a task-level directory across pending -> running flips", async () => {
    // Regression pin: the task-level `directory:` override only matters if it
    // survives the fire-time `running` flip (and the restart re-enqueue flip).
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops" }, root);
    const taskId = await insertQueueTask("ops", "Run the migration.", root, {
      directory: "/srv/work",
    });

    await setQueueTaskState("ops", taskId, "running", root);
    const running = (await listQueueTasks("ops", root))[0];
    expect(running.state).toBe("running");
    expect(running.directory).toBe("/srv/work");

    await setQueueTaskState("ops", taskId, "pending", root);
    const back = (await listQueueTasks("ops", root))[0];
    expect(back.state).toBe("pending");
    expect(back.directory).toBe("/srv/work");
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
    await writeQueueDefinition({ name: "ops" }, root);
    const first = await insertQueueTask("ops", "first", root);
    const second = await insertQueueTask("ops", "second", root);

    await deleteQueueTask("ops", first, root);
    const remaining = await listQueueTasks("ops", root);
    expect(remaining.map((t) => t.id)).toEqual([second]);
  });

  it("throws for missing tasks and invalid ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops" }, root);
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

describe("failQueueTask / retryQueueTask (dead-letter, spec D2/T02)", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  async function setUpQueue(root: string, prompt = "Run the migration."): Promise<string> {
    await writeQueueDefinition({ name: "ops" }, root);
    return insertQueueTask("ops", prompt, root);
  }

  it("dead-letters in ONE atomic write: state failed + failedAt + reason + agentSessionId, body preserved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    const taskId = await setUpQueue(root, "Body line stays.\n\nSecond paragraph.");
    const before = await readFile(path.join(root, "ops.tasks", `${taskId}.md`), "utf8");

    await failQueueTask("ops", taskId, {
      reason: "model unavailable",
      agentSessionId: "pi-coding-agent:1111-2222",
    }, root);

    const content = await readFile(path.join(root, "ops.tasks", `${taskId}.md`), "utf8");
    expect(content).toContain("state: failed");
    expect(content).toContain("reason: model unavailable");
    expect(content).toContain("agentSessionId: pi-coding-agent:1111-2222");
    const failedAtLine = content.split("\n").find((l) => l.startsWith("failedAt:"));
    expect(failedAtLine).toBeDefined();
    expect(Number.isNaN(Date.parse(failedAtLine!.slice("failedAt:".length).trim()))).toBe(false);
    // The body and the other front-matter lines are preserved byte-for-byte.
    expect(content).toContain("Body line stays.\n\nSecond paragraph.");
    expect(content).toContain(`enqueuedAt: ${before.match(/enqueuedAt: (.+)/)![1]}`);

    const [task] = await listQueueTasks("ops", root);
    expect(task).toMatchObject({
      id: taskId,
      state: "failed",
      reason: "model unavailable",
      agentSessionId: "pi-coding-agent:1111-2222",
    });
    expect(task.failedAt).toBeDefined();
  });

  it("dead-letters without an agentSessionId line when the session was never created", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    const taskId = await setUpQueue(root);

    await failQueueTask("ops", taskId, { reason: "dispatch failed" }, root);

    const content = await readFile(path.join(root, "ops.tasks", `${taskId}.md`), "utf8");
    expect(content).toContain("state: failed");
    expect(content).toContain("reason: dispatch failed");
    expect(content).not.toContain("agentSessionId:");
  });

  it("retry requires the failed state: pending/running tasks are rejected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    const taskId = await setUpQueue(root);

    // A pending task cannot be retried (retrying would double-run it).
    const pendingResult = await retryQueueTask("ops", taskId, root);
    expect(pendingResult).toEqual({
      ok: false,
      reason: `task "${taskId}" is not failed (state: pending) — only failed tasks can be retried`,
    });

    // A running task likewise.
    await setQueueTaskState("ops", taskId, "running", root);
    const runningResult = await retryQueueTask("ops", taskId, root);
    expect(runningResult).toMatchObject({ ok: false });
    expect(runningResult).toEqual({
      ok: false,
      reason: `task "${taskId}" is not failed (state: running) — only failed tasks can be retried`,
    });
  });

  it("retry flips failed back to pending and clears the failedAt/reason/agentSessionId lines in one write", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    const taskId = await setUpQueue(root, "Retry me.");
    await failQueueTask("ops", taskId, {
      reason: "boom",
      agentSessionId: "pi-coding-agent:3333-4444",
    }, root);

    const result = await retryQueueTask("ops", taskId, root);
    expect(result).toEqual({ ok: true });

    const content = await readFile(path.join(root, "ops.tasks", `${taskId}.md`), "utf8");
    expect(content).toContain("state: pending");
    expect(content).not.toContain("failedAt:");
    expect(content).not.toContain("reason:");
    expect(content).not.toContain("agentSessionId:");
    expect(content).toContain("Retry me.");
    const [task] = await listQueueTasks("ops", root);
    expect(task).toMatchObject({ id: taskId, state: "pending" });
    expect(task.failedAt).toBeUndefined();
    expect(task.reason).toBeUndefined();
    expect(task.agentSessionId).toBeUndefined();
  });

  it("fail and retry throw / return error results for missing tasks and invalid ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops" }, root);
    await expect(
      failQueueTask("ops", "1724000000000-ab12", { reason: "x" }, root),
    ).rejects.toThrow('task "1724000000000-ab12" not found in queue "ops"');
    await expect(failQueueTask("Bad_Name", "1724000000000-ab12", { reason: "x" }, root)).rejects.toThrow(
      'invalid queue name "Bad_Name"',
    );
    await expect(
      failQueueTask("ops", "not-an-id", { reason: "x" }, root),
    ).rejects.toThrow('invalid task id "not-an-id"');
    expect(await retryQueueTask("ops", "1724000000000-ab12", root)).toEqual({
      ok: false,
      reason: 'task "1724000000000-ab12" not found in queue "ops"',
    });
    expect(await retryQueueTask("Bad_Name", "1724000000000-ab12", root)).toEqual({
      ok: false,
      reason: "invalid queue name",
    });
    expect(await retryQueueTask("ops", "not-an-id", root)).toEqual({
      ok: false,
      reason: "invalid task id",
    });
  });

  it("a retried task survives a further fail/retry cycle (fields re-written, then re-cleared)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    const taskId = await setUpQueue(root);

    await failQueueTask("ops", taskId, { reason: "first failure" }, root);
    await retryQueueTask("ops", taskId, root);
    await failQueueTask("ops", taskId, { reason: "second failure" }, root);

    let content = await readFile(path.join(root, "ops.tasks", `${taskId}.md`), "utf8");
    expect(content).toContain("state: failed");
    expect(content).toContain("reason: second failure");
    expect(content.match(/^reason:/gm)).toHaveLength(1);

    expect(await retryQueueTask("ops", taskId, root)).toEqual({ ok: true });
    content = await readFile(path.join(root, "ops.tasks", `${taskId}.md`), "utf8");
    expect(content).toContain("state: pending");
    expect(content).not.toContain("reason:");
  });
});

describe("bindQueue", () => {
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

  it("writes BOTH channel and target in one atomic write, replacing existing lines", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeBoundQueue(root);

    const result = await bindQueue(
      "ops",
      "wecom-main",
      "feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc",
      root,
    );
    expect(result).toEqual({ ok: true });

    const updated = await readFile(path.join(root, "ops.md"), "utf8");
    expect(updated).toBe(
      `---
# keep this comment
channel: wecom-main
workers: 2
model: azure-openai-responses/gpt-5.6-terra
target: feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc
---

Body line 1

Body line 2 with 中文 🎉
`,
    );
    const definition = await loadQueueDefinition("ops", root);
    expect(definition?.channel).toBe("wecom-main");
    expect(definition?.target).toBe("feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc");
    expect(definition?.model).toBe("azure-openai-responses/gpt-5.6-terra");
    expect(definition?.workers).toBe(2);
    expect(definition?.body).toBe("Body line 1\n\nBody line 2 with 中文 🎉");
  });

  it("binds a channel-less queue: inserts channel and target lines before the closing ---", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeFile(
      path.join(root, "ops.md"),
      `---
workers: 2
---

Body.
`,
      "utf8",
    );

    const result = await bindQueue("ops", "feishu-dev", "feishu:group:oc_123", root);
    expect(result).toEqual({ ok: true });
    const updated = await readFile(path.join(root, "ops.md"), "utf8");
    expect(updated).toBe(
      `---
workers: 2
channel: feishu-dev
target: feishu:group:oc_123
---

Body.
`,
    );
    const definition = await loadQueueDefinition("ops", root);
    expect(definition?.channel).toBe("feishu-dev");
    expect(definition?.target).toBe("feishu:group:oc_123");
  });

  it("creates a front matter block with both channel and target when the file has none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeFile(path.join(root, "ops.md"), "Just a raw body.\n", "utf8");

    const result = await bindQueue("ops", "feishu-dev", "wecom:dm:oc_xyz", root);
    expect(result).toEqual({ ok: true });
    const updated = await readFile(path.join(root, "ops.md"), "utf8");
    expect(updated).toBe(
      "---\nchannel: feishu-dev\ntarget: wecom:dm:oc_xyz\n---\nJust a raw body.\n",
    );
  });

  it("re-binding replaces the previous channel and target, one line each", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeBoundQueue(root);
    await bindQueue("ops", "a", "feishu:dm:oc_first", root);
    await bindQueue("ops", "b", "feishu:dm:oc_second", root);
    const updated = await readFile(path.join(root, "ops.md"), "utf8");
    expect(updated.match(/target:/g)).toHaveLength(1);
    expect(updated.match(/channel:/g)).toHaveLength(1);
    expect(updated).toContain("channel: b");
    expect(updated).toContain("target: feishu:dm:oc_second");
    expect(updated).toContain("Body line 1");
  });

  it("returns error results for a missing queue, invalid name, empty channel and empty target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    expect(await bindQueue("ghost", "feishu-dev", "feishu:dm:oc_1", root)).toEqual({
      ok: false,
      reason: "queue not found",
    });
    expect(await bindQueue("Bad_Name", "feishu-dev", "feishu:dm:oc_1", root)).toEqual({
      ok: false,
      reason: "invalid queue name",
    });
    expect(await bindQueue("ops", "   ", "feishu:dm:oc_1", root)).toEqual({
      ok: false,
      reason: "channel must be a non-empty string",
    });
    expect(await bindQueue("ops", "feishu-dev", "   ", root)).toEqual({
      ok: false,
      reason: "target must be a non-empty string",
    });
  });
});

describe("setQueueEnabled", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("disables and re-enables a queue, preserving the body and other lines byte-for-byte", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeQueueDefinition({ name: "ops", workers: 2 }, root);
    await bindQueue("ops", "feishu-dev", "feishu:dm:oc_1", root);
    const original = await readFile(path.join(root, "ops.md"), "utf8");

    expect(await setQueueEnabled("ops", false, root)).toEqual({ ok: true });
    let updated = await readFile(path.join(root, "ops.md"), "utf8");
    expect(updated).toContain("enabled: false");
    expect((await loadQueueDefinition("ops", root))?.enabled).toBe(false);
    // Every other line survives untouched; exactly one enabled line exists.
    expect(updated.match(/^enabled: false$/m)).toHaveLength(1);
    expect(updated.replace("enabled: false\n", "")).toBe(original);

    expect(await setQueueEnabled("ops", true, root)).toEqual({ ok: true });
    updated = await readFile(path.join(root, "ops.md"), "utf8");
    expect(updated).toContain("enabled: true");
    expect((await loadQueueDefinition("ops", root))?.enabled).toBe(true);
  });

  it("appends the enabled line to a definition without front matter", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "nofm.md"), "Just a body.\n", "utf8");

    expect(await setQueueEnabled("nofm", false, root)).toEqual({ ok: true });
    const updated = await readFile(path.join(root, "nofm.md"), "utf8");
    expect(updated.startsWith("---\nenabled: false\n---\nJust a body.\n")).toBe(true);
  });

  it("appends the enabled line to an unterminated front matter block", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    await writeFile(
      path.join(root, "open.md"),
      "---\nworkers: 2\nbody text never separated\n",
      "utf8",
    );

    expect(await setQueueEnabled("open", false, root)).toEqual({ ok: true });
    const updated = await readFile(path.join(root, "open.md"), "utf8");
    expect(updated).toBe("---\nworkers: 2\nbody text never separated\n\nenabled: false");
  });

  it("returns error results for a missing queue and an invalid name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
    tmpDirs.push(root);
    expect(await setQueueEnabled("ghost", false, root)).toEqual({
      ok: false,
      reason: "queue not found",
    });
    expect(await setQueueEnabled("Bad_Name", false, root)).toEqual({
      ok: false,
      reason: "invalid queue name",
    });
  });
});
