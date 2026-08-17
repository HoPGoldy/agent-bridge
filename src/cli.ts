import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import type {
  AgentConfig,
  AgentModule,
  AppConfig,
  ChannelCommonConfig,
  ChannelConfig,
  ClientConfig,
  ClientModule,
  ConfigAdapter,
  LocaleCode,
} from "./types";
import { createPromptContext } from "./config/prompt";
import { removeSessionBindingStore } from "./config/session-bindings";
import { getConfigPath, loadConfig, saveConfig } from "./config/store";
import { runChannel } from "./core/channel-runner";
import { DEFAULT_LOCALE, getTranslatorForCommon } from "./i18n";
import { getAgentModule, listAgentModules } from "./modules/agent";
import { getClientModule, listClientModules } from "./modules/client";
import { nextRun, parseSchedule, parseTimeout } from "./modules/schedule/grammar";
import {
  getSchedulesDir,
  isValidTaskName,
  loadChannelTasks,
  type ScheduleTask,
} from "./modules/schedule/task-file";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

async function selectModuleType<T extends { type: string }>(
  label: string,
  modules: T[],
  ctx: ReturnType<typeof createPromptContext>,
): Promise<string> {
  if (modules.length === 0) {
    throw new Error(`No modules available for ${label}`);
  }
  return ctx.select(
    label,
    modules.map((module) => ({
      label: module.type,
      value: module.type,
    })),
  );
}

async function collectModuleConfig<TConfig>(
  module: { createConfigCollector?: () => ConfigAdapter<TConfig> },
  ctx: ReturnType<typeof createPromptContext>,
): Promise<TConfig> {
  const collector = module.createConfigCollector?.();
  if (!collector) {
    return {} as TConfig;
  }

  const config = await collector.collect(ctx);
  await collector.validate(config);
  return config;
}

async function collectCommonChannelConfig(ctx: ReturnType<typeof createPromptContext>): Promise<ChannelCommonConfig> {
  const language = await ctx.select("Channel language", [
    { label: "English (en-US)", value: "en-US" },
    { label: "中文 (zh-CN)", value: "zh-CN" },
  ]);

  return {
    language: language as ChannelCommonConfig["language"],
  };
}

async function addChannel(config: AppConfig): Promise<void> {
  const ctx = createPromptContext();
  try {
    const name = await ctx.input("Channel name", {
      required: true,
      validate: (value) => {
        if (!value) return "Channel name is required";
        if (config.channels[value]) return "Channel name already exists";
        return null;
      },
    });

    const commonConfig = await collectCommonChannelConfig(ctx);

    const clientType = await selectModuleType("Select client module", listClientModules(), ctx);
    const clientModule = getClientModule(clientType);
    if (!clientModule) {
      throw new Error(`No client module for type: ${clientType}`);
    }
    const clientConfig = await collectModuleConfig(clientModule, ctx);

    const agentType = await selectModuleType("Select agent module", listAgentModules(), ctx);
    const agentModule = getAgentModule(agentType);
    if (!agentModule) {
      throw new Error(`No agent module for type: ${agentType}`);
    }
    const agentConfig = await collectModuleConfig(agentModule, ctx);

    config.channels[name] = {
      common: commonConfig,
      client: {
        type: clientType,
        config: clientConfig,
      } as ClientConfig,
      agent: {
        type: agentType,
        config: agentConfig,
      } as AgentConfig,
    } satisfies ChannelConfig;
    await saveConfig(config);
    console.log(`Saved channel ${name} to ${getConfigPath()}`);
  } finally {
    ctx.close();
  }
}

function summarizeClient(module: ClientModule<any> | undefined, channel: ChannelConfig): string {
  const summary = module?.createConfigCollector?.()?.summarize?.(channel.client.config);
  return summary ?? `type=${channel.client.type}`;
}

function summarizeAgent(module: AgentModule<any, any> | undefined, channel: ChannelConfig): string {
  const summary = module?.createConfigCollector?.()?.summarize?.(channel.agent.config);
  return summary ?? `type=${channel.agent.type}`;
}

async function listChannels(): Promise<void> {
  const config = await loadConfig();
  const names = Object.keys(config.channels).sort();
  if (names.length === 0) {
    console.log("No channels configured.");
    return;
  }

  for (const name of names) {
    const channel = config.channels[name]!;
    const clientModule = getClientModule(channel.client.type);
    const agentModule = getAgentModule(channel.agent.type);
    const clientSummary = summarizeClient(clientModule, channel);
    const agentSummary = summarizeAgent(agentModule, channel);
    console.log(`${name}\tclient(${clientSummary})\tagent(${agentSummary})`);
  }
}

async function removeChannel(channelName: string): Promise<void> {
  const config = await loadConfig();
  if (!config.channels[channelName]) {
    throw new Error(`Unknown channel: ${channelName}`);
  }

  delete config.channels[channelName];
  await saveConfig(config);
  await removeSessionBindingStore(channelName);
  console.log(`Removed channel ${channelName}`);
}

