import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedTask, ScheduleTask } from "./modules/schedule/task-file";
import type { QueueDefinition, QueueTask } from "./modules/queue/queue-file";

const promptCalls: string[] = [];
const close = vi.fn();
/** Per-test overrides for the shared `input` mock, keyed by prompt label. */
const inputOverrides: Record<string, string> = {};
const input = vi.fn(async (label: string) => {
  promptCalls.push(`input:${label}`);
  if (inputOverrides[label] !== undefined) return inputOverrides[label];
  if (label === "Channel name") return "demo";
  if (label === "Task name") return "daily-report";
  if (label === "Schedule (examples: every 5m, daily 09:00, weekly mon 09:00, monthly 15 09:00)") {
    return "daily 09:00";
  }
  if (label === "Timeout (default 5h)") return "5h";
  if (label === "Silence window (default 30m)") return "30m";
  if (label === "Model (optional, blank = channel default)") return "";
  if (label === "Working directory (optional, blank = bridge cwd)") return "";
  if (label === "Shared context body (optional, blank = empty; prepended to every task prompt)") {
    return "";
  }
  if (label === "Queue name") return "inbox";
  if (label === "Workers (default 1)") return "1";
  throw new Error(`unexpected input prompt: ${label}`);
});
const select = vi.fn(async (label: string) => {
  promptCalls.push(`select:${label}`);
  if (label === "Channel language") return "zh-CN";
  if (label === "Select client module") return "fake-client";
  if (label === "Select agent module") return "fake-agent";
  if (label === "Select channel") return "demo";
  if (label === "Select task to remove") return "daily-report";
  throw new Error(`unexpected select prompt: ${label}`);
});
const confirm = vi.fn(async () => true);
const loadConfig = vi.fn(async () => ({ channels: {}, defaults: { agentIdleTimeoutMs: 60_000 } }));
const saveConfig = vi.fn(async () => {});

// Schedule command file system + task-file module (added in T8).
const mkdir = vi.fn(async () => {});
const writeFile = vi.fn(async () => {});
const unlink = vi.fn(async () => {});
const rm = vi.fn(async () => {});
// Queue command tests run the real queue-file writers against a fixed temp
// root, so the fs mock also needs the access/rename plumbing they touch.
const access = vi.fn(async () => {});
const readFile = vi.fn(async () => "");
const readdir = vi.fn(async () => []);
const rename = vi.fn(async () => {});
const loadAllTasks = vi.fn(async () => []);
const getSchedulesDir = vi.fn(() => "/tmp/schedules");

/** Spies standing in for the one-shot Scheduler construction/trigger (schedule run). */
const schedulerRunNow = vi.fn<(name: string) => Promise<{ ok: true } | { ok: false; reason: string }>>();
const schedulerStart = vi.fn(async () => {});
const schedulerStop = vi.fn(async () => {});
const schedulerCtorArgs: Array<Record<string, unknown>> = [];
const lastSchedulerOptions = () =>
  schedulerCtorArgs[schedulerCtorArgs.length - 1] as unknown as {
    channelName: string;
    dispatchClientEvent: (event: unknown) => Promise<unknown>;
    validateTarget: (clientSessionId: string) => boolean;
  };

/** The queue add wizard's shared-context body prompt label (T06). */
const BODY_PROMPT = "Shared context body (optional, blank = empty; prepended to every task prompt)";
const fakeClientModule = {
  type: "fake-client",
  createConfigCollector: () => ({
    collect: async () => ({ token: "client-token" }),
    validate: async () => {},
    summarize: () => "type=fake-client",
  }),
  createClientAdapter: vi.fn(),
};

const fakeAgentModule = {
  type: "fake-agent",
  createConfigCollector: () => ({
    collect: async () => ({ model: "demo-model" }),
    validate: async () => {},
    summarize: () => "type=fake-agent",
  }),
  createAgentSession: vi.fn(),
};

vi.mock("./config/prompt", () => ({
  createPromptContext: () => ({ input, select, confirm, close }),
}));

vi.mock("./config/store", () => ({
  getConfigPath: () => "/tmp/agent-bridge-config.json",
  loadConfig,
  saveConfig,
}));

vi.mock("./modules/client", () => ({
  listClientModules: () => [fakeClientModule],
  getClientModule: (type: string) => (type === "fake-client" ? fakeClientModule : undefined),
  getTypedClientModule: (config: { type: string }) =>
    config.type === "fake-client" ? fakeClientModule : undefined,
}));

vi.mock("./modules/agent", () => ({
  listAgentModules: () => [fakeAgentModule],
  getAgentModule: (type: string) => (type === "fake-agent" ? fakeAgentModule : undefined),
  getTypedAgentModule: (config: { type: string }) =>
    config.type === "fake-agent" ? fakeAgentModule : undefined,
}));

vi.mock("./core/channel-runner", () => ({
  runChannel: vi.fn(),
}));

vi.mock("./core/gateway-core", () => ({
  GatewayCore: vi.fn().mockImplementation(() => ({
    input: vi.fn(async () => ({ ok: true })),
    start: (...args: unknown[]) => coreStart(...(args as [])),
    stop: (...args: unknown[]) => coreStop(...(args as [])),
  })),
}));

const coreStart = vi.fn(async () => {});
const coreStop = vi.fn(async () => {});

vi.mock("./modules/schedule/scheduler", async (importOriginal) => {
  const original = await importOriginal<typeof import("./modules/schedule/scheduler")>();
  return {
    ...original,
    Scheduler: vi.fn().mockImplementation((options: Record<string, unknown>) => {
      schedulerCtorArgs.push(options);
      return {
        start: schedulerStart,
        stop: schedulerStop,
        runNow: (name: string) => schedulerRunNow(name),
      };
    }),
  };
});

vi.mock("./config/session-bindings", () => ({
  removeSessionBindingStore: vi.fn(async () => {}),
}));

vi.mock("node:fs/promises", () => ({ mkdir, writeFile, unlink, rm, access, readFile, readdir, rename }));

vi.mock("./modules/schedule/task-file", async (importOriginal) => {
  const original = await importOriginal<typeof import("./modules/schedule/task-file")>();
  return { ...original, loadAllTasks, getSchedulesDir };
});

/** Fixed temp root used by the mocked queue-file module (the CLI never sees it). */
const TEST_QUEUES_ROOT = "/tmp/queues-test";
const listQueueDefinitions = vi.fn(async () => []);
const loadQueueDefinition = vi.fn(async () => null);
const insertQueueTask = vi.fn(async () => "1750000000000-abcd");
const listQueueTasks = vi.fn(async () => []);

vi.mock("./modules/queue/queue-file", async (importOriginal) => {
  const original = await importOriginal<typeof import("./modules/queue/queue-file")>();
  return {
    ...original,
    listQueueDefinitions,
    loadQueueDefinition,
    insertQueueTask,
    listQueueTasks,
    // The real writer runs against the mocked node:fs/promises with a fixed
    // temp root, so the wizard test can assert the exact front matter passed
    // to writeFile (mirroring the schedule add tests).
    writeQueueDefinition: vi.fn(async (input) =>
      original.writeQueueDefinition(input, TEST_QUEUES_ROOT),
    ),
  };
});

