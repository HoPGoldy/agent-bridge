import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
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
  loadAllTasks,
  type ScheduleTask,
} from "./modules/schedule/task-file";
import {
  getQueueFilePath,
  getQueueTasksDir,
  insertQueueTask,
  isValidQueueName,
  listQueueDefinitions,
  listQueueTasks,
  loadQueueDefinition,
  writeQueueDefinition,
  type QueueDefinition,
} from "./modules/queue/queue-file";

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
// Task files live at `~/.config/agent-bridge/schedules/<task-name>.md` — a flat
// channel-agnostic directory (T2: task-file.ts owns the format). Task names are
// globally unique (the file name is the unique key). The add wizard writes the
// front matter the scheduler needs; `target` and `channel` are filled in by
// sending `/schedule-here <task-name>` in the destination chat. The prompt body
// is meant to be edited by hand.
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
    return `A task named "${value}" already exists.`;
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
  model?: string;
  language?: LocaleCode;
}): string {
  const frontMatter = [
    "---",
    `schedule: ${options.schedule}`,
    `timeout: ${options.timeout}`,
    // Key order is stable (schedule, timeout, model, directory) so snapshots
    // and the T2 parser stay predictable. Values are bare, like `directory`.
    ...(options.model !== undefined && options.model !== ""
      ? [`model: ${options.model}`]
      : []),
    ...(options.directory !== undefined && options.directory !== ""
      ? [`directory: ${options.directory}`]
      : []),
    "---",
  ];
  const prompt = getTranslatorForCommon({ language: options.language ?? DEFAULT_LOCALE })(
    "cli.examplePrompt",
  );
  return `${frontMatter.join("\n")}\n\n${prompt}\n`;
}

/** `agent-bridge schedule add`: interactive task-file creation wizard. */
async function addScheduleTask(): Promise<void> {
  const ctx = createPromptContext();
  try {
    // T3: tasks are channel-agnostic and globally unique — no channel to pick.
    const existing = await loadAllTasks();
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

    // Blank = the channel agent config's model (existing resolution unchanged).
    // Deliberately not validated — the CLI cannot reach provider model lists;
    // a typo fails fast at fire time (spec failure semantics).
    const model = await ctx.input("Model (optional, blank = channel default)", {
      placeholder: "Example: azure-openai-responses/gpt-5.6-terra",
    });

    const schedulesDir = getSchedulesDir();
    await mkdir(schedulesDir, { recursive: true });
    const filePath = path.join(schedulesDir, `${name}.md`);
    await writeFile(
      filePath,
      buildTaskFileContent({ schedule, timeout, directory, model, language: DEFAULT_LOCALE }),
      "utf8",
    );

    console.log("Created successfully!");
    console.log(`- Edit ${filePath} to set your prompt.`);
    console.log(`- Send \`/schedule-here ${name}\` in chat app to set the report place.`);
  } finally {
    ctx.close();
  }
}

interface ScheduleTaskRow {
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
  const now = new Date();
  const rows: ScheduleTaskRow[] = (await loadAllTasks()).map(({ task, errors, warnings }) => ({
    task,
    errors,
    warnings,
  }));

  if (rows.length === 0) {
    console.log("No scheduled tasks found. Add one with `agent-bridge schedule add`.");
    return;
  }