async function startChannel(channelName: string): Promise<void> {
  const config = await loadConfig();
  const channelConfig = config.channels[channelName];
  if (!channelConfig) {
    throw new Error(`Unknown channel: ${channelName}`);
  }

  const runner = await runChannel({
    channelName,
    channelConfig,
    defaults: config.defaults,
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runner.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });

  await new Promise<void>(() => {
    // keep foreground process alive
  });
}

// ---------------------------------------------------------------------------
// schedule command group (spec: docs/scheduled-tasks-spec.md "CLI Surface")
//
// Task files live at `~/.config/agent-bridge/schedules/<channel>/<task>.md`
// (T2: task-file.ts owns the format). The add wizard writes the front matter
// the scheduler needs; `target` is filled in by sending `/schedule-here
// <task-name>` in the destination chat (T10), or manually from `/st` output.
// The prompt body is meant to be edited by hand.
// ---------------------------------------------------------------------------

/** Grammar examples shown in the schedule prompt (spec D4). */
const SCHEDULE_EXAMPLES = ["every 5m", "daily 09:00", "weekly mon 09:00", "monthly 15 09:00"] as const;

/** Validates a task-name input: slug shape plus channel-local uniqueness. */
export function validateTaskNameInput(
  value: string,
  existingNames: ReadonlySet<string>,
): string | null {
  if (!isValidTaskName(value)) {
    return "Task name must be [a-z0-9-]+ (lowercase letters, digits and hyphens only)";
  }
  if (existingNames.has(value)) {
    return `A task named "${value}" already exists in this channel`;
  }
  return null;
}

/** Validates a schedule-string input against the grammar; errors re-prompt with examples. */
export function validateScheduleInput(value: string): string | null {
  const parsed = parseSchedule(value);
  if (parsed.ok) return null;
  return `${parsed.reason}. Examples: ${SCHEDULE_EXAMPLES.join(" | ")}`;
}

/** Validates a timeout-duration input ("10m", "1h", "90s"). */
export function validateTimeoutInput(value: string): string | null {
  const parsed = parseTimeout(value);
  return parsed.ok ? null : parsed.reason;
}

/**
 * Builds the Markdown task file written by `schedule add` (T2 file format).
 * The example prompt body is localized to `language` (defaults to English),
 * mirroring the channel's `common.language` picked in the add wizard.
 */
export function buildTaskFileContent(options: {
  schedule: string;
  timeout: string;
  directory?: string;
  language?: LocaleCode;
}): string {
  const frontMatter = [
    "---",
    `schedule: ${options.schedule}`,
    ...(options.directory !== undefined && options.directory !== ""
      ? [`directory: ${options.directory}`]
      : []),
    `timeout: ${options.timeout}`,
    "---",
  ];
  const prompt = getTranslatorForCommon({ language: options.language ?? DEFAULT_LOCALE })(
    "cli.examplePrompt",
  );
  return `${frontMatter.join("\n")}\n\n${prompt}\n`;
}

/** Picks a configured channel, or fails fast with a hint to run `agent-bridge add` first. */
async function selectScheduleChannel(
  ctx: ReturnType<typeof createPromptContext>,
  config: AppConfig,
): Promise<string> {
  const names = Object.keys(config.channels).sort();
  if (names.length === 0) {
    throw new Error("No channels configured. Run `agent-bridge add` to create a channel first.");
  }
  return ctx.select("Select channel", names.map((name) => ({ label: name, value: name })));
}

/** `agent-bridge schedule add`: interactive task-file creation wizard. */
async function addScheduleTask(): Promise<void> {
  const config = await loadConfig();
  const ctx = createPromptContext();
  try {
    const channel = await selectScheduleChannel(ctx, config);
    const channelLanguage = config.channels[channel]?.common.language ?? DEFAULT_LOCALE;

    const existing = await loadChannelTasks(channel);
    const existingNames = new Set(existing.map((entry) => entry.task.name));

    const name = await ctx.input("Task name", {
      required: true,
      validate: (value) => validateTaskNameInput(value, existingNames),
    });

    const schedule = await ctx.input(`Schedule (examples: ${SCHEDULE_EXAMPLES.join(", ")})`, {
      required: true,
      validate: validateScheduleInput,
    });

    // Blank = the bridge process cwd. Deliberately not validated against the
    // filesystem here — the bridge may run elsewhere (spec D6, fire-time
    // validation only).
    const directory = await ctx.input("Working directory (optional, blank = bridge cwd)");

    const timeout = await ctx.input("Timeout (default 10m)", {
      defaultValue: "10m",
      validate: validateTimeoutInput,
    });

    const schedulesDir = getSchedulesDir(channel);
    await mkdir(schedulesDir, { recursive: true });
    const filePath = path.join(schedulesDir, `${name}.md`);
    await writeFile(
      filePath,
      buildTaskFileContent({ schedule, timeout, directory, language: channelLanguage }),
      "utf8",
    );

    console.log(`Created ${filePath}`);
    console.log(`Edit ${filePath} to set your prompt.`);
    console.log(`To set the destination chat, send \`/schedule-here ${name}\` in target chat.`);
  } finally {
    ctx.close();
  }
}