describe("runCli add", () => {
  beforeEach(() => {
    vi.resetModules();
    promptCalls.length = 0;
    close.mockClear();
    input.mockClear();
    select.mockClear();
    confirm.mockClear();
    loadConfig.mockClear();
    saveConfig.mockClear();
  });

  it("prompts for channel language immediately after channel name and saves it under common config", async () => {
    const { runCli } = await import("./cli");

    await runCli(["node", "agent-bridge", "add"]);

    expect(promptCalls.slice(0, 2)).toEqual(["input:Channel name", "select:Channel language"]);
    expect(saveConfig).toHaveBeenCalledWith({
      channels: {
        demo: {
          common: {
            language: "zh-CN",
          },
          client: {
            type: "fake-client",
            config: { token: "client-token" },
          },
          agent: {
            type: "fake-agent",
            config: { model: "demo-model" },
          },
        },
      },
      defaults: {
        agentIdleTimeoutMs: 60_000,
      },
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

function makeQueueDefinition(overrides: Partial<QueueDefinition> = {}): QueueDefinition {
  return {
    name: "inbox",
    channel: "demo",
    workers: 1,
    silenceMs: 30 * 60_000, // DEFAULT_SILENCE_MS (inlined: this module is vi.mock'ed below)
    timeoutMs: undefined,
    model: undefined,
    target: undefined,
    enabled: true,
    body: "",
    filePath: `${TEST_QUEUES_ROOT}/inbox.md`,
    ...overrides,
  };
}

function makeQueueTask(overrides: Partial<QueueTask> = {}): QueueTask {
  return {
    id: "1750000000000-abcd",
    state: "pending",
    enqueuedAt: "2026-08-19T08:00:00.000Z",
    prompt: "Do the thing.",
    filePath: `${TEST_QUEUES_ROOT}/inbox.tasks/1750000000000-abcd.md`,
    ...overrides,
  };
}

function enoentError(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

function makeLoadedTask(
  taskOverrides: Partial<ScheduleTask> = {},
  loadedOverrides: Partial<LoadedTask> = {},
): LoadedTask {
  return {
    task: {
      name: "daily-report",
      scheduleRaw: "daily 09:00",
      schedule: { type: "daily", hour: 9, minute: 0 },
      directory: undefined,
      timeoutMs: 5 * 3_600_000,
      silenceMs: 30 * 60_000,
      model: undefined,
      channel: undefined,
      enabled: true,
      target: undefined,
      prompt: "Do the thing.",
      ...taskOverrides,
    },
    errors: [],
    warnings: [],
    ...loadedOverrides,
  };
}

function captureLogs() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

/** Same resets as the shared add-wizard suite: clears prompt mocks between tests. */
function resetPromptMocks() {
  promptCalls.length = 0;
  close.mockClear();
  input.mockClear();
  select.mockClear();
  confirm.mockClear();
  loadConfig.mockClear();
  saveConfig.mockClear();
  schedulerCtorArgs.length = 0;
  schedulerRunNow.mockReset();
  schedulerStart.mockClear();
  schedulerStop.mockClear();
  coreStart.mockClear();
  coreStop.mockClear();
}

const CHANNEL_WITH_DEMO = {
  channels: {
    demo: {
      common: { language: "zh-CN" },
      client: { type: "fake-client", config: {} },
      agent: { type: "fake-agent", config: {} },
    },
  },
  defaults: { agentIdleTimeoutMs: 60_000 },
};

describe("schedule wizard validators", () => {
  it("validateTaskNameInput enforces the slug shape and global task-name uniqueness", async () => {
    const { validateTaskNameInput } = await import("./cli");
    expect(validateTaskNameInput("daily-report", new Set())).toBeNull();
    expect(validateTaskNameInput("Daily", new Set())).toContain("[a-z0-9-]+");
    expect(validateTaskNameInput("daily_report", new Set())).toContain("[a-z0-9-]+");
    expect(validateTaskNameInput("", new Set())).toContain("[a-z0-9-]+");
    expect(validateTaskNameInput("daily-report", new Set(["daily-report"]))).toContain(
      "already exists",
    );
  });

  it("validateScheduleInput accepts grammar forms and rejects invalid input with examples", async () => {
    const { validateScheduleInput } = await import("./cli");
    for (const ok of ["every 5m", "daily 09:00", "weekly mon 09:00", "monthly 15 09:00"]) {
      expect(validateScheduleInput(ok)).toBeNull();
    }
    const rejected = validateScheduleInput("sometimes soon");
    expect(rejected).toContain("unknown schedule type");
    expect(rejected).toContain("every 5m");
  });

  it("validateTimeoutInput accepts durations and rejects malformed ones", async () => {
    const { validateTimeoutInput } = await import("./cli");
    expect(validateTimeoutInput("10m")).toBeNull();
    expect(validateTimeoutInput("1h")).toBeNull();
    expect(validateTimeoutInput("90s")).toBeNull();
    expect(validateTimeoutInput("10")).toContain("invalid timeout");
    expect(validateTimeoutInput("0m")).toContain("at least 1");
  });

  it("buildTaskFileContent emits front matter with an optional directory line", async () => {
    const { buildTaskFileContent } = await import("./cli");
    const withDir = buildTaskFileContent({
      schedule: "daily 09:00",
      timeout: "30m",
      directory: "~/reports",
    });
    expect(withDir).toContain("schedule: daily 09:00");
    expect(withDir).toContain("timeout: 30m");
    expect(withDir).toContain("directory: ~/reports");
    // Default (no language) falls back to the English example prompt.
    expect(withDir).toContain("Tell me what time it is right now");

    const withoutDir = buildTaskFileContent({ schedule: "every 5m", timeout: "10m" });
    expect(withoutDir).not.toContain("directory:");

    const blankDir = buildTaskFileContent({ schedule: "every 5m", timeout: "10m", directory: "" });
    expect(blankDir).not.toContain("directory:");
  });

  it("writes a silence: line when a silence value is given and omits it when blank/absent", async () => {
    const { buildTaskFileContent } = await import("./cli");
    const withSilence = buildTaskFileContent({
      schedule: "every 5m",
      timeout: "10m",
      silence: "15m",
    });
    expect(withSilence).toContain("silence: 15m");

    const blankSilence = buildTaskFileContent({
      schedule: "every 5m",
      timeout: "10m",
      silence: "",
    });
    expect(blankSilence).not.toContain("silence:");

    const absentSilence = buildTaskFileContent({ schedule: "every 5m", timeout: "10m" });
    expect(absentSilence).not.toContain("silence:");
  });

  it("buildTaskFileContent keeps model between timeout and directory in the front matter", async () => {
    const { buildTaskFileContent } = await import("./cli");
    const content = buildTaskFileContent({
      schedule: "daily 09:00",
      timeout: "30m",
      silence: "15m",
      directory: "~/reports",
      model: "azure-openai-responses/gpt-5.6-terra",
    });
    let prev = -1;
    for (const needle of [
      "schedule: daily 09:00",
      "timeout: 30m",
      "silence: 15m",
      "model: azure-openai-responses/gpt-5.6-terra",
      "directory: ~/reports",
    ]) {
      const idx = content.indexOf(needle);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
  });

  it("buildTaskFileContent localizes the example prompt by language", async () => {
    const { buildTaskFileContent } = await import("./cli");
    const en = buildTaskFileContent({
      schedule: "daily 09:00",
      timeout: "10m",
      language: "en-US",
    });
    expect(en).toContain("Tell me what time it is right now, in one sentence.");

    const zh = buildTaskFileContent({
      schedule: "daily 09:00",
      timeout: "10m",
      language: "zh-CN",
    });
    expect(zh).toContain("告诉我现在几点了，一句话就好。");
    expect(zh).not.toContain("Tell me what time it is");
  });

  it("writes task files that the real T2 parseTaskFile reads back cleanly", async () => {
    // The task-file module is mocked above (loadAllTasks/getSchedulesDir
    // replaced with vi.fn), but vi.importActual bypasses that mock entirely and
    // returns the genuine T2 parser. parseTaskFile is a pure function (no fs
    // access), so it works unchanged even though node:fs/promises is mocked.
    const { parseTaskFile } = await vi.importActual<typeof import("./modules/schedule/task-file")>(
      "./modules/schedule/task-file",
    );
    const { buildTaskFileContent } = await import("./cli");

    // Full form: schedule + directory + timeout + model must round-trip field-for-field.
    const full = buildTaskFileContent({
      schedule: "daily 09:00",
      timeout: "30m",
      directory: "~/reports",
      model: "azure-openai-responses/gpt-5.6-terra",
    });
    const fullLoaded = parseTaskFile("daily-report.md", full);
    expect(fullLoaded.errors).toEqual([]);
    expect(fullLoaded.warnings).toEqual([]);
    expect(fullLoaded.task).toMatchObject({
      name: "daily-report",
      scheduleRaw: "daily 09:00",
      schedule: { type: "daily", hour: 9, minute: 0 },
      directory: "~/reports",
      timeoutMs: 30 * 60_000,
      model: "azure-openai-responses/gpt-5.6-terra",
      enabled: true,
    });

    // Minimal form (no directory key) and the CLI's blank-directory path (the
    // add wizard passes directory: "") must both parse with zero diagnostics.
    // An explicit timeout round-trips as-is (10m stays 10m — not the default).
    const minimalVariants: Array<{ schedule: string; timeout: string; directory?: string }> = [
      { schedule: "every 5m", timeout: "10m" },
      { schedule: "every 5m", timeout: "10m", directory: "" },
    ];
    for (const opts of minimalVariants) {
      const loaded = parseTaskFile("healthcheck", buildTaskFileContent(opts));
      expect(loaded.errors).toEqual([]);
      expect(loaded.warnings).toEqual([]);
      expect(loaded.task.scheduleRaw).toBe("every 5m");
      expect(loaded.task.schedule).toEqual({ type: "every", intervalMs: 5 * 60_000 });
      expect(loaded.task.directory).toBeUndefined();
      expect(loaded.task.timeoutMs).toBe(10 * 60_000);
      expect(loaded.task.enabled).toBe(true);
    }

    // The localized (zh-CN) example prompt also round-trips cleanly.
    const zhLoaded = parseTaskFile(
      "healthcheck",
      buildTaskFileContent({ schedule: "every 5m", timeout: "10m", language: "zh-CN" }),
    );
    expect(zhLoaded.errors).toEqual([]);
    expect(zhLoaded.warnings).toEqual([]);
    expect(zhLoaded.task.prompt).toContain("告诉我现在几点了，一句话就好。");
  });
});

describe("runCli schedule add", () => {
  beforeEach(() => {
    resetPromptMocks();
    delete inputOverrides["Silence window (default 30m)"];
    delete inputOverrides["Working directory (optional, blank = bridge cwd)"];
    delete inputOverrides["Model (optional, blank = channel default)"];
    mkdir.mockClear();
    writeFile.mockClear();
    loadAllTasks.mockClear();
    loadAllTasks.mockResolvedValue([]);
  });

  it("asks the unified question sequence and writes the collected values (T06)", async () => {
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "add"]);
    } finally {
      logs.restore();
    }

    // Unified wizard order (T06): name → schedule → timeout → silence → model → directory.
    expect(promptCalls).toEqual([
      "input:Task name",
      "input:Schedule (examples: every 5m, daily 09:00, weekly mon 09:00, monthly 15 09:00)",
      "input:Timeout (default 5h)",
      "input:Silence window (default 30m)",
      "input:Model (optional, blank = channel default)",
      "input:Working directory (optional, blank = bridge cwd)",
    ]);
    expect(loadAllTasks).toHaveBeenCalledWith();
    expect(mkdir).toHaveBeenCalledWith("/tmp/schedules", { recursive: true });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [filePath, content] = writeFile.mock.calls[0] as [string, string, string];
    expect(filePath).toBe("/tmp/schedules/daily-report.md");
    expect(content).toContain("schedule: daily 09:00");
    expect(content).toContain("timeout: 5h");
    // The default 30m silence answer writes the silence line.
    expect(content).toContain("silence: 30m");
    expect(content).not.toContain("directory:");
    // Blank model answer writes no model: line.
    expect(content).not.toContain("model:");
    // The example prompt is channel-agnostic and always DEFAULT_LOCALE (English).
    expect(content).toContain("Tell me what time it is right now, in one sentence.");
    expect(content).not.toContain("告诉我现在几点了");
    expect(logs.lines.join("\n")).toContain("Created successfully!");
    expect(logs.lines.join("\n")).toContain(
      "- Edit /tmp/schedules/daily-report.md to set your prompt.",
    );
    expect(logs.lines.join("\n")).toContain(
      "- Send `/schedule-here daily-report` in chat app to set the report place.",
    );
    expect(logs.lines.join("\n")).not.toContain("/st");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("omits the silence: line when the silence answer is blank (built-in default applies)", async () => {
    inputOverrides["Silence window (default 30m)"] = "";
    const { runCli } = await import("./cli");
    try {
      await runCli(["node", "agent-bridge", "schedule", "add"]);
    } finally {
      // no-op; logs not needed here
    }

    const [, content] = writeFile.mock.calls[0] as [string, string, string];
    expect(content).not.toContain("silence:");
  });

  it("includes the directory line when a working directory is provided", async () => {
    inputOverrides["Working directory (optional, blank = bridge cwd)"] = "/data/reports";
    const { runCli } = await import("./cli");
    try {
      await runCli(["node", "agent-bridge", "schedule", "add"]);
    } finally {
      // no-op; logs not needed here
    }

    const [, content] = writeFile.mock.calls[0] as [string, string, string];
    expect(content).toContain("directory: /data/reports");
  });

  it("writes a model: line when a model is answered", async () => {
    inputOverrides["Model (optional, blank = channel default)"] =
      "azure-openai-responses/gpt-5.6-terra";
    const { runCli } = await import("./cli");
    try {
      await runCli(["node", "agent-bridge", "schedule", "add"]);
    } finally {
      // no-op; logs not needed here
    }

    const [, content] = writeFile.mock.calls[0] as [string, string, string];
    expect(content).toContain("model: azure-openai-responses/gpt-5.6-terra");
  });

  it("omits the model: line when the model answer is blank", async () => {
    const { runCli } = await import("./cli");
    try {
      await runCli(["node", "agent-bridge", "schedule", "add"]);
    } finally {
      // no-op; logs not needed here
    }

    const [, content] = writeFile.mock.calls[0] as [string, string, string];
    expect(content).not.toContain("model:");
  });

  it("writes the English (default locale) example prompt regardless of channel language", async () => {
    // CHANNEL_WITH_DEMO is zh-CN; the prompt must still be the channel-agnostic default.
    loadConfig.mockImplementation(async () => CHANNEL_WITH_DEMO);
    const { runCli } = await import("./cli");
    try {
      await runCli(["node", "agent-bridge", "schedule", "add"]);
    } finally {
      // no-op; logs not needed here
    }

    const [, content] = writeFile.mock.calls[0] as [string, string, string];
    expect(content).toContain("Tell me what time it is right now, in one sentence.");
    expect(content).not.toContain("告诉我现在几点了");
  });
});

describe("runCli schedule list", () => {
  beforeEach(() => {
    resetPromptMocks();
    loadAllTasks.mockClear();
  });

  it("prints a table with one row per task and marks load errors", async () => {
    loadAllTasks.mockResolvedValue([
      makeLoadedTask({ channel: "alpha" }),
      makeLoadedTask(
        {
          name: "broken",
          scheduleRaw: "sometimes",
          schedule: null,
          enabled: false,
          channel: "beta",
        },
        { errors: ['invalid schedule "sometimes": unknown schedule type "sometimes"'] },
      ),
    ]);

    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "list"]);
    } finally {
      logs.restore();
    }

    const out = logs.lines.join("\n");
    // T2: Task is the first column; the Channel column is dropped entirely.
    expect(out).not.toContain("Channel");
    expect(out).toMatch(/^\s*Task\s+Schedule/);
    expect(out).toContain("Next run");
    expect(out).toContain("daily-report");
    expect(out).toContain("daily 09:00");
    expect(out).toContain("broken");
    expect(out).toContain("ERROR: invalid schedule");
    // alpha row: enabled yes, target no; broken row: enabled no
    expect(out).toContain("yes");
    expect(out).toContain("no");
  });

  it("prints a friendly hint when no tasks exist", async () => {
    loadAllTasks.mockResolvedValue([]);
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "list"]);
    } finally {
      logs.restore();
    }
    expect(logs.lines.join("\n")).toContain("No scheduled tasks found");
  });

  it("lists an unbound task without a Channel column (T2)", async () => {
    loadAllTasks.mockResolvedValue([makeLoadedTask()]);
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "list"]);
    } finally {
      logs.restore();
    }
    expect(logs.lines.join("\n")).toContain("daily-report");
    // Header has no Channel anywhere (neither header nor any cell).
    expect(logs.lines.join("\n")).not.toMatch(/Channel/);
  });
});