  // Task name is the first column; Channel is intentionally dropped (T2).
  const columns: Array<{ header: string; get: (row: ScheduleTaskRow) => string }> = [
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
 * no prompts. Task names are globally unique (file name = unique key), so no
 * channel option or disambiguation is needed — it is a single-file delete.
 */
async function removeScheduleTask(taskName: string): Promise<void> {
  if (!isValidTaskName(taskName)) {
    throw new Error("Task name must be [a-z0-9-]+ (lowercase letters, digits and hyphens only)");
  }

  const loaded = await loadAllTasks();
  if (!loaded.some((entry) => entry.task.name === taskName)) {
    throw new Error(`No scheduled task "${taskName}" found.`);
  }

  const filePath = path.join(getSchedulesDir(), `${taskName}.md`);
  await unlink(filePath);
  console.log(`Deleted ${filePath}`);
}

// ---------------------------------------------------------------------------
// queue command group (spec: docs/event-queue-spec.md "D4 — Commands")
//
// Queue definitions live at `~/.config/agent-bridge/queues/<name>.md` (T1
// queue-file.ts owns the format). The add wizard mirrors the schedule wizard:
// a name, a worker count and an optional pinned model — NO channel step (a
// channel is only assigned when `/queue-here` binds a chat, writing both
// `channel` and `target`). Tasks are inserted with `queue insert` and consumed
// FIFO by the per-channel controller once the queue is bound (spec D2).
// ---------------------------------------------------------------------------

/** Validates a queue-name input: slug shape plus global uniqueness (spec D4). */
export function validateQueueNameInput(
  value: string,
  existingNames: ReadonlySet<string>,
): string | null {
  const t = getTranslatorForCommon();
  if (!isValidQueueName(value)) {
    return t("cli.queueNameInvalid");
  }
  if (existingNames.has(value)) {
    return t("cli.queueNameExists", { name: value });
  }
  return null;
}

/** Validates a workers input: integer >= 1 (spec D1, default 1). */
export function validateWorkersInput(value: string): string | null {
  const t = getTranslatorForCommon();
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    return t("cli.workersInvalid");
  }
  return null;
}

/** `agent-bridge queue add`: interactive queue-definition creation wizard. */
async function addQueue(): Promise<void> {
  const ctx = createPromptContext();
  try {
    const t = getTranslatorForCommon();

    const existing = await listQueueDefinitions();
    const existingNames = new Set(existing.map((definition) => definition.name));

    const name = await ctx.input(t("cli.queueNamePrompt"), {
      required: true,
      validate: (value) => validateQueueNameInput(value, existingNames),
    });

    const workers = await ctx.input(t("cli.workersPrompt"), {
      defaultValue: "1",
      validate: validateWorkersInput,
    });

    // Blank = the channel agent config's model (same resolution as scheduled
    // tasks); deliberately not validated — a typo fails fast at fire time.
    const model = await ctx.input(t("cli.modelPrompt"), {
      placeholder: "Example: azure-openai-responses/gpt-5.6-terra",
    });

    // No `channel` is written: a queue stays ownerless and unbound until
    // `/queue-here` binds a chat (writing both `channel` and `target`).
    const result = await writeQueueDefinition({
      name,
      workers: Number(workers),
      // Blank = channel default; the storage layer rejects a present-but-blank model.
      model: model.trim() === "" ? undefined : model,
    });
    if (!result.ok) {
      throw new Error(result.reason);
    }

    console.log(t("cli.queueCreated"));
    console.log(`- ${t("cli.queueCreatedGuideFile", { filePath: result.filePath })}`);
    console.log(`- ${t("cli.queueCreatedGuideBind", { name })}`);
    console.log(`- ${t("cli.queueCreatedGuideInsert", { name })}`);
  } finally {
    ctx.close();
  }
}

/**
 * `agent-bridge queue insert <name> --prompt "..."`: enqueue a task.
 * Errors (thrown, non-zero exit) when the prompt is empty or the queue does
 * not exist. The task is durable the moment the file lands; an unbound queue
 * simply waits until `/queue-here` binds a chat (spec D4, decided in grill).
 */
async function insertQueueCommand(
  queueName: string,
  options: { prompt?: string },
): Promise<void> {
  const t = getTranslatorForCommon();
  if (options.prompt === undefined || options.prompt.trim() === "") {
    throw new Error(t("cli.queueInsertPromptRequired"));
  }

  const definition = await loadQueueDefinition(queueName);
  if (definition === null) {
    throw new Error(t("cli.queueNotFound", { name: queueName }));
  }

  const taskId = await insertQueueTask(queueName, options.prompt);
  console.log(t("cli.queueInserted", { name: queueName, taskId }));

  if (definition.target === undefined) {
    console.log(t("cli.queueInsertUnboundWarning"));
  }
}

interface QueueListRow {
  definition: QueueDefinition;
  pending: number;
  running: number;
}

/** `agent-bridge queue list`: table of every queue with task counts. */
async function listQueues(): Promise<void> {
  const t = getTranslatorForCommon();
  const definitions = await listQueueDefinitions();
  if (definitions.length === 0) {
    console.log(t("cli.noQueues"));
    return;
  }

  const rows: QueueListRow[] = [];
  for (const definition of definitions) {
    const tasks = await listQueueTasks(definition.name);
    rows.push({
      definition,
      pending: tasks.filter((task) => task.state === "pending").length,
      running: tasks.filter((task) => task.state === "running").length,
    });
  }

  const columns: Array<{ header: string; get: (row: QueueListRow) => string }> = [
    { header: "Name", get: (row) => row.definition.name },
    // Channel is only written at bind time; an unbound queue shows `-`.
    { header: "Channel", get: (row) => row.definition.channel ?? "-" },
    { header: "Workers", get: (row) => String(row.definition.workers) },
    { header: "Model", get: (row) => row.definition.model ?? "-" },
    { header: "Bound", get: (row) => (row.definition.target !== undefined ? "yes" : "no") },
    { header: "Pending", get: (row) => String(row.pending) },
    { header: "Running", get: (row) => String(row.running) },
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
 * `agent-bridge queue remove <queue-name>`: delete the queue definition file
 * AND the queue's `<name>.tasks/` directory recursively (pending tasks die
 * with the queue), no prompts. Mirrors `removeScheduleTask` above: same
 * name-shape validation and missing-queue error, plain English CLI output.
 */
async function removeQueue(queueName: string): Promise<void> {
  if (!isValidQueueName(queueName)) {
    throw new Error("Queue name must be [a-z0-9-]+ (lowercase letters, digits and hyphens only)");
  }

  const definitions = await listQueueDefinitions();
  if (!definitions.some((definition) => definition.name === queueName)) {
    throw new Error(`No queue "${queueName}" found.`);
  }

  const filePath = getQueueFilePath(queueName);
  const tasksDir = getQueueTasksDir(queueName);
  // The tasks dir may not exist yet (a fresh queue with no inserts): removing
  // it is still idempotent and the file delete is the real requirement.
  await rm(tasksDir, { recursive: true, force: true });
  await unlink(filePath);
  console.log(`Deleted ${tasksDir}`);
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
    .action(async (taskName: string) => {
      await removeScheduleTask(taskName);
    });

  const queue = program
    .command("queue")
    .description("Manage event queues (Markdown files under ~/.config/agent-bridge/queues)");

  queue
    .command("add")
    .description("Interactively create an event queue")
    .action(async () => {
      await addQueue();
    });

  queue
    .command("insert")
    .description("Insert a task into a queue")
    .argument("<queue-name>")
    .option("--prompt <prompt>", "Task prompt")
    .action(async (queueName: string, options: { prompt?: string }) => {
      await insertQueueCommand(queueName, options);
    });

  queue
    .command("list")
    .description("List queues with task counts")
    .action(async () => {
      await listQueues();
    });

  queue
    .command("remove")
    .description("Remove a queue by name (deletes the queue and its pending tasks)")
    .argument("<queue-name>")
    .action(async (queueName: string) => {
      await removeQueue(queueName);
    });

  await program.parseAsync(argv);
}