interface ScheduleTaskRow {
  channel: string;
  task: ScheduleTask;
  errors: string[];
  warnings: string[];
}

/** Human-readable load status; errors are marked clearly (spec `schedule list`). */
function taskStatus(errors: string[], warnings: string[]): string {
  const parts = [
    ...errors.map((error) => `ERROR: ${error}`),
    ...warnings.map((warning) => `WARN: ${warning}`),
  ];
  return parts.join("; ");
}

/** Next trigger time computed from the grammar at the current clock (spec D4). */
function formatNextRun(task: ScheduleTask, now: Date): string {
  if (task.schedule === null) return "invalid schedule";
  return nextRun(task.schedule, now).toLocaleString();
}

/** `agent-bridge schedule list`: table of every task across all channels. */
async function listScheduleTasks(): Promise<void> {
  const config = await loadConfig();
  const channelNames = Object.keys(config.channels).sort();
  if (channelNames.length === 0) {
    console.log("No channels configured. Run `agent-bridge add` to create a channel first.");
    return;
  }

  const now = new Date();
  const rows: ScheduleTaskRow[] = [];
  for (const channel of channelNames) {
    const loaded = await loadChannelTasks(channel);
    for (const { task, errors, warnings } of loaded) {
      rows.push({ channel, task, errors, warnings });
    }
  }

  if (rows.length === 0) {
    console.log("No scheduled tasks found. Add one with `agent-bridge schedule add`.");
    return;
  }

  const columns: Array<{ header: string; get: (row: ScheduleTaskRow) => string }> = [
    { header: "Channel", get: (row) => row.channel },
    { header: "Task", get: (row) => row.task.name },
    { header: "Schedule", get: (row) => row.task.scheduleRaw ?? "-" },
    { header: "Enabled", get: (row) => (row.task.enabled ? "yes" : "no") },
    { header: "Target", get: (row) => (row.task.target !== undefined ? "yes" : "no") },
    { header: "Next run", get: (row) => formatNextRun(row.task, now) },
    { header: "Status", get: (row) => taskStatus(row.errors, row.warnings) },
  ];
  const widths = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => column.get(row).length)),
  );

  console.log(columns.map((column, i) => column.header.padEnd(widths[i])).join("  ").trimEnd());
  for (const row of rows) {
    console.log(columns.map((column, i) => column.get(row).padEnd(widths[i])).join("  ").trimEnd());
  }
}

/**
 * `agent-bridge schedule remove <task-name>`: delete the task file directly,
 * no prompts. Scans every channel for the name; `--channel` disambiguates
 * when several channels own a task with the same name.
 */
async function removeScheduleTask(taskName: string, options: { channel?: string }): Promise<void> {
  if (!isValidTaskName(taskName)) {
    throw new Error("Task name must be [a-z0-9-]+ (lowercase letters, digits and hyphens only)");
  }

  const config = await loadConfig();
  if (options.channel && !config.channels[options.channel]) {
    throw new Error(`Unknown channel "${options.channel}".`);
  }
  const candidates = options.channel ? [options.channel] : Object.keys(config.channels).sort();

  const matches: string[] = [];
  for (const channel of candidates) {
    const loaded = await loadChannelTasks(channel);
    if (loaded.some((entry) => entry.task.name === taskName)) {
      matches.push(channel);
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `No scheduled task "${taskName}" found${options.channel ? ` in channel "${options.channel}"` : ""}.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Task "${taskName}" exists in multiple channels (${matches.join(", ")}). Use --channel to pick one.`,
    );
  }

  const filePath = path.join(getSchedulesDir(matches[0]!), `${taskName}.md`);
  await unlink(filePath);
  console.log(`Deleted ${filePath}`);
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();

  program.name("agent-bridge").description("IM to Agent bridge CLI").version(version);

  program
    .command("add")
    .description("Interactively add a channel")
    .action(async () => {
      const config = await loadConfig();
      await addChannel(config);
    });

  program
    .command("ls")
    .description("List configured channels")
    .action(async () => {
      await listChannels();
    });

  program
    .command("remove")
    .description("Remove a channel")
    .argument("<channel-name>")
    .action(async (channelName: string) => {
      await removeChannel(channelName);
    });

  program
    .command("start")
    .description("Start a configured channel")
    .argument("<channel-name>")
    .action(async (channelName: string) => {
      await startChannel(channelName);
    });

  const schedule = program
    .command("schedule")
    .description("Manage scheduled tasks (Markdown files under ~/.config/agent-bridge/schedules)");

  schedule
    .command("add")
    .description("Interactively create a scheduled task")
    .action(async () => {
      await addScheduleTask();
    });

  schedule
    .command("list")
    .description("List scheduled tasks across all channels")
    .action(async () => {
      await listScheduleTasks();
    });

  schedule
    .command("remove")
    .description("Remove a scheduled task by name")
    .argument("<task-name>")
    .option("--channel <name>", "Channel that owns the task (needed only when the name exists in several channels)")
    .action(async (taskName: string, options: { channel?: string }) => {
      await removeScheduleTask(taskName, options);
    });

  await program.parseAsync(argv);
}