describe("runCli schedule remove", () => {
  beforeEach(() => {
    resetPromptMocks();
    loadAllTasks.mockClear();
    loadAllTasks.mockResolvedValue([makeLoadedTask()]);
    unlink.mockClear();
  });

  it("deletes the task file directly when the task exists", async () => {
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "remove", "daily-report"]);
    } finally {
      logs.restore();
    }

    // No prompts, no confirmation — direct delete.
    expect(promptCalls).toEqual([]);
    expect(unlink).toHaveBeenCalledWith("/tmp/schedules/daily-report.md");
    expect(logs.lines.join("\n")).toContain("Deleted /tmp/schedules/daily-report.md");
  });

  it("rejects an invalid task name without touching the filesystem", async () => {
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "schedule", "remove", "Bad_Name"]),
    ).rejects.toThrow("Task name must be [a-z0-9-]+");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("reports when no task with that name exists", async () => {
    loadAllTasks.mockResolvedValue([]);
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "schedule", "remove", "daily-report"]),
    ).rejects.toThrow('No scheduled task "daily-report" found.');
    expect(unlink).not.toHaveBeenCalled();
  });
});

describe("runCli schedule with no channels", () => {
  beforeEach(() => {
    resetPromptMocks();
    loadConfig.mockImplementation(async () => ({ channels: {}, defaults: { agentIdleTimeoutMs: 60_000 } }));
    loadAllTasks.mockClear();
    loadAllTasks.mockResolvedValue([]);
    mkdir.mockClear();
    writeFile.mockClear();
  });

  it("still creates a task with no channels configured (channel-agnostic)", async () => {
    const { runCli } = await import("./cli");
    await runCli(["node", "agent-bridge", "schedule", "add"]);
    const [filePath] = writeFile.mock.calls[0] as [string, string, string];
    expect(filePath).toBe("/tmp/schedules/daily-report.md");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("still lists unbound tasks with no channels configured", async () => {
    loadAllTasks.mockResolvedValue([makeLoadedTask()]);
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "list"]);
    } finally {
      logs.restore();
    }
    expect(logs.lines.join("\n")).toContain("daily-report");
  });
});

