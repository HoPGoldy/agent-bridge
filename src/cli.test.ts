import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedTask, ScheduleTask } from "./modules/schedule/task-file";

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
  if (label === "Working directory (optional, blank = bridge cwd)") return "";
  if (label === "Timeout (default 10m)") return "10m";
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
const loadChannelTasks = vi.fn(async () => []);
const getSchedulesDir = vi.fn((channel: string) => `/tmp/schedules/${channel}`);

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
}));

vi.mock("./modules/agent", () => ({
  listAgentModules: () => [fakeAgentModule],
  getAgentModule: (type: string) => (type === "fake-agent" ? fakeAgentModule : undefined),
}));

vi.mock("./core/channel-runner", () => ({
  runChannel: vi.fn(),
}));

vi.mock("./config/session-bindings", () => ({
  removeSessionBindingStore: vi.fn(async () => {}),
}));

vi.mock("node:fs/promises", () => ({ mkdir, writeFile, unlink }));

vi.mock("./modules/schedule/task-file", async (importOriginal) => {
  const original = await importOriginal<typeof import("./modules/schedule/task-file")>();
  return { ...original, loadChannelTasks, getSchedulesDir };
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
      timeoutMs: 600_000,
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
  it("validateTaskNameInput enforces the slug shape and channel-local uniqueness", async () => {
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
    // The task-file module is mocked above (loadChannelTasks/getSchedulesDir
    // replaced with vi.fn), but vi.importActual bypasses that mock entirely and
    // returns the genuine T2 parser. parseTaskFile is a pure function (no fs
    // access), so it works unchanged even though node:fs/promises is mocked.
    const { parseTaskFile } = await vi.importActual<typeof import("./modules/schedule/task-file")>(
      "./modules/schedule/task-file",
    );
    const { buildTaskFileContent } = await import("./cli");

    // Full form: schedule + directory + timeout must round-trip field-for-field.
    const full = buildTaskFileContent({
      schedule: "daily 09:00",
      timeout: "30m",
      directory: "~/reports",
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
      enabled: true,
    });

    // Minimal form (no directory key) and the CLI's blank-directory path (the
    // add wizard passes directory: "") must both parse with zero diagnostics.
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
    delete inputOverrides["Working directory (optional, blank = bridge cwd)"];
    loadConfig.mockImplementation(async () => CHANNEL_WITH_DEMO);
    loadChannelTasks.mockResolvedValue([]);
    mkdir.mockClear();
    writeFile.mockClear();
  });

  it("writes a task file with the collected values and prints path + targeting instruction", async () => {
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "add"]);
    } finally {
      logs.restore();
    }

    expect(promptCalls).toEqual([
      "select:Select channel",
      "input:Task name",
      "input:Schedule (examples: every 5m, daily 09:00, weekly mon 09:00, monthly 15 09:00)",
      "input:Working directory (optional, blank = bridge cwd)",
      "input:Timeout (default 10m)",
    ]);
    expect(loadChannelTasks).toHaveBeenCalledWith("demo");
    expect(mkdir).toHaveBeenCalledWith("/tmp/schedules/demo", { recursive: true });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [filePath, content] = writeFile.mock.calls[0] as [string, string, string];
    expect(filePath).toBe("/tmp/schedules/demo/daily-report.md");
    expect(content).toContain("schedule: daily 09:00");
    expect(content).toContain("timeout: 10m");
    expect(content).not.toContain("directory:");
    // demo channel is zh-CN (CHANNEL_WITH_DEMO): the example prompt is localized.
    expect(content).toContain("告诉我现在几点了，一句话就好。");
    expect(logs.lines.join("\n")).toContain("Created /tmp/schedules/demo/daily-report.md");
    expect(logs.lines.join("\n")).toContain(
      "Edit /tmp/schedules/demo/daily-report.md to set your prompt.",
    );
    expect(logs.lines.join("\n")).toContain(
      "To set the destination chat, send `/schedule-here daily-report` in target chat.",
    );
    expect(logs.lines.join("\n")).not.toContain("/st");
    expect(close).toHaveBeenCalledTimes(1);
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

  it("writes the English example prompt for an en-US channel", async () => {
    loadConfig.mockImplementation(async () => ({
      channels: {
        demo: {
          common: { language: "en-US" },
          client: { type: "fake-client", config: {} },
          agent: { type: "fake-agent", config: {} },
        },
      },
      defaults: { agentIdleTimeoutMs: 60_000 },
    }));
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
    loadConfig.mockImplementation(async () => ({
      channels: {
        alpha: {
          common: { language: "en-US" },
          client: { type: "fake-client", config: {} },
          agent: { type: "fake-agent", config: {} },
        },
        beta: {
          common: { language: "en-US" },
          client: { type: "fake-client", config: {} },
          agent: { type: "fake-agent", config: {} },
        },
      },
      defaults: { agentIdleTimeoutMs: 60_000 },
    }));
    loadChannelTasks.mockClear();
  });

  it("prints a table with one row per task and marks load errors", async () => {
    loadChannelTasks.mockImplementation(async (channel: string) => {
      if (channel === "alpha") return [makeLoadedTask()];
      if (channel === "beta") {
        return [
          makeLoadedTask(
            { name: "broken", scheduleRaw: "sometimes", schedule: null, enabled: false },
            { errors: ['invalid schedule "sometimes": unknown schedule type "sometimes"'] },
          ),
        ];
      }
      return [];
    });

    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "list"]);
    } finally {
      logs.restore();
    }

    const out = logs.lines.join("\n");
    expect(out).toContain("Channel");
    expect(out).toContain("Next run");
    expect(out).toContain("alpha");
    expect(out).toContain("daily-report");
    expect(out).toContain("daily 09:00");
    expect(out).toContain("beta");
    expect(out).toContain("broken");
    expect(out).toContain("ERROR: invalid schedule");
    // alpha row: enabled yes, target no; broken row: enabled no
    expect(out).toContain("yes");
    expect(out).toContain("no");
  });

  it("prints a friendly hint when no tasks exist", async () => {
    loadChannelTasks.mockResolvedValue([]);
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "list"]);
    } finally {
      logs.restore();
    }
    expect(logs.lines.join("\n")).toContain("No scheduled tasks found");
  });
});

