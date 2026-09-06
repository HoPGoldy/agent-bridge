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
import { createInMemoryChannelStateStore } from "./config/channel-state";
import { createAgentSessionStateRegistry } from "./config/agent-session-state";
import { createClientSessionStateStore } from "./config/client-session-state";
import { getConfigPath, loadConfig, saveConfig } from "./config/store";
import { runChannel } from "./core/channel-runner";
import { GatewayCore } from "./core/gateway-core";
import { DEFAULT_LOCALE, getTranslatorForCommon } from "./i18n";
import { getAgentModule, getTypedAgentModule, listAgentModules } from "./modules/agent";
import { getClientModule, getTypedClientModule, listClientModules } from "./modules/client";
import { readRunHistory, type RunHistoryRecord } from "./modules/run-completion/history";
import { nextRun, parseSchedule, parseTimeout } from "./modules/schedule/grammar";
import { parseSyntheticSessionId } from "./modules/schedule/scheduler";
import { Scheduler } from "./modules/schedule/scheduler";
import {
  getSchedulesDir,
  isValidTaskName,
  loadAllTasks,
  setTaskEnabled,
  type ScheduleTask,
} from "./modules/schedule/task-file";
import {
  getQueueFilePath,
  getQueueTasksDir,
  insertQueueTask,
  isValidQueueName,
  isValidTaskId,
  listQueueDefinitions,
  listQueueTasks,
  loadQueueDefinition,
  QUEUE_SESSION_PREFIX,
  retryQueueTask,
  setQueueEnabled,
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

/** Localized validator for a task-name input: slug shape plus global uniqueness. */
export function validateTaskNameInput(
  value: string,
  existingNames: ReadonlySet<string>,
): string | null {
  const t = getTranslatorForCommon();
  if (!isValidTaskName(value)) {
    return t("cli.taskNameInvalid");
  }
  if (existingNames.has(value)) {
    return t("cli.taskNameExists", { name: value });
  }
  return null;
}

/** Localized schedule-string validator; errors re-prompt with examples. */
export function validateScheduleInput(value: string): string | null {
  const t = getTranslatorForCommon();
  const parsed = parseSchedule(value);
  if (parsed.ok) return null;
  return t("cli.scheduleInvalid", { reason: parsed.reason, examples: SCHEDULE_EXAMPLES.join(" | ") });
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
  silence?: string;
  directory?: string;
  model?: string;
  language?: LocaleCode;
}): string {
  const frontMatter = [
    "---",
    `schedule: ${options.schedule}`,
    `timeout: ${options.timeout}`,
    // Key order is stable (schedule, timeout, silence, model, directory) so
    // snapshots and the T2 parser stay predictable. Values are bare, like
    // `directory`; blank/absent silence/model/directory write no line (the
    // built-in default applies).
    ...(options.silence !== undefined && options.silence !== ""
      ? [`silence: ${options.silence}`]
      : []),
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
  const t = getTranslatorForCommon();
  try {
    // T3: tasks are channel-agnostic and globally unique — no channel to pick.
    const existing = await loadAllTasks();
    const existingNames = new Set(existing.map((entry) => entry.task.name));

    const name = await ctx.input(t("cli.taskNamePrompt"), {
      required: true,
      validate: (value) => validateTaskNameInput(value, existingNames),
    });

    const schedule = await ctx.input(t("cli.schedulePrompt", { examples: SCHEDULE_EXAMPLES.join(", ") }), {
      required: true,
      validate: validateScheduleInput,
    });

    // Blank = the built-in 5h default: the line is not written at all.
    const timeout = await ctx.input(t("cli.timeoutPrompt"), {
      defaultValue: "5h",
      validate: validateTimeoutInput,
    });

    // Blank = the built-in 30m default (D7): the line is not written.
    const silence = await ctx.input(t("cli.silencePrompt"), {
      defaultValue: "30m",
      validate: validateTimeoutInput,
    });

    // Blank = the channel agent config's model (existing resolution unchanged).
    // Deliberately not validated — the CLI cannot reach provider model lists;
    // a typo fails fast at fire time (spec failure semantics).
    const model = await ctx.input(t("cli.modelPrompt"), {
      placeholder: t("cli.modelPlaceholder"),
    });

    // Blank = the bridge process cwd. Deliberately not validated against the
    // filesystem here — the bridge may run elsewhere (spec D6, fire-time
    // validation only).
    const directory = await ctx.input(t("cli.directoryPrompt"));

    const schedulesDir = getSchedulesDir();
    await mkdir(schedulesDir, { recursive: true });
    const filePath = path.join(schedulesDir, `${name}.md`);
    await writeFile(
      filePath,
      buildTaskFileContent({ schedule, timeout, silence, directory, model, language: DEFAULT_LOCALE }),
      "utf8",
    );

    console.log(t("cli.taskCreated"));
    console.log(`- ${t("cli.taskCreatedGuideFile", { filePath })}`);
    console.log(`- ${t("cli.taskCreatedGuideTarget", { name })}`);
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

/**
 * `agent-bridge schedule enable|disable <task-name>`: toggle the task's
 * persistent `enabled` front-matter switch. Disabling skips the task's
 * scheduled fires (and `/schedule-run` refusals) without deleting it;
 * in-flight runs are untouched; re-enabling recomputes the next run from the
 * current clock (no catch-up). The scheduler's hot reload picks the change
 * up on the next tick — no restart needed.
 */
async function setScheduleTaskEnabled(taskName: string, enabled: boolean): Promise<void> {
  if (!isValidTaskName(taskName)) {
    throw new Error(getTranslatorForCommon()("cli.taskNameInvalid"));
  }
  const loaded = await loadAllTasks();
  if (!loaded.some((entry) => entry.task.name === taskName)) {
    throw new Error(`No scheduled task "${taskName}" found.`);
  }
  const result = await setTaskEnabled(taskName, enabled);
  if (!result.ok) {
    throw new Error(`Failed to ${enabled ? "enable" : "disable"} task "${taskName}": ${result.reason}`);
  }
  console.log(
    `Scheduled task "${taskName}" is now ${enabled ? "enabled" : "disabled (skipped until re-enabled)"}.`,
  );
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

    // Blank = the built-in 5h controller default (same as scheduled tasks):
    // the line is not written.
    const timeout = await ctx.input(t("cli.timeoutPrompt"), {
      defaultValue: "5h",
      validate: validateTimeoutInput,
    });

    // Blank = the built-in 30m default (D7): the line is not written.
    const silence = await ctx.input(t("cli.silencePrompt"), {
      defaultValue: "30m",
      validate: validateTimeoutInput,
    });

    // Blank = the channel agent config's model (same resolution as scheduled
    // tasks); deliberately not validated — a typo fails fast at fire time.
    const model = await ctx.input(t("cli.modelPrompt"), {
      placeholder: t("cli.modelPlaceholder"),
    });

    // Blank = the bridge process cwd. Deliberately not validated against the
    // filesystem here — the bridge may run elsewhere (spec D6, fire-time
    // validation only), same convention as `schedule add`.
    const directory = await ctx.input(t("cli.directoryPrompt"));

    // Optional shared context appended to every task prompt; blank = an
    // empty body (the file stays editable afterwards, same as before).
    const body = await ctx.input(t("cli.bodyPrompt"));

    // No `channel` is written: a queue stays ownerless and unbound until
    // `/queue-here` binds a chat (writing both `channel` and `target`).
    const result = await writeQueueDefinition({
      name,
      workers: Number(workers),
      // Blank = built-in defaults: the storage layer rejects a present-but-blank
      // value, so each "empty → no line" answer is normalized to undefined here.
      timeout: timeout.trim() === "" ? undefined : timeout,
      silence: silence.trim() === "" ? undefined : silence,
      model: model.trim() === "" ? undefined : model,
      directory: directory.trim() === "" ? undefined : directory,
      body,
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
 * not exist; `--timeout` / `--silence` are pre-validated here with the same
 * duration grammar as scheduled tasks (a bad value exits before anything is
 * written), while `--model` / `--directory` land in the task front matter
 * as-is (fire-time validation only). The overrides become the task-level run
 * parameters (T03): each beats the queue definition's same-named field.
 */
async function insertQueueCommand(
  queueName: string,
  options: {
    prompt?: string;
    directory?: string;
    model?: string;
    timeout?: string;
    silence?: string;
  },
): Promise<void> {
  const t = getTranslatorForCommon();
  if (options.prompt === undefined || options.prompt.trim() === "") {
    throw new Error(t("cli.queueInsertPromptRequired"));
  }
  for (const [flag, value] of [
    ["--timeout", options.timeout],
    ["--silence", options.silence],
  ] as const) {
    if (value !== undefined) {
      const parsed = parseTimeout(value);
      if (!parsed.ok) {
        throw new Error(t("cli.queueInsertInvalidDuration", { flag, value, detail: parsed.reason }));
      }
    }
  }

  const definition = await loadQueueDefinition(queueName);
  if (definition === null) {
    throw new Error(t("cli.queueNotFound", { name: queueName }));
  }

  // The task-level overrides land in the task front matter as-is (the
  // timeout/silence grammar was already checked above; model/directory are
  // fire-time validated, spec D6 — the bridge may run elsewhere); a blank
  // value is treated as absent (no line written, the queue-level/default
  // resolution applies).
  const overrides = {
    directory: options.directory?.trim(),
    model: options.model?.trim(),
    timeout: options.timeout?.trim(),
    silence: options.silence?.trim(),
  };
  const taskId = await insertQueueTask(queueName, options.prompt, undefined, overrides);
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
    { header: "Enabled", get: (row) => (row.definition.enabled ? "yes" : "no") },
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

/**
 * `agent-bridge queue enable|disable <queue-name>`: toggle the queue's
 * persistent `enabled` front-matter switch (mirrors the schedule task's).
 * Disabling pauses consumption — pending tasks pile up untouched, in-flight
 * runs are untouched; re-enabling drains the backlog automatically on the
 * controller's next tick.
 */
async function setQueueEnabledCommand(queueName: string, enabled: boolean): Promise<void> {
  if (!isValidQueueName(queueName)) {
    throw new Error("Queue name must be [a-z0-9-]+ (lowercase letters, digits and hyphens only)");
  }
  const definitions = await listQueueDefinitions();
  if (!definitions.some((definition) => definition.name === queueName)) {
    throw new Error(`No queue "${queueName}" found.`);
  }
  const result = await setQueueEnabled(queueName, enabled);
  if (!result.ok) {
    throw new Error(`Failed to ${enabled ? "enable" : "disable"} queue "${queueName}": ${result.reason}`);
  }
  console.log(
    `Queue "${queueName}" is now ${enabled ? "enabled" : "disabled (tasks wait until re-enabled)"}.`,
  );
}

/**
 * `agent-bridge queue retry <queue-name> <task-id>`: re-queue a dead-lettered
 * task (spec D2/T02). Only a `state: failed` task can be retried — the edit
 * flips it back to `pending` and clears the `failedAt` / `reason` /
 * `agentSessionId` lines in one atomic write; the controller then consumes it
 * naturally on its next tick (retry is only a state flip, no firing here).
 */
async function retryQueueCommand(queueName: string, taskId: string): Promise<void> {
  const t = getTranslatorForCommon();
  if (!isValidQueueName(queueName)) {
    throw new Error(t("cli.queueNameInvalid"));
  }
  if (!isValidTaskId(taskId)) {
    throw new Error(t("cli.queueRetryTaskNotFound", { name: queueName, taskId }));
  }
  const result = await retryQueueTask(queueName, taskId);
  if (!result.ok) {
    // Map the storage-layer reasons onto localized CLI messages: missing
    // file, failed validation, or a non-`failed` state.
    if (result.reason.endsWith("not found") || result.reason.includes("not found in queue")) {
      throw new Error(t("cli.queueRetryTaskNotFound", { name: queueName, taskId }));
    }
    if (result.reason.includes("is not failed")) {
      // Re-load to report the actual state in the message.
      const tasks = await listQueueTasks(queueName);
      const state = tasks.find((task) => task.id === taskId)?.state ?? "unknown";
      throw new Error(t("cli.queueRetryNotFailed", { name: queueName, taskId, state }));
    }
    throw new Error(result.reason);
  }
  console.log(t("cli.queueRetried", { name: queueName, taskId }));
}

// ---------------------------------------------------------------------------
// `schedule run <task-name>` (spec D6/T06): manual trigger from the CLI.
//
// A CLI invocation is NOT the bridge process: the scheduler normally lives
// inside a running channel (constructed by channel-runner, wired to the
// core's ingress and the client adapter's egress). Delivering the run result
// to the task's `target` chat requires a real client-adapter connection, and
// the synthetic dispatch requires a started core (`input()` rejects while
// `#started` is false), so the CLI starts a minimal one-shot channel here —
// the exact construction channel-runner performs, minus the queue
// controller:
//
// - the configured channel's real client adapter (deliver resolves egress
//   to the `target` chat through it) and a real GatewayCore;
// - an in-memory channel state store (only the one synthetic `schedule:*`
//   session runs here and its bindings are in-memory only by design; a
//   concurrently running real bridge's state files are never touched).
//
// The trigger itself is NOT duplicated: everything goes through the same
// `Scheduler.runNow` the in-channel `/schedule-run` uses. `runNow` resolves
// when the prompt dispatch is accepted (for pi AND opencode the run then
// continues in the background), so afterwards the command polls the run's
// TERMINAL run-history line (written at every endpoint — completed/failed/
// timeout — before the delivery is enqueued) plus a short delivery grace, and
// only then tears the one-shot channel down. The wait is bounded by the
// TASK'S OWN timeout (+small grace): a healthy run always reaches an endpoint
// (the timeout path writes the history line itself) before that bound. If the
// wait is interrupted (SIGINT) or the bound passes without a terminal line,
// the CLI prints an honest warning (NOT the success message) and tears the
// channel down — the run may still be in progress or was just interrupted;
// `schedule history` tells which.
// ---------------------------------------------------------------------------

/**
 * `agent-bridge schedule run <task-name>`: validate the task exists, then
 * fire it through the same `Scheduler.runNow` entry the in-channel
 * `/schedule-run` uses (no trigger logic is duplicated here).
 *
 * `runNow` resolves when the prompt dispatch is accepted — the run itself
 * continues in the background for both agent backends — so afterwards the
 * command polls the run's TERMINAL run-history line (written at every
 * endpoint: completed/failed/timeout, before the delivery is enqueued) plus
 * a short delivery grace, then tears the one-shot channel down. The wait is
 * bounded by the task's own timeout (+small grace); an interrupted or
 * timed-out wait prints a differentiated warning instead of the success
 * message.
 */
/** Poll/grace knobs for the settle wait (tests shrink these). */
export const SCHEDULE_RUN_WAIT = { pollMs: 1_000, graceMs: 2_000, extraTimeoutMs: 60_000 };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How the settle wait ended (drives the CLI's closing message). */
type ScheduleRunWaitOutcome = "settled" | "timeout" | "interrupted";

/**
 * Polls the run-history index until a run of `taskName` started at/after
 * `sinceIso` has a TERMINAL line (`"settled"`). Ends as `"interrupted"` as
 * soon as `isInterrupted()` turns true, or `"timeout"` once the bound —
 * the task's own timeout plus a small grace (a healthy run's timeout path
 * writes the terminal line itself) — passes without one. Never throws for
 * history read failures: history is a best-effort synchronization signal,
 * not something a dispatch should fail over.
 */
async function waitForRunSettled(
  taskName: string,
  sinceIso: string,
  taskTimeoutMs: number,
  isInterrupted: () => boolean,
): Promise<ScheduleRunWaitOutcome> {
  // The run registers right before `runNow` dispatches, so its own timeout
  // fires at ~registerTime + taskTimeoutMs; the extra grace covers history
  // write/delivery lag past that endpoint.
  const deadline = Date.now() + taskTimeoutMs + SCHEDULE_RUN_WAIT.extraTimeoutMs;
  for (;;) {
    if (isInterrupted()) return "interrupted";
    let records: RunHistoryRecord[] = [];
    try {
      records = await readRunHistory("schedule");
    } catch {
      // History is a best-effort synchronization signal; a read failure must
      // not turn a dispatched run into a CLI error.
    }
    const settled = records.some(
      (record) =>
        parseSyntheticSessionId(record.runId)?.taskName === taskName && record.ts >= sinceIso,
    );
    if (settled) return "settled";
    if (Date.now() >= deadline) return "timeout";
    await delay(SCHEDULE_RUN_WAIT.pollMs);
  }
}

async function runScheduleTask(taskName: string): Promise<void> {
  const t = getTranslatorForCommon();
  if (!isValidTaskName(taskName)) {
    throw new Error(t("cli.taskNameInvalid"));
  }
  const loaded = await loadAllTasks();
  if (!loaded.some((entry) => entry.task.name === taskName)) {
    throw new Error(t("cli.scheduleRunTaskNotFound", { name: taskName }));
  }

  // Ownership pre-check: `runNow` refuses a task bound to another channel
  // (the fire can only deliver through the owning channel's adapter), so the
  // CLI must construct THAT channel's core. No `channel` line = unbound; any
  // configured channel's core accepts it (same rule as the in-channel
  // command) — the first configured one is used.
  const task = loaded.find((entry) => entry.task.name === taskName)!.task;
  const config = await loadConfig();
  const configuredNames = Object.keys(config.channels).sort();
  const channelName = task.channel ?? configuredNames[0];
  if (channelName === undefined || config.channels[channelName] === undefined) {
    throw new Error(
      task.channel === undefined
        ? t("cli.scheduleRunNoChannels")
        : t("cli.scheduleRunChannelNotFound", { name: taskName, channel: task.channel }),
    );
  }
  const channelConfig = config.channels[channelName]!;

  const channelStateStore = createInMemoryChannelStateStore();
  const agentSessionStateRegistry = createAgentSessionStateRegistry(channelStateStore);
  const clientModule = getTypedClientModule(channelConfig.client);
  const agentModule = getTypedAgentModule(channelConfig.agent);
  const common = { channelName, language: channelConfig.common.language };

  // One-shot scheduler and core, mirroring the channel-runner wiring. The
  // scheduler is declared first and assigned after the core exists: the core
  // diverts `schedule:*` agent output to the scheduler (spec D2), the
  // scheduler dispatches synthetic fires into the core's ingress and
  // delivers egress through the real client adapter (spec D1/D9).
  let scheduler: Scheduler;

  const imAdapter = clientModule.createClientAdapter({
    config: channelConfig.client.config,
    common,
    sessionState: createClientSessionStateStore({
      channelStateStore,
      clientType: clientModule.type,
      codec: clientModule.sessionStateCodec,
    }),
  });

  const core: GatewayCore = new GatewayCore({
    imAdapter,
    agentModule,
    agentConfig: channelConfig.agent.config,
    agentIdleTimeoutMs: config.defaults.agentIdleTimeoutMs,
    // Same allowlist the runner passes: a configured working-directory root
    // allowlist must bind CLI-fired runs too, not just channel ones.
    ...(config.defaults.allowedWorkingDirectoryRoots !== undefined
      ? { allowedWorkingDirectoryRoots: config.defaults.allowedWorkingDirectoryRoots }
      : {}),
    channelStateStore,
    agentSessionStateRegistry,
    common,
    onScheduleOutput: (event) => scheduler.handleOutput(event),
  });

  scheduler = new Scheduler({
    channelName,
    dispatchClientEvent: (event) => core.input(event),
    deliver: (event) => imAdapter.input(event),
    validateTarget: (clientSessionId) => clientModule.validateSessionId(clientSessionId),
    t: getTranslatorForCommon(common),
  });

  // Starting the core brings the client adapter online (deliveries resolve
  // the `target` chat through it); starting the scheduler arms the tick
  // loop. Unlike a long-lived channel there is no queue controller here.
  // SIGINT flips the interrupted flag; the settle wait observes it and the
  // teardown below runs through the normal path (releasing the agent
  // session) before the default exit kills the process.
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.once("SIGINT", onSignal);
  await core.start();
  await scheduler.start();
  try {
    // `runNow` resolves at dispatch-accept (the run continues in the
    // background for both agent backends). The result is delivered to the
    // task's target by the run itself; afterwards wait for the run's
    // terminal history line + a short delivery grace so the one-shot
    // teardown below never kills an in-flight run or drops its delivery.
    const sinceIso = new Date(Date.now() - 5_000).toISOString();
    const result = await scheduler.runNow(taskName);
    if (!result.ok) {
      throw new Error(t("cli.scheduleRunFailed", { name: taskName, reason: result.reason }));
    }
    const waitOutcome = await waitForRunSettled(taskName, sinceIso, task.timeoutMs, () => interrupted);
    if (waitOutcome === "settled") {
      await delay(SCHEDULE_RUN_WAIT.graceMs);
      console.log(t("cli.scheduleRunTriggered", { name: taskName }));
    } else {
      // Honest failure-to-confirm, NOT the success message: on interrupt the
      // teardown below releases the run (likely interrupting it); on timeout
      // the run may genuinely still be working past its own timeout bound.
      // Either way the run history tells what actually happened.
      console.error(
        t("cli.scheduleRunWaitNotSettled", {
          name: taskName,
          reason: waitOutcome === "interrupted"
            ? t("cli.scheduleRunWaitInterrupted")
            : t("cli.scheduleRunWaitTimeout"),
        }),
      );
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    // Completed, interrupted or timed-out wait: stop in the same order as
    // the channel teardown, releasing the agent session and the adapter.
    await scheduler.stop();
    await core.stop();
  }
}

// ---------------------------------------------------------------------------
// history subcommands (run-history spec D7)
//
// `schedule history [task-name]` / `queue history <queue-name>` read the
// per-module JSONL index written at every run endpoint (T2) and print the
// WHOLE list (no paging — the file is small), newest first. Pure read-only:
// the CLI process never touches a running bridge. Name filtering parses the
// name out of the runId (schedule ids embed the task name via
// parseSyntheticSessionId; queue ids are `queue:<name>:<taskId>` and the
// queue name cannot contain `:`, so the SECOND colon delimits it — taskId
// itself may contain `-`, so no further splitting is attempted).
// ---------------------------------------------------------------------------

/** Human-readable run duration: `4m12s`, `45s`, `1h2m3s`, `0ms`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.trunc(ms))}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/** Extracts the queue name out of a `queue:<name>:<taskId>` runId. */
export function parseQueueRunId(runId: string): string | null {
  if (!runId.startsWith(QUEUE_SESSION_PREFIX)) return null;
  const rest = runId.slice(QUEUE_SESSION_PREFIX.length);
  const colon = rest.indexOf(":");
  // The queue name never contains `:`; the taskId after the second colon is
  // opaque (it contains `-`), so it is never split further.
  if (colon <= 0 || colon === rest.length - 1) return null;
  return rest.slice(0, colon);
}

interface HistoryRow {
  record: RunHistoryRecord;
  name: string;
}

/** Prints the shared history table (spec D7), newest first. */
function printHistoryTable(rows: HistoryRow[]): void {
  const columns: Array<{ header: string; get: (row: HistoryRow) => string }> = [
    // Local timezone, same formatting as `schedule list`'s Next run column.
    { header: "Time", get: (row) => new Date(row.record.ts).toLocaleString() },
    { header: "Name", get: (row) => row.name },
    { header: "Outcome", get: (row) => row.record.outcome },
    { header: "Duration", get: (row) => formatDuration(row.record.ms) },
    { header: "Reason", get: (row) => row.record.reason ?? "-" },
    { header: "File", get: (row) => row.record.file },
  ];
  const widths = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => column.get(row).length)),
  );

  console.log(columns.map((column, i) => column.header.padEnd(widths[i])).join("  ").trimEnd());
  for (const row of rows) {
    console.log(columns.map((column, i) => column.get(row).padEnd(widths[i])).join("  ").trimEnd());
  }
}

/** Shared plumbing: read, filter, sort newest-first, print or hint. */
async function listHistory(
  kind: "schedule" | "queue",
  name: string | undefined,
  nameOf: (runId: string) => string | null,
  emptyHint: string,
): Promise<void> {
  const records = await readRunHistory(kind);
  const rows: HistoryRow[] = [];
  for (const record of records) {
    const parsedName = nameOf(record.runId);
    if (parsedName === null) continue; // not a well-formed runId: skip silently
    if (name !== undefined && parsedName !== name) continue;
    rows.push({ record, name: parsedName });
  }
  if (rows.length === 0) {
    console.log(emptyHint);
    return;
  }
  rows.sort((a, b) => (a.record.ts < b.record.ts ? 1 : a.record.ts > b.record.ts ? -1 : 0));
  printHistoryTable(rows);
}

/** `agent-bridge schedule history [task-name]`: newest-first run table (all tasks when no name). */
async function scheduleHistory(taskName?: string): Promise<void> {
  await listHistory(
    "schedule",
    taskName,
    (runId) => parseSyntheticSessionId(runId)?.taskName ?? null,
    taskName === undefined
      ? "No run history found."
      : `No run history found for scheduled task "${taskName}".`,
  );
}

/** `agent-bridge queue history <queue-name>`: newest-first run table. */
async function queueHistory(queueName: string): Promise<void> {
  await listHistory(
    "queue",
    queueName,
    parseQueueRunId,
    `No run history found for queue "${queueName}".`,
  );
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
    .command("run")
    .description(
      "Trigger a scheduled task once now (the result is delivered to the task's target chat). "+
      "Note: connects to the IM with the channel's credentials — a running bridge on that channel may be displaced (wecom/weixin); consider stopping it first.",
    )
    .argument("<task-name>")
    .action(async (taskName: string) => {
      await runScheduleTask(taskName);
    });

  schedule
    .command("enable")
    .description("Enable a scheduled task (resume scheduled firing)")
    .argument("<task-name>")
    .action(async (taskName: string) => {
      await setScheduleTaskEnabled(taskName, true);
    });

  schedule
    .command("disable")
    .description("Disable a scheduled task (skip firing until re-enabled)")
    .argument("<task-name>")
    .action(async (taskName: string) => {
      await setScheduleTaskEnabled(taskName, false);
    });

  schedule
    .command("remove")
    .description("Remove a scheduled task by name")
    .argument("<task-name>")
    .action(async (taskName: string) => {
      await removeScheduleTask(taskName);
    });

  schedule
    .command("history")
    .description("Show run history of scheduled tasks (newest first)")
    .argument("[task-name]")
    .action(async (taskName?: string) => {
      await scheduleHistory(taskName);
    });

  const queue = program
    .command("queue")
    .description("Manage event queues (Markdown files under ~/.config/agent-bridge/queues)")
    .addHelpText(
      "after",
      "Tip: a pending task is a plain Markdown file under ~/.config/agent-bridge/queues/<name>.tasks/ — edit or delete the file to modify or remove it.",
    );

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
    .option("--directory <path>", "Working directory for this task (overrides the queue's directory)")
    .option("--model <model>", "Agent model for this task (overrides the queue's model)")
    .option("--timeout <duration>", "Wall-clock run limit for this task, e.g. 10m (overrides the queue's timeout)")
    .option("--silence <duration>", "Silence-probe window for this task, e.g. 30m (overrides the queue's silence)")
    .action(async (queueName: string, options: { prompt?: string; directory?: string; model?: string; timeout?: string; silence?: string }) => {
      await insertQueueCommand(queueName, options);
    });

  queue
    .command("list")
    .description("List queues with task counts")
    .action(async () => {
      await listQueues();
    });

  queue
    .command("enable")
    .description("Enable a queue (resume consuming pending tasks)")
    .argument("<queue-name>")
    .action(async (queueName: string) => {
      await setQueueEnabledCommand(queueName, true);
    });

  queue
    .command("disable")
    .description("Disable a queue (tasks wait until re-enabled)")
    .argument("<queue-name>")
    .action(async (queueName: string) => {
      await setQueueEnabledCommand(queueName, false);
    });

  queue
    .command("remove")
    .description("Remove a queue by name (deletes the queue and its pending tasks)")
    .argument("<queue-name>")
    .action(async (queueName: string) => {
      await removeQueue(queueName);
    });

  queue
    .command("history")
    .description("Show run history of a queue's tasks (newest first)")
    .argument("<queue-name>")
    .action(async (queueName: string) => {
      await queueHistory(queueName);
    });

  queue
    .command("retry")
    .description("Re-queue a failed (dead-lettered) task: state goes back to pending")
    .argument("<queue-name>")
    .argument("<task-id>")
    .action(async (queueName: string, taskId: string) => {
      await retryQueueCommand(queueName, taskId);
    });

  await program.parseAsync(argv);
}