describe("queue wizard validators", () => {
  it("validateQueueNameInput enforces the slug shape and uniqueness", async () => {
    const { validateQueueNameInput } = await import("./cli");
    expect(validateQueueNameInput("inbox", new Set())).toBeNull();
    expect(validateQueueNameInput("Inbox", new Set())).toContain("[a-z0-9-]+");
    expect(validateQueueNameInput("inbox_x", new Set())).toContain("[a-z0-9-]+");
    expect(validateQueueNameInput("", new Set())).toContain("[a-z0-9-]+");
    expect(validateQueueNameInput("inbox", new Set(["inbox"]))).toContain("already exists");
  });

  it("validateWorkersInput accepts integers >= 1 and rejects everything else", async () => {
    const { validateWorkersInput } = await import("./cli");
    expect(validateWorkersInput("1")).toBeNull();
    expect(validateWorkersInput("12")).toBeNull();
    expect(validateWorkersInput("0")).toContain("positive integer");
    expect(validateWorkersInput("-1")).toContain("positive integer");
    expect(validateWorkersInput("2.5")).toContain("positive integer");
    expect(validateWorkersInput("abc")).toContain("positive integer");
  });
});

describe("runCli queue add", () => {
  beforeEach(() => {
    resetPromptMocks();
    delete inputOverrides["Queue name"];
    delete inputOverrides["Workers (default 1)"];
    delete inputOverrides["Timeout (default 5h)"];
    delete inputOverrides["Silence window (default 30m)"];
    delete inputOverrides["Model (optional, blank = channel default)"];
    delete inputOverrides["Working directory (optional, blank = bridge cwd)"];
    const bodyPrompt = BODY_PROMPT;
    delete inputOverrides[bodyPrompt];
    loadConfig.mockImplementation(async () => CHANNEL_WITH_DEMO);
    mkdir.mockClear();
    writeFile.mockClear();
    access.mockClear();
    rename.mockClear();
    access.mockRejectedValue(enoentError());
    listQueueDefinitions.mockClear();
    listQueueDefinitions.mockResolvedValue([]);
  });

  it("asks the unified question sequence and writes the queue file (T06)", async () => {
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "queue", "add"]);
    } finally {
      logs.restore();
    }

    // Unified wizard order (T06): name → workers → timeout → silence → model
    // → directory → body.
    expect(promptCalls).toEqual([
      "input:Queue name",
      "input:Workers (default 1)",
      "input:Timeout (default 5h)",
      "input:Silence window (default 30m)",
      "input:Model (optional, blank = channel default)",
      "input:Working directory (optional, blank = bridge cwd)",
      "input:Shared context body (optional, blank = empty; prepended to every task prompt)",
    ]);
    expect(promptCalls.some((call) => call.startsWith("select"))).toBe(false);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [, content] = writeFile.mock.calls[0] as [string, string, string];
    // No channel line: the queue is unbound until `/queue-here` writes both
    // channel and target (T1).
    expect(content).not.toContain("channel:");
    expect(content).toContain("workers: 1");
    // Default timeout/silence answers write their lines (T06).
    expect(content).toContain("timeout: 5h");
    expect(content).toContain("silence: 30m");
    // Blank model/directory/body answers write no line and an empty body.
    expect(content).not.toContain("model:");
    expect(content).not.toContain("directory:");
    // Atomic write commits to the queue file path.
    expect(rename).toHaveBeenCalledWith(expect.any(String), "/tmp/queues-test/inbox.md");
    const out = logs.lines.join("\n");
    expect(out).toContain("Created successfully!");
    expect(out).toContain("- Edit /tmp/queues-test/inbox.md to set the shared context.");
    expect(out).toContain("- Send `/queue-here inbox` in chat app to bind a chat.");
    expect(out).toContain("Insert tasks with `agent-bridge queue insert inbox --prompt");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("writes a timeout/silence line when a duration is answered and omits it when blank", async () => {
    inputOverrides["Timeout (default 5h)"] = "1h";
    inputOverrides["Silence window (default 30m)"] = "";
    const { runCli } = await import("./cli");
    try {
      await runCli(["node", "agent-bridge", "queue", "add"]);
    } finally {
      // no-op; logs not needed here
    }

    const [, content] = writeFile.mock.calls[0] as [string, string, string];
    expect(content).toContain("timeout: 1h");
    expect(content).not.toContain("silence:");
  });

  it("writes the shared context body when one is answered", async () => {
    inputOverrides[BODY_PROMPT] = "You are the release bot.";
    const { runCli } = await import("./cli");
    try {
      await runCli(["node", "agent-bridge", "queue", "add"]);
    } finally {
      // no-op; logs not needed here
    }

    const [, content] = writeFile.mock.calls[0] as [string, string, string];
    expect(content).toContain("You are the release bot.");
  });

  it("writes workers: 2 when a workers value is answered", async () => {
    inputOverrides["Workers (default 1)"] = "2";
    const { runCli } = await import("./cli");
    try {
      await runCli(["node", "agent-bridge", "queue", "add"]);
    } finally {
      // no-op; logs not needed here
    }

    const [, content] = writeFile.mock.calls[0] as [string, string, string];
    expect(content).toContain("workers: 2");
  });

  it("writes a model: line when a model is answered", async () => {
    inputOverrides["Model (optional, blank = channel default)"] =
      "azure-openai-responses/gpt-5.6-terra";
    const { runCli } = await import("./cli");
    try {
      await runCli(["node", "agent-bridge", "queue", "add"]);
    } finally {
      // no-op; logs not needed here
    }

    const [, content] = writeFile.mock.calls[0] as [string, string, string];
    expect(content).toContain("model: azure-openai-responses/gpt-5.6-terra");
    expect(content).not.toContain("channel:");
  });

  it("writes a directory: line when a working directory is answered", async () => {
    inputOverrides["Working directory (optional, blank = bridge cwd)"] = " /data/work ";
    const { runCli } = await import("./cli");
    try {
      await runCli(["node", "agent-bridge", "queue", "add"]);
    } finally {
      // no-op; logs not needed here
    }

    const [, content] = writeFile.mock.calls[0] as [string, string, string];
    expect(content).toContain("directory: /data/work");
  });

  it("creates a queue even when no channels are configured (no channel step anymore)", async () => {
    loadConfig.mockImplementation(async () => ({
      channels: {},
      defaults: { agentIdleTimeoutMs: 60_000 },
    }));
    const { runCli } = await import("./cli");
    await runCli(["node", "agent-bridge", "queue", "add"]);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("runCli queue insert", () => {
  beforeEach(() => {
    resetPromptMocks();
    loadQueueDefinition.mockClear();
    loadQueueDefinition.mockResolvedValue(null);
    insertQueueTask.mockClear();
    insertQueueTask.mockResolvedValue("1750000000000-abcd");
  });

  it("inserts a task and prints a confirmation with no warning when bound", async () => {
    loadQueueDefinition.mockResolvedValue(makeQueueDefinition({ target: "chat:123" }));
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli([
        "node",
        "agent-bridge",
        "queue",
        "insert",
        "inbox",
        "--prompt",
        "Do the thing.",
      ]);
    } finally {
      logs.restore();
    }

    expect(insertQueueTask).toHaveBeenCalledWith("inbox", "Do the thing.", undefined, {});
    const out = logs.lines.join("\n");
    expect(out).toContain('Inserted task 1750000000000-abcd into queue "inbox".');
    expect(out).not.toContain("no target yet");
  });

  it("passes --directory through as the task-level override", async () => {
    loadQueueDefinition.mockResolvedValue(makeQueueDefinition({ target: "chat:123" }));
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli([
        "node",
        "agent-bridge",
        "queue",
        "insert",
        "inbox",
        "--prompt",
        "Do the thing.",
        "--directory",
        "/data/work",
      ]);
    } finally {
      logs.restore();
    }

    expect(insertQueueTask).toHaveBeenCalledWith("inbox", "Do the thing.", undefined, {
      directory: "/data/work",
    });
  });

  it("passes --model/--timeout/--silence through as the task-level overrides (T03)", async () => {
    loadQueueDefinition.mockResolvedValue(makeQueueDefinition({ target: "chat:123" }));
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli([
        "node",
        "agent-bridge",
        "queue",
        "insert",
        "inbox",
        "--prompt",
        "Do the thing.",
        "--model",
        "azure-openai-responses/gpt-5.6-terra",
        "--timeout",
        "10m",
        "--silence",
        "30m",
      ]);
    } finally {
      logs.restore();
    }

    expect(insertQueueTask).toHaveBeenCalledWith("inbox", "Do the thing.", undefined, {
      model: "azure-openai-responses/gpt-5.6-terra",
      timeout: "10m",
      silence: "30m",
    });
  });

  it("rejects a bad --timeout before anything is written (T03)", async () => {
    loadQueueDefinition.mockResolvedValue(makeQueueDefinition({ target: "chat:123" }));
    const { runCli } = await import("./cli");
    await expect(
      runCli([
        "node",
        "agent-bridge",
        "queue",
        "insert",
        "inbox",
        "--prompt",
        "Do the thing.",
        "--timeout",
        "10x",
      ]),
    ).rejects.toThrow('Invalid value for --timeout: "10x"');
    expect(insertQueueTask).not.toHaveBeenCalled();
  });

  it("rejects a bad --silence before anything is written (T03)", async () => {
    loadQueueDefinition.mockResolvedValue(makeQueueDefinition({ target: "chat:123" }));
    const { runCli } = await import("./cli");
    await expect(
      runCli([
        "node",
        "agent-bridge",
        "queue",
        "insert",
        "inbox",
        "--prompt",
        "Do the thing.",
        "--silence",
        "forever",
      ]),
    ).rejects.toThrow('Invalid value for --silence: "forever"');
    expect(insertQueueTask).not.toHaveBeenCalled();
  });

  it("prints a warning when the queue has no target", async () => {
    loadQueueDefinition.mockResolvedValue(makeQueueDefinition());
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli([
        "node",
        "agent-bridge",
        "queue",
        "insert",
        "inbox",
        "--prompt",
        "Do the thing.",
      ]);
    } finally {
      logs.restore();
    }

    expect(insertQueueTask).toHaveBeenCalledWith("inbox", "Do the thing.", undefined, {});
    expect(logs.lines.join("\n")).toContain("Warning: the queue has no target yet");
  });

  it("fails with a non-zero exit when the queue is missing", async () => {
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "queue", "insert", "nope", "--prompt", "hi"]),
    ).rejects.toThrow('Queue "nope" not found.');
    expect(insertQueueTask).not.toHaveBeenCalled();
  });

  it("fails with a non-zero exit when the prompt is empty", async () => {
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "queue", "insert", "inbox", "--prompt", "   "]),
    ).rejects.toThrow("--prompt is required");
    expect(insertQueueTask).not.toHaveBeenCalled();
  });

  it("fails with a non-zero exit when --prompt is omitted", async () => {
    const { runCli } = await import("./cli");
    await expect(runCli(["node", "agent-bridge", "queue", "insert", "inbox"])).rejects.toThrow(
      "--prompt is required",
    );
    expect(insertQueueTask).not.toHaveBeenCalled();
  });
});