describe("runCli schedule remove", () => {
  beforeEach(() => {
    resetPromptMocks();
    loadConfig.mockImplementation(async () => CHANNEL_WITH_DEMO);
    loadChannelTasks.mockResolvedValue([makeLoadedTask()]);
    unlink.mockClear();
  });

  it("deletes the task file directly when the name matches exactly one channel", async () => {
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "remove", "daily-report"]);
    } finally {
      logs.restore();
    }

    // No prompts, no confirmation — direct delete.
    expect(promptCalls).toEqual([]);
    expect(unlink).toHaveBeenCalledWith("/tmp/schedules/demo/daily-report.md");
    expect(logs.lines.join("\n")).toContain("Deleted /tmp/schedules/demo/daily-report.md");
  });

  it("rejects an invalid task name without touching the filesystem", async () => {
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "schedule", "remove", "Bad_Name"]),
    ).rejects.toThrow("Task name must be [a-z0-9-]+");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("reports when no channel has the task", async () => {
    loadChannelTasks.mockResolvedValue([]);
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "schedule", "remove", "daily-report"]),
    ).rejects.toThrow('No scheduled task "daily-report" found.');
    expect(unlink).not.toHaveBeenCalled();
  });

  it("refuses to choose when the name exists in multiple channels", async () => {
    loadConfig.mockImplementation(async () => ({
      channels: {
        demo: CHANNEL_WITH_DEMO.channels.demo,
        other: CHANNEL_WITH_DEMO.channels.demo,
      },
      defaults: CHANNEL_WITH_DEMO.defaults,
    }));
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "schedule", "remove", "daily-report"]),
    ).rejects.toThrow('exists in multiple channels (demo, other)');
    expect(unlink).not.toHaveBeenCalled();
  });

  it("--channel disambiguates and deletes only that channel's file", async () => {
    loadConfig.mockImplementation(async () => ({
      channels: {
        demo: CHANNEL_WITH_DEMO.channels.demo,
        other: CHANNEL_WITH_DEMO.channels.demo,
      },
      defaults: CHANNEL_WITH_DEMO.defaults,
    }));
    const { runCli } = await import("./cli");
    const logs = captureLogs();
    try {
      await runCli(["node", "agent-bridge", "schedule", "remove", "daily-report", "--channel", "other"]);
    } finally {
      logs.restore();
    }
    expect(unlink).toHaveBeenCalledWith("/tmp/schedules/other/daily-report.md");
    expect(logs.lines.join("\n")).toContain("Deleted /tmp/schedules/other/daily-report.md");
  });

  it("rejects an unknown --channel", async () => {
    const { runCli } = await import("./cli");
    await expect(
      runCli(["node", "agent-bridge", "schedule", "remove", "daily-report", "--channel", "nope"]),
    ).rejects.toThrow('Unknown channel "nope".');
    expect(unlink).not.toHaveBeenCalled();
  });
});

describe("runCli schedule with no channels", () => {
  beforeEach(() => {
    resetPromptMocks();
    loadConfig.mockImplementation(async () => ({ channels: {}, defaults: { agentIdleTimeoutMs: 60_000 } }));
  });

  it("fails fast with a hint to run agent-bridge add first", async () => {
    const { runCli } = await import("./cli");
    await expect(runCli(["node", "agent-bridge", "schedule", "add"])).rejects.toThrow(
      "No channels configured",
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