describe("runCli queue list", () => {
  beforeEach(() => {
    resetPromptMocks();
    listQueueDefinitions.mockClear();
    listQueueTasks.mockClear();
  });

  it("prints a table with per-queue model, bound and task counts", async () => {
    listQueueDefinitions.mockResolvedValue([
      // Bound queue with an owning channel (written at bind time).
      makeQueueDefinition({
        name: "inbox",
        workers: 2,
        channel: "demo",
        model: "azure-openai-responses/gpt-5.6-terra",
        target: "chat:1",
      }),
      // Unbound queue: no channel, no target — the Channel column shows `-`.
      makeQueueDefinition({ name: "todo", channel: undefined }),
    ]);
    listQueueTasks.mockImplementation(async (name: string) => {
      if (name === "inbox") {
        return [
          makeQueueTask({ state: "pending" }),
          makeQueueTask({ id: "1750000000001-0001", state: "pending" }),
          makeQueueTask({ id: "1750000000002-0002", state: "running" }),
        ];
      }
      return [makeQueueTask({ id: "1750000000003-0003", state: "pending" })];
    });

    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "queue", "list"]);
    } finally {
      logs.restore();
    }

    const out = logs.lines.join("\n");
    for (const header of ["Name", "Channel", "Workers", "Model", "Bound", "Pending", "Running"]) {
      expect(out).toContain(header);
    }
    expect(out).toContain("inbox");
    expect(out).toContain("todo");
    expect(out).toContain("gpt-5.6-terra");
    expect(out).toContain("yes");
    expect(out).toContain("no");
    // Bound queue shows its owning channel; the unbound one shows `-`.
    expect(out).toContain("demo");
    expect(out).toContain("-");
    // Counts: inbox 2 pending + 1 running; todo 1 pending + 0 running.
    expect(out).toContain("2");
    expect(out).toContain("0");
  });

  it("prints a friendly hint when no queues exist", async () => {
    listQueueDefinitions.mockResolvedValue([]);
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "queue", "list"]);
    } finally {
      logs.restore();
    }
    expect(logs.lines.join("\n")).toContain("No queues found");
    expect(listQueueTasks).not.toHaveBeenCalled();
  });
});

describe("runCli queue remove", () => {
  beforeEach(() => {
    resetPromptMocks();
    listQueueDefinitions.mockClear();
    unlink.mockClear();
    rm.mockClear();
  });

  it("deletes the queue definition file AND its tasks directory recursively", async () => {
    listQueueDefinitions.mockResolvedValue([
      makeQueueDefinition({ name: "inbox", channel: undefined }),
    ]);
    // Real (unmocked) path helpers from the mocked module, imported lazily so
    // the vi.mock hoisting is unaffected.
    const { getQueueFilePath, getQueueTasksDir } = await import("./modules/queue/queue-file");
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "queue", "remove", "inbox"]);
    } finally {
      logs.restore();
    }

    // No prompts, no confirmation — direct delete, like `schedule remove`.
    expect(promptCalls).toEqual([]);
    // The tasks dir is removed recursively (pending tasks die with the queue)
    // and the definition file is unlinked.
    expect(rm).toHaveBeenCalledWith(getQueueTasksDir("inbox"), {
      recursive: true,
      force: true,
    });
    expect(unlink).toHaveBeenCalledWith(getQueueFilePath("inbox"));
    // Both paths are printed.
    const out = logs.lines.join("\n");
    expect(out).toContain(`Deleted ${getQueueTasksDir("inbox")}`);
    expect(out).toContain(`Deleted ${getQueueFilePath("inbox")}`);
  });

  it("rejects an invalid queue name without touching the filesystem", async () => {
    const { runCli } = await import("./cli");
    await expect(runCli(["node", "agent-bridge", "queue", "remove", "Bad_Name"])).rejects.toThrow(
      "Queue name must be [a-z0-9-]+",
    );
    expect(rm).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it("reports when no queue with that name exists", async () => {
    listQueueDefinitions.mockResolvedValue([]);
    const { runCli } = await import("./cli");
    await expect(runCli(["node", "agent-bridge", "queue", "remove", "inbox"])).rejects.toThrow(
      'No queue "inbox" found.',
    );
    expect(rm).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// history subcommands (run-history spec D7). The readRunHistory reader runs
// against the mocked node:fs/promises, so each test seeds `readFile` with a
// JSONL payload keyed by the history file path (RUN_HISTORY_DIR-based, same
// layout the reader builds) — no real fs is touched.
// ---------------------------------------------------------------------------

describe("history helpers", () => {
  it("formatDuration renders human-readable durations", async () => {
    const { formatDuration } = await import("./cli");
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(45_123)).toBe("45s");
    expect(formatDuration(252_000)).toBe("4m12s");
    expect(formatDuration(3_723_000)).toBe("1h2m3s");
  });

  it("parseQueueRunId splits at the FIRST colon after the queue: prefix", async () => {
    const { parseQueueRunId } = await import("./cli");
    // taskId may contain `-`; the queue name never contains `:`.
    expect(parseQueueRunId("queue:build:1787134243550-6727")).toBe("build");
    expect(parseQueueRunId("queue:my-queue:1787134243550-6727")).toBe("my-queue");
    expect(parseQueueRunId("schedule:task:20260820-090000-1")).toBeNull();
    expect(parseQueueRunId("queue:noname")).toBeNull();
    expect(parseQueueRunId("queue::1234-abcd")).toBeNull();
  });
});

/** History-row fixture (spec D2 fields). */
function makeHistoryLine(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    runId: "schedule:daily-report:20260820-090000-1",
    ts: "2026-08-20T01:00:00.000Z",
    ms: 252_000,
    outcome: "completed",
    channel: "demo",
    file: "/tmp/run-outputs/daily-report.md",
    ...overrides,
  })}\n`;
}

/** Seeds the mocked fs with JSONL content per history file path. */
function seedHistory(files: Record<string, string>): void {
  readFile.mockImplementation(async (p: unknown) => {
    const key = String(p);
    if (key in files) return files[key]!;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
}

describe("runCli schedule history", () => {
  beforeEach(() => {
    resetPromptMocks();
    readFile.mockReset();
    readFile.mockImplementation(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  it("prints a friendly hint when there is no history (missing file)", async () => {
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "history"]);
    } finally {
      logs.restore();
    }
    expect(logs.lines.join("\n")).toContain("No run history found");
  });

  it("prints the full table with all columns, newest first", async () => {
    const { RUN_HISTORY_DIR } = await import("./config/channel-state");
    seedHistory({
      [`${RUN_HISTORY_DIR}/schedule.jsonl`]: [
        makeHistoryLine(), // 01:00 completed, daily-report
        makeHistoryLine({
          runId: "schedule:backup:20260820-093000-2",
          ts: "2026-08-20T01:30:00.000Z",
          outcome: "failed",
          reason: "boom",
          ms: 45_000,
        }),
      ].join(""),
    });

    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "history"]);
    } finally {
      logs.restore();
    }

    const out = logs.lines.join("\n");
    for (const header of ["Time", "Name", "Outcome", "Duration", "Reason", "File"]) {
      expect(out).toContain(header);
    }
    expect(out).toContain("daily-report");
    expect(out).toContain("backup");
    expect(out).toContain("4m12s");
    expect(out).toContain("45s");
    expect(out).toContain("boom");
    expect(out).toContain("-"); // Reason placeholder on the completed row
    // Newest first: the 01:30 row precedes the 01:00 row.
    expect(out.indexOf("backup")).toBeLessThan(out.indexOf("daily-report"));
  });

  it("filters by task name", async () => {
    const { RUN_HISTORY_DIR } = await import("./config/channel-state");
    seedHistory({
      [`${RUN_HISTORY_DIR}/schedule.jsonl`]: [
        makeHistoryLine(),
        makeHistoryLine({ runId: "schedule:backup:20260820-093000-2", ts: "2026-08-20T01:30:00.000Z" }),
      ].join(""),
    });

    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "history", "daily-report"]);
    } finally {
      logs.restore();
    }

    const out = logs.lines.join("\n");
    expect(out).toContain("daily-report");
    expect(out).not.toContain("backup");
  });

  it("prints a task-specific hint when the filtered name has no history", async () => {
    const { RUN_HISTORY_DIR } = await import("./config/channel-state");
    seedHistory({ [`${RUN_HISTORY_DIR}/schedule.jsonl`]: makeHistoryLine() });
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "history", "no-such-task"]);
    } finally {
      logs.restore();
    }
    expect(logs.lines.join("\n")).toContain('No run history found for scheduled task "no-such-task".');
  });

  it("skips malformed lines and rows whose runId does not parse as a schedule id", async () => {
    const { RUN_HISTORY_DIR } = await import("./config/channel-state");
    seedHistory({
      [`${RUN_HISTORY_DIR}/schedule.jsonl`]: [
        "{not json\n", // malformed JSON: skipped by the reader
        makeHistoryLine({ runId: "queue:build:1787134243550-6727" }), // wrong kind
        makeHistoryLine({ runId: "schedule:daily-report:20260821-090000-1", ts: "2026-08-21T01:00:00.000Z" }),
      ].join(""),
    });
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "history"]);
    } finally {
      logs.restore();
    }

    const out = logs.lines.join("\n");
    expect(out).toContain("daily-report");
    expect(out).not.toContain("build"); // wrong-kind runId row skipped
    // Table rows only: header + one data row.
    expect(logs.lines).toHaveLength(2);
  });
});

describe("runCli queue history", () => {
  beforeEach(() => {
    resetPromptMocks();
    readFile.mockReset();
    readFile.mockImplementation(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  it("prints a friendly hint when the queue has no history", async () => {
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "queue", "history", "build"]);
    } finally {
      logs.restore();
    }
    expect(logs.lines.join("\n")).toContain('No run history found for queue "build".');
  });

  it("prints only the named queue's rows, newest first", async () => {
    const { RUN_HISTORY_DIR } = await import("./config/channel-state");
    seedHistory({
      [`${RUN_HISTORY_DIR}/queue.jsonl`]: [
        makeHistoryLine({ runId: "queue:build:1787134243550-6727", ms: 90_000 }),
        makeHistoryLine({
          runId: "queue:build:1787134243999-aaaa",
          ts: "2026-08-20T02:00:00.000Z",
          outcome: "fire-failed",
          reason: "boom: model not available",
          ms: 1_500,
        }),
        makeHistoryLine({ runId: "queue:other:1787134243551-bbbb", ts: "2026-08-20T03:00:00.000Z" }),
      ].join(""),
    });

    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "queue", "history", "build"]);
    } finally {
      logs.restore();
    }

    const out = logs.lines.join("\n");
    expect(out).toContain("build");
    expect(out).not.toContain("other");
    // Duration formatting: 90s and 1.5s; fire-failed reason is shown.
    expect(out).toContain("1m30s");
    expect(out).toContain("1s");
    expect(out).toContain("boom: model not available");
    // Newest first: the 02:00 row precedes the 01:00 row.
    expect(out.indexOf("1s")).toBeLessThan(out.indexOf("1m30s"));
    // Table rows only: header + two data rows.
    expect(logs.lines).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// `queue retry <queue> <task-id>` (spec D2/T02). The queue-file module is
// mocked at the top (listQueueDefinitions/loadQueueDefinition/insertQueueTask/
// listQueueTasks overridden; the rest is the real module), so the real
// retryQueueTask is wired through a spy below per test.
// ---------------------------------------------------------------------------

describe("runCli queue retry", () => {
  beforeEach(() => {
    resetPromptMocks();
    listQueueTasks.mockClear();
    listQueueTasks.mockResolvedValue([]);
  });

  it("re-queues a failed task: state back to pending, dead-letter lines cleared", async () => {
    const queueFile = await import("./modules/queue/queue-file");
    // Seed a real failed task file under the fixed temp root via the mocked
    // node:fs/promises: writeQueueDefinition-equivalent seeding is overkill;
    // retryQueueTask itself is spied, so assert the call-through and output.
    const retrySpy = vi
      .spyOn(queueFile, "retryQueueTask")
      .mockResolvedValue({ ok: true });
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "queue", "retry", "inbox", "1750000000000-abcd"]);
    } finally {
      logs.restore();
    }
    expect(retrySpy).toHaveBeenCalledWith("inbox", "1750000000000-abcd");
    expect(logs.lines.join("\n")).toContain(
      're-queued (state: pending)',
    );
    expect(logs.lines.join("\n")).toContain("1750000000000-abcd");
    retrySpy.mockRestore();
  });

  it("rejects a task that is not in the failed state", async () => {
    const queueFile = await import("./modules/queue/queue-file");
    const retrySpy = vi.spyOn(queueFile, "retryQueueTask").mockResolvedValue({
      ok: false,
      reason: 'task "1750000000000-abcd" is not failed (state: running) — only failed tasks can be retried',
    });
    listQueueTasks.mockResolvedValue([makeQueueTask({ state: "running" })]);
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "queue", "retry", "inbox", "1750000000000-abcd"]),
    ).rejects.toThrow(/not failed.*running/);
    retrySpy.mockRestore();
  });

  it("rejects a missing task", async () => {
    const queueFile = await import("./modules/queue/queue-file");
    const retrySpy = vi.spyOn(queueFile, "retryQueueTask").mockResolvedValue({
      ok: false,
      reason: 'task "1750000000000-abcd" not found in queue "inbox"',
    });
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "queue", "retry", "inbox", "1750000000000-abcd"]),
    ).rejects.toThrow('Task "1750000000000-abcd" not found in queue "inbox".');
    retrySpy.mockRestore();
  });

  it("rejects an invalid task id shape", async () => {
    const queueFile = await import("./modules/queue/queue-file");
    const retrySpy = vi.spyOn(queueFile, "retryQueueTask");
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "queue", "retry", "inbox", "not-an-id"]),
    ).rejects.toThrow('Task "not-an-id" not found in queue "inbox".');
    expect(retrySpy).not.toHaveBeenCalled();
    retrySpy.mockRestore();
  });

  it("rejects an invalid queue name without touching storage", async () => {
    const queueFile = await import("./modules/queue/queue-file");
    const retrySpy = vi.spyOn(queueFile, "retryQueueTask");
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "queue", "retry", "Bad_Name", "1750000000000-abcd"]),
    ).rejects.toThrow("Queue name must be [a-z0-9-]+");
    expect(retrySpy).not.toHaveBeenCalled();
    retrySpy.mockRestore();
  });

  it("end-to-end against the real writers: failed task file is flipped to pending and cleaned", async () => {
    // Drive the REAL retryQueueTask through the mocked node:fs/promises the
    // same way the queue add wizard tests do (fixed temp root). The real
    // function is captured from the mocked module BEFORE it is spied (the
    // vi.mock spread keeps the original export reachable).
    const queueFile = await import("./modules/queue/queue-file");
    const realRetry = queueFile.retryQueueTask;
    const taskPath = `${TEST_QUEUES_ROOT}/inbox.tasks/1750000000000-abcd.md`;
    // Seed: the real retryQueueTask reads the failed task file via readFile.
    (readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p: unknown) => {
      if (String(p) === taskPath) {
        return "---\nstate: failed\nenqueuedAt: 2026-08-19T08:00:00.000Z\nfailedAt: 2026-08-20T08:00:00.000Z\nreason: boom\nagentSessionId: pi-coding-agent:1\n---\n\nDo the thing.\n";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    let written = "";
    (writeFile as ReturnType<typeof vi.fn>).mockImplementation(
      async (_p: unknown, content: unknown) => {
        written = String(content);
      },
    );
    const retrySpy = vi
      .spyOn(queueFile, "retryQueueTask")
      .mockImplementation(((name: string, taskId: string, root?: string) =>
        realRetry(name, taskId, root ?? TEST_QUEUES_ROOT)) as typeof realRetry);
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "queue", "retry", "inbox", "1750000000000-abcd"]);
    } finally {
      logs.restore();
    }
    // ONE atomic write: state back to pending, all three dead-letter lines
    // removed, body and enqueuedAt intact.
    expect(written).toBe(
      "---\nstate: pending\nenqueuedAt: 2026-08-19T08:00:00.000Z\n---\n\nDo the thing.\n",
    );
    expect(logs.lines.join("\n")).toContain("re-queued (state: pending)");
    retrySpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// `schedule run <task-name>` (spec D6/T06). The Scheduler module is mocked at
// the top (the class constructor captured; runNow/start/stop are spies), so
// these tests assert the CLI's wiring and outputs without a real runtime.
// ---------------------------------------------------------------------------

describe("runCli schedule run", () => {
  /** Mutable wait knobs from the module under test (set per test). */
  let WAIT: { pollMs: number; graceMs: number; extraTimeoutMs: number };
  beforeEach(async () => {
    resetPromptMocks();
    // A configured channel is the default fixture; the no-channels test
    // overrides it back to an empty config.
    loadConfig.mockImplementation(async () => CHANNEL_WITH_DEMO);
    loadAllTasks.mockClear();
    loadAllTasks.mockResolvedValue([makeLoadedTask()]);
    schedulerRunNow.mockResolvedValue({ ok: true });
    // Shrink the settle-wait knobs so the history polling stays fast; the
    // mocked run-history reader throws ENOENT, which the settle-wait
    // swallows, so the bounded deadline (extraTimeoutMs) releases the wait.
    ({ SCHEDULE_RUN_WAIT: WAIT } = await import("./cli"));
    WAIT.pollMs = 1;
    WAIT.graceMs = 1;
    WAIT.extraTimeoutMs = 50;
  });

  it("constructs the one-shot scheduler, calls runNow and prints the trigger confirmation", async () => {
    // A fresh terminal history line makes the wait settle immediately.
    const { RUN_HISTORY_DIR } = await import("./config/channel-state");
    WAIT.extraTimeoutMs = 60_000;
    seedHistory({
      [`${RUN_HISTORY_DIR}/schedule.jsonl`]: makeHistoryLine({ ts: new Date().toISOString() }),
    });
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "run", "daily-report"]);
    } finally {
      logs.restore();
    }
    seedHistory({});

    // Existence check first, then the trigger through the Scheduler entry.
    expect(loadAllTasks).toHaveBeenCalledWith();
    expect(schedulerRunNow).toHaveBeenCalledWith("daily-report");
    expect(schedulerStart).toHaveBeenCalledTimes(1);
    expect(schedulerStop).toHaveBeenCalledTimes(1);
    // The one-shot channel brings the client adapter online before the fire
    // (deliveries must resolve the target chat) and stops scheduler/core in
    // the teardown order.
    expect(fakeClientModule.createClientAdapter).toHaveBeenCalled();
    expect(coreStart).toHaveBeenCalledTimes(1);
    expect(coreStop).toHaveBeenCalledTimes(1);
    expect(logs.lines.join("\n")).toContain(
      'Scheduled task "daily-report" triggered — the run result will be delivered to the task\'s target chat.',
    );
  });
  it("validates the task name shape before touching storage", async () => {
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "schedule", "run", "Bad_Name"]),
    ).rejects.toThrow("Task name must be [a-z0-9-]+");
    expect(loadAllTasks).not.toHaveBeenCalled();
    expect(schedulerRunNow).not.toHaveBeenCalled();
  });

  it("waits for the run's terminal history line, then prints the success message (settled)", async () => {
    // Seed a terminal history line whose ts is NEWER than the CLI's sinceIso
    // (fresh run): the settle-wait must release on it BEFORE the bounded
    // deadline (extraTimeoutMs = 60 s here) fires.
    const { RUN_HISTORY_DIR } = await import("./config/channel-state");
    WAIT.pollMs = 5;
    WAIT.graceMs = 1;
    WAIT.extraTimeoutMs = 60_000;
    const started = Date.now();
    seedHistory({
      [`${RUN_HISTORY_DIR}/schedule.jsonl`]: makeHistoryLine({ ts: new Date().toISOString() }),
    });
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "run", "daily-report"]);
    } finally {
      logs.restore();
    }
    // Released by the history line, not by the 60 s deadline; the success
    // message is printed only on the settled path.
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(coreStop).toHaveBeenCalledTimes(1);
    expect(logs.lines.join("\n")).toContain(
      'Scheduled task "daily-report" triggered — the run result will be delivered to the task\'s target chat.',
    );
    seedHistory({});
  }, 20_000);

  it("prints the not-settled warning (not success) when the bounded wait times out", async () => {
    // No history at all (reader throws ENOENT): the wait runs to the bound
    // (task timeout 10ms + extraTimeoutMs 20ms) and must NOT print the
    // success message — the one-shot teardown kills a still-running run only
    // past its own timeout bound.
    loadAllTasks.mockResolvedValue([makeLoadedTask({ timeoutMs: 10 })]);
    WAIT.pollMs = 1;
    WAIT.graceMs = 1;
    WAIT.extraTimeoutMs = 20;
    const { runCli } = await import("./cli");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "run", "daily-report"]);
    } finally {
      logs.restore();
      errSpy.mockRestore();
    }
    const out = logs.lines.join("\n");
    expect(out).not.toContain(
      "triggered — the run result will be delivered",
    );
    // Still tears the channel down (the run is past its own timeout bound).
    expect(schedulerStop).toHaveBeenCalledTimes(1);
    expect(coreStop).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("prints the interrupted warning and exits non-zero when SIGINT lands mid-wait", async () => {
    // Flip the SIGINT flag a moment after runNow is accepted; the wait must
    // end as interrupted: warning on stderr, non-zero exit code, no success
    // message, teardown still performed.
    WAIT.pollMs = 5;
    WAIT.graceMs = 1;
    WAIT.extraTimeoutMs = 60_000;
    schedulerRunNow.mockImplementation(async () => {
      process.emit("SIGINT");
      return { ok: true };
    });
    const { runCli } = await import("./cli");
    const errLines: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errLines.push(args.map(String).join(" "));
    });
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "run", "daily-report"]);
    } finally {
      logs.restore();
      errSpy.mockRestore();
    }
    const out = logs.lines.join("\n");
    expect(out).not.toContain("triggered — the run result will be delivered");
    expect(errLines.join("\n")).toContain("interrupted by user (SIGINT)");
    expect(process.exitCode).toBe(1);
    expect(schedulerStop).toHaveBeenCalledTimes(1);
    expect(coreStop).toHaveBeenCalledTimes(1);
    process.exitCode = 0;
  }, 20_000);

  it("passes the configured working-directory allowlist into the one-shot core", async () => {
    loadConfig.mockImplementation(async () => ({
      channels: CHANNEL_WITH_DEMO.channels,
      defaults: {
        agentIdleTimeoutMs: 60_000,
        allowedWorkingDirectoryRoots: ["/srv/work"],
      },
    }));
    // A fresh terminal history line makes the wait settle immediately.
    const { RUN_HISTORY_DIR } = await import("./config/channel-state");
    WAIT.extraTimeoutMs = 60_000;
    seedHistory({
      [`${RUN_HISTORY_DIR}/schedule.jsonl`]: makeHistoryLine({ ts: new Date().toISOString() }),
    });
    const { runCli } = await import("./cli");
    const gatewayCore = await import("./core/gateway-core");
    const coreMock = vi.mocked(gatewayCore.GatewayCore);
    const callsBefore = coreMock.mock.calls.length;
    await runCli(["node", "agent-bridge", "schedule", "run", "daily-report"]);
    seedHistory({});
    const coreOptions = coreMock.mock.calls[callsBefore][0] as {
      allowedWorkingDirectoryRoots?: string[];
      agentIdleTimeoutMs: number;
    };
    expect(coreOptions.allowedWorkingDirectoryRoots).toEqual(["/srv/work"]);
    expect(coreOptions.agentIdleTimeoutMs).toBe(60_000);
  }, 20_000);

  it("errors without constructing a scheduler when the task does not exist", async () => {
    loadAllTasks.mockResolvedValue([]);
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "schedule", "run", "daily-report"]),
    ).rejects.toThrow('No scheduled task "daily-report" found.');
    expect(schedulerRunNow).not.toHaveBeenCalled();
    expect(schedulerCtorArgs.length).toBe(0);
  });

  it("maps a failed FireResult onto a localized error with the reason", async () => {
    schedulerRunNow.mockResolvedValue({ ok: false, reason: "task has no valid target" });
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "schedule", "run", "daily-report"]),
    ).rejects.toThrow('Failed to trigger scheduled task "daily-report": task has no valid target');
    expect(schedulerStop).toHaveBeenCalledTimes(1);
    expect(coreStop).toHaveBeenCalledTimes(1);
  });

  it("wires the owning channel's agent module and validates the target with the client module", async () => {
    loadConfig.mockImplementation(async () => CHANNEL_WITH_DEMO);
    loadAllTasks.mockResolvedValue([
      makeLoadedTask({ channel: "demo", target: "feishu:dm:oc_x" }),
    ]);
    // A fresh terminal history line makes the wait settle immediately.
    const { RUN_HISTORY_DIR } = await import("./config/channel-state");
    WAIT.extraTimeoutMs = 60_000;
    seedHistory({
      [`${RUN_HISTORY_DIR}/schedule.jsonl`]: makeHistoryLine({ ts: new Date().toISOString() }),
    });
    const { runCli } = await import("./cli");
    const gatewayCore = await import("./core/gateway-core");
    const coreMock = vi.mocked(gatewayCore.GatewayCore);
    const coreCallsBefore = coreMock.mock.calls.length;
    await runCli(["node", "agent-bridge", "schedule", "run", "daily-report"]);
    seedHistory({});

    // The core is constructed exactly once (for the task's owning channel).
    expect(coreMock.mock.calls.length - coreCallsBefore).toBe(1);
    // The scheduler bridges dispatch through the core and validates targets
    // with the client module's session-id parser.
    const options = lastSchedulerOptions();
    expect(typeof options.dispatchClientEvent).toBe("function");
    expect(typeof options.validateTarget).toBe("function");
  });

  it("rejects a task whose owning channel is not configured", async () => {
    loadAllTasks.mockResolvedValue([makeLoadedTask({ channel: "ghost" })]);
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "schedule", "run", "daily-report"]),
    ).rejects.toThrow('bound to channel "ghost"');
    expect(schedulerRunNow).not.toHaveBeenCalled();
  });

  it("reports when no channels are configured at all", async () => {
    loadConfig.mockImplementation(async () => ({
      channels: {},
      defaults: { agentIdleTimeoutMs: 60_000 },
    }));
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "schedule", "run", "daily-report"]),
    ).rejects.toThrow("No channels are configured");
    expect(schedulerRunNow).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// i18n completeness (T06): every key the CLI touches must exist in BOTH
// locales and produce non-empty, distinct-from-the-key strings. en-US is the
// fallback locale, so a missing zh key would silently render English — the
// explicit parity check below catches that.
// ---------------------------------------------------------------------------

describe("i18n cli key parity (en-US / zh-CN)", () => {
  const CLI_KEYS = [
    "cli.examplePrompt",
    "cli.queueNamePrompt",
    "cli.queueNameInvalid",
    "cli.queueNameExists",
    "cli.workersPrompt",
    "cli.workersInvalid",
    "cli.modelPrompt",
    "cli.directoryPrompt",
    "cli.timeoutPrompt",
    "cli.silencePrompt",
    "cli.modelPlaceholder",
    "cli.bodyPrompt",
    "cli.taskNamePrompt",
    "cli.taskNameInvalid",
    "cli.taskNameExists",
    "cli.schedulePrompt",
    "cli.scheduleInvalid",
    "cli.taskCreated",
    "cli.taskCreatedGuideFile",
    "cli.taskCreatedGuideTarget",
    "cli.queueCreated",
    "cli.queueCreatedGuideFile",
    "cli.queueCreatedGuideBind",
    "cli.queueCreatedGuideInsert",
    "cli.queueInserted",
    "cli.queueInsertPromptRequired",
    "cli.queueInsertInvalidDuration",
    "cli.queueInsertUnboundWarning",
    "cli.queueNotFound",
    "cli.noQueues",
    "cli.queueRetried",
    "cli.queueRetryTaskNotFound",
    "cli.queueRetryNotFailed",
    "cli.scheduleRunTriggered",
    "cli.scheduleRunWaitNotSettled",
    "cli.scheduleRunWaitInterrupted",
    "cli.scheduleRunWaitTimeout",
    "cli.scheduleRunFailed",
    "cli.scheduleRunTaskNotFound",
    "cli.scheduleRunNoChannels",
    "cli.scheduleRunChannelNotFound",
  ] as const;

  it("has a non-empty translation for every cli key in both locales", async () => {
    const { getTranslator } = await import("./i18n");
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");
    for (const key of CLI_KEYS) {
      expect(en(key as never), `en-US missing ${key}`).toBeTruthy();
      expect(en(key as never), `en-US ${key} is the raw key`).not.toBe(key);
      expect(zh(key as never), `zh-CN missing ${key}`).toBeTruthy();
      expect(zh(key as never), `zh-CN ${key} is the raw key`).not.toBe(key);
    }
  });

  it("renders the localized schedule prompt with examples in both locales", async () => {
    const { getTranslator } = await import("./i18n");
    const examples = "every 5m, daily 09:00";
    expect(getTranslator("en-US")("cli.schedulePrompt", { examples })).toBe(
      `Schedule (examples: ${examples})`,
    );
    expect(getTranslator("zh-CN")("cli.schedulePrompt", { examples })).toBe(
      `定时表达式（示例：${examples}）`,
    );
  });
});
