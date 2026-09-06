/**
 * Event queue Markdown files: queue definitions and task files — the storage
 * layer of the event queue (design spec `docs/event-queue-spec.md` D1).
 *
 * Storage root: `~/.config/agent-bridge/queues/`, mirroring the schedules
 * layout. A queue definition is `queues/<name>.md` — front matter `channel`
 * (optional, absent until the queue is bound; written by `/queue-here`),
 * `workers` (integer >= 1, default 1), `timeout` (optional duration like
 * `10m`; default 10m via the controller — the wall-clock limit of this
 * queue's runs), `model` (optional, blank/absent → undefined), `directory`
 * (optional working directory for the queue's runs; a task-level
 * `directory:` overrides it; validated at fire time, spec D6 style),
 * `target` (optional, non-empty, written by `/queue-here`) —
 * and its body is the shared context appended to every task prompt. Tasks
 * live in `queues/<name>.tasks/<taskId>.md`; a `taskId` is
 * `<enqueueMs>-<random4>`, so lexicographic file-name order IS the FIFO
 * order and ids are generated accordingly (monotonic ms prefix).
 *
 * Front matter is the same flat `key: value` subset as task-file.ts (no YAML
 * dependency): one key per line, values are bare strings with surrounding
 * quotes stripped, `#` comment lines and blank lines are ignored, unknown
 * keys produce warnings.
 *
 * Parsing never throws for bad content: invalid definitions/tasks are
 * skipped with a log by the listers and single-item loaders return `null`.
 * All writes are atomic (same-directory temp file + rename). The queue
 * storage root resolves `~` via the bridge user's home directory, and a
 * caller-supplied root is expanded the same way.
 */

import type { Dirent } from "node:fs";
import { access, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { QUEUES_DIR } from "../../config/channel-state";
import { DEFAULT_SILENCE_MS } from "../schedule/task-file";
import { parseTimeout } from "../schedule/grammar";
import {
  applyFrontMatterField,
  expandHome,
  nonEmptyString,
  parseFrontMatter,
  removeFrontMatterFields,
  splitFrontMatter,
  writeFileAtomic,
} from "../shared/front-matter";

/** Synthetic clientSessionId prefix for queue runs (spec D1). Shared with the core. */
export const QUEUE_SESSION_PREFIX = "queue:";

/** Default worker count when the definition's `workers` field is absent (spec D1). */
export const DEFAULT_WORKERS = 1;

/** Queue names are the `.md` file names without the extension (spec D1). */
const QUEUE_NAME_RE = /^[a-z0-9-]+$/;

/** Task ids are `<enqueueMs>-<random4>`; the shape is part of the FIFO contract (spec D1). */
const TASK_ID_RE = /^\d+-[0-9a-f]{4}$/;

/**
 * Task states: `pending` (waiting to fire) and `running` (in flight) are the
 * live states; `failed` is the dead-letter terminal state (spec D2/T02): a
 * task whose run failed after session creation keeps its file for tracing and
 * re-queueing via `queue retry`.
 */
const TASK_STATES = new Set(["pending", "running", "failed"]);

const KNOWN_DEFINITION_KEYS = new Set([
  "channel",
  "workers",
  "silence",
  "timeout",
  "model",
  "target",
  "enabled",
  "directory",
]);
// `failedAt` / `reason` / `agentSessionId` are dead-letter fields: they are
// written together with `state: failed` (failQueueTask) and cleared again by
// `queue retry` (retryQueueTask). `model` / `timeout` / `silence` are the
// task-level run-parameter overrides (T03): each one overrides the same-named
// definition field at fire time.
const KNOWN_TASK_KEYS = new Set([
  "state",
  "enqueuedAt",
  "directory",
  "model",
  "timeout",
  "silence",
  "failedAt",
  "reason",
  "agentSessionId",
]);

/** A parsed, validated queue definition (spec D1). */
export interface QueueDefinition {
  /** Queue name — the file name without `.md`. */
  name: string;
  /**
   * Owning channel config name; absent until the queue is bound.
   * `queue add` does not write it; `/queue-here` writes both `channel`
   * (the current channel) and `target` (the current chat) at bind time.
   * A queue without `channel` is owned by no controller and never consumed.
   */
  channel: string | undefined;
  /** Max concurrent tasks; integer >= 1, defaults to {@link DEFAULT_WORKERS}. */
  workers: number;
  /**
   * Silence window before a probe message is sent into the run session
   * (2026-09-06 unification grill); parsed from the definition's `silence:`
   * front matter with the same duration syntax as `timeout:`, defaults to
   * {@link DEFAULT_SILENCE_MS}.
   */
  silenceMs: number;
  /**
   * Max run duration (wall-clock timeout) for this queue's tasks, parsed
   * from the definition's `timeout:` front matter (same duration syntax as
   * a scheduled task's `timeout:`). Absent when the field is not set — the
   * controller then falls back to its own default (the same 5-hour
   * constant as scheduled tasks, `DEFAULT_TIMEOUT_MS` in task-file.ts).
   */
  timeoutMs: number | undefined;
  /** Worker model override; absent/blank → the channel agent config's model. */
  model: string | undefined;
  /**
   * Queue-level working directory for every run of this queue (parsed like a
   * scheduled task's `directory:` — spec D6 fire-time validation, the storage
   * layer never touches the filesystem). Absent/blank → undefined; the
   * controller falls back to the bridge process cwd. A task-level
   * `directory:` (the task file's own front matter) overrides this value.
   */
  directory: string | undefined;
  /** Delivery address — the destination chat's clientSessionId, written by `/queue-here`. */
  target: string | undefined;
  /**
   * Persistent disable switch (same semantics as a scheduled task's
   * `enabled`): only the exact value `false` disables; absent or any other
   * value means enabled. A disabled queue is skipped by its controller —
   * pending tasks pile up untouched until the queue is re-enabled.
   */
  enabled: boolean;
  /** Shared context appended to every task prompt of this queue (may be empty). */
  body: string;
  /** Absolute path of the definition file. */
  filePath: string;
}

/** A parsed, validated queue task (spec D1). */
export interface QueueTask {
  /** Task id — the file name without `.md`; `queue:<name>:<taskId>` run suffix. */
  id: string;
  /**
   * `pending` | `running` | `failed`; a `running` task at shutdown is
   * re-enqueued on start, a `failed` one is dead-lettered and only ever
   * re-queued explicitly (`queue retry`).
   */
  state: "pending" | "running" | "failed";
  /** ISO timestamp of enqueue; the id's ms prefix comes from the same clock. */
  enqueuedAt: string;
  /** The task prompt (required, non-empty). */
  prompt: string;
  /**
   * Task-level working directory override (highest precedence over the queue
   * definition's `directory:`; written by `queue insert --directory`). Parsed
   * like a scheduled task's `directory:` — validated at fire time only.
   */
  directory: string | undefined;
  /**
   * Task-level model override (T03), highest precedence over the queue
   * definition's `model:`; written by `queue insert --model`. Absent/blank →
   * undefined: the chain then continues at the definition and finally the
   * channel agent config's model (no built-in default participates).
   */
  model: string | undefined;
  /**
   * Task-level wall-clock run limit in ms (T03), highest precedence over the
   * queue definition's `timeout:`, then the controller's built-in default;
   * written by `queue insert --timeout`. Parsed from the `timeout:` front
   * matter with the same duration syntax as the definition's.
   */
  timeoutMs: number | undefined;
  /**
   * Task-level silence-probe window in ms (T03), highest precedence over the
   * queue definition's `silence:`; written by `queue insert --silence`.
   * Parsed from the `silence:` front matter with the same duration syntax.
   */
  silenceMs: number | undefined;
  /**
   * ISO timestamp of the failure (dead-letter trace, spec D2/T02); present
   * only on `failed` tasks (cleared again by `queue retry`).
   */
  failedAt: string | undefined;
  /** Failure reason of the dead-lettered run; present only on `failed` tasks. */
  reason: string | undefined;
  /**
   * Agent session id of the failed run (dead-letter trace, spec D2/T02);
   * present only on `failed` tasks whose session was actually created.
   */
  agentSessionId: string | undefined;
  /** Absolute path of the task file. */
  filePath: string;
}

/** Per-file parse outcome: a definition that fails validation is `null`. */
export interface LoadedQueueDefinition {
  definition: QueueDefinition | null;
  errors: string[];
  warnings: string[];
}

/** Per-file parse outcome: a task that fails validation is `null`. */
export interface LoadedQueueTask {
  task: QueueTask | null;
  errors: string[];
  warnings: string[];
}

/** Input for {@link writeQueueDefinition} (the `queue add` wizard). */
export interface QueueDefinitionInput {
  name: string;
  workers?: number;
  model?: string;
  /** Queue-level working directory; blank/absent → the line is not written. */
  directory?: string;
  /**
   * Queue-level run-parameter overrides (T06): raw duration strings parsed
   * with the same grammar as the task side; blank/absent → the line is not
   * written (the controller's built-in default applies).
   */
  timeout?: string;
  silence?: string;
  /** Shared context written as the file body; blank/absent → an empty body. */
  body?: string;
}

/** Outcome of creating a queue definition (create-only, spec D4). */
export type WriteQueueDefinitionResult =
  | { ok: true; filePath: string }
  | { ok: false; reason: string };

/** Outcome of binding a chat as a queue's delivery target (`/queue-here`, spec D4). */
export type BindQueueResult = { ok: true } | { ok: false; reason: string };

/** True when `name` is a valid queue name (`[a-z0-9-]+`). */
export function isValidQueueName(name: string): boolean {
  return QUEUE_NAME_RE.test(name);
}

/** True when `taskId` matches the `<enqueueMs>-<random4>` id shape. */
export function isValidTaskId(taskId: string): boolean {
  return TASK_ID_RE.test(taskId);
}

/**
 * Absolute queues directory. A caller-supplied root may use `~`/`~/...`,
 * expanded against the bridge user's home directory (same resolution as the
 * built-in `QUEUES_DIR`).
 */
export function getQueuesDir(queuesRoot: string = QUEUES_DIR): string {
  return expandHome(queuesRoot);
}

/** Absolute path of a queue definition file: `queues/<name>.md`. */
export function getQueueFilePath(name: string, queuesRoot: string = QUEUES_DIR): string {
  return path.join(getQueuesDir(queuesRoot), `${name}.md`);
}

/** Absolute directory holding a queue's task files: `queues/<name>.tasks/`. */
export function getQueueTasksDir(name: string, queuesRoot: string = QUEUES_DIR): string {
  return path.join(getQueuesDir(queuesRoot), `${name}.tasks`);
}

/**
 * Parses one queue definition file's content into a {@link LoadedQueueDefinition}.
 * Never throws: validation failures land in `errors` and yield a `null`
 * definition (the listers skip those files with a log). `fileName` is used
 * verbatim for the queue name (minus a trailing `.md`); name-shape
 * validation is the loader's job.
 */
export function parseQueueDefinition(
  fileName: string,
  content: string,
  filePath: string = "",
): LoadedQueueDefinition {
  const name = fileName.endsWith(".md") ? fileName.slice(0, -".md".length) : fileName;
  const { frontMatter, body } = splitFrontMatter(content);
  const { fields, warnings } = parseFrontMatter(frontMatter);
  const errors: string[] = [];

  for (const key of Object.keys(fields)) {
    if (!KNOWN_DEFINITION_KEYS.has(key)) {
      warnings.push(`unknown front matter key "${key}"`);
    }
  }

  const channel = nonEmptyString(fields.channel);
  // `channel` is optional (absent until `/queue-here` binds the queue, T1):
  // a definition without it is valid and owned by no controller.

  let workers = DEFAULT_WORKERS;
  const workersRaw = fields.workers;
  if (workersRaw !== undefined && workersRaw.trim() !== "") {
    if (/^-?\d+$/.test(workersRaw)) {
      const parsed = Number(workersRaw);
      if (Number.isInteger(parsed) && parsed >= 1) {
        workers = parsed;
      } else {
        errors.push(`invalid workers "${workersRaw}": must be an integer >= 1`);
      }
    } else {
      errors.push(`invalid workers "${workersRaw}": must be an integer >= 1`);
    }
  }

  let silenceMs = DEFAULT_SILENCE_MS;
  if (fields.silence !== undefined && fields.silence.trim() !== "") {
    const parsed = parseTimeout(fields.silence);
    if (parsed.ok) {
      silenceMs = parsed.ms;
    } else {
      errors.push(`invalid silence "${fields.silence}": ${parsed.reason}`);
    }
  }

  let timeoutMs: number | undefined;
  if (fields.timeout !== undefined && fields.timeout.trim() !== "") {
    const parsed = parseTimeout(fields.timeout);
    if (parsed.ok) {
      timeoutMs = parsed.ms;
    } else {
      errors.push(`invalid timeout "${fields.timeout}": ${parsed.reason}`);
    }
  }

  const definition: QueueDefinition | null =
    errors.length === 0
      ? {
          name,
          channel,
          workers,
          silenceMs,
          timeoutMs,
          model: nonEmptyString(fields.model),
          directory: nonEmptyString(fields.directory),
          target: nonEmptyString(fields.target),
          // Only the exact value `false` (case-insensitive) disables; same
          // rule as a scheduled task's `enabled` field.
          enabled: !(fields.enabled !== undefined && fields.enabled.toLowerCase() === "false"),
          body: body.trim(),
          filePath,
        }
      : null;

  return { definition, errors, warnings };
}

/**
 * Parses one task file's content into a {@link LoadedQueueTask}. Never
 * throws: validation failures land in `errors` and yield a `null` task (the
 * lister skips those files with a log). `fileName` is the task file name;
 * the id is the name minus a trailing `.md` (shape validation is the
 * loader's job).
 */
export function parseQueueTaskFile(
  fileName: string,
  content: string,
  filePath: string = "",
): LoadedQueueTask {
  const id = fileName.endsWith(".md") ? fileName.slice(0, -".md".length) : fileName;
  const { frontMatter, body } = splitFrontMatter(content);
  const { fields, warnings } = parseFrontMatter(frontMatter);
  const errors: string[] = [];

  for (const key of Object.keys(fields)) {
    if (!KNOWN_TASK_KEYS.has(key)) {
      warnings.push(`unknown front matter key "${key}"`);
    }
  }

  const stateRaw = fields.state;
  if (stateRaw === undefined) {
    errors.push('missing required front matter key "state"');
  } else if (!TASK_STATES.has(stateRaw)) {
    errors.push(`invalid state "${stateRaw}": must be "pending", "running" or "failed"`);
  }

  const enqueuedAt = fields.enqueuedAt;
  if (enqueuedAt === undefined) {
    errors.push('missing required front matter key "enqueuedAt"');
  } else if (Number.isNaN(Date.parse(enqueuedAt))) {
    errors.push(`invalid enqueuedAt "${enqueuedAt}": not an ISO timestamp`);
  }

  const prompt = body.trim();
  if (prompt === "") {
    errors.push("task body is empty — nothing would be sent when this task runs");
  }

  // Task-level run-parameter overrides (T03), same parse rules as the
  // definition side: `timeout` / `silence` via parseTimeout, a failure lands
  // in `errors` and nulls the task; `model` only needs to be non-empty.
  let timeoutMs: number | undefined;
  if (fields.timeout !== undefined && fields.timeout.trim() !== "") {
    const parsed = parseTimeout(fields.timeout);
    if (parsed.ok) {
      timeoutMs = parsed.ms;
    } else {
      errors.push(`invalid timeout "${fields.timeout}": ${parsed.reason}`);
    }
  }

  let silenceMs: number | undefined;
  if (fields.silence !== undefined && fields.silence.trim() !== "") {
    const parsed = parseTimeout(fields.silence);
    if (parsed.ok) {
      silenceMs = parsed.ms;
    } else {
      errors.push(`invalid silence "${fields.silence}": ${parsed.reason}`);
    }
  }

  const task: QueueTask | null =
    errors.length === 0
      ? {
          id,
          state: stateRaw as QueueTask["state"],
          enqueuedAt: enqueuedAt as string,
          prompt,
          directory: nonEmptyString(fields.directory),
          model: nonEmptyString(fields.model),
          timeoutMs,
          silenceMs,
          // Dead-letter fields (spec D2/T02): present only on failed tasks.
          failedAt: nonEmptyString(fields.failedAt),
          reason: nonEmptyString(fields.reason),
          agentSessionId: nonEmptyString(fields.agentSessionId),
          filePath,
        }
      : null;

  return { task, errors, warnings };
}

/**
 * Scans the queues directory and returns every valid queue definition,
 * sorted by name. Files whose names are not valid queue names and
 * definitions that fail validation are skipped with a log; non-`.md` entries
 * and the `<name>.tasks/` subdirectories are ignored. A missing directory is
 * not an error: it yields an empty list.
 *
 * @param queuesRoot Overridable root (defaults to {@link QUEUES_DIR}); tests
 *   point this at a temporary directory.
 */
export async function listQueueDefinitions(
  queuesRoot: string = QUEUES_DIR,
): Promise<QueueDefinition[]> {
  const dir = getQueuesDir(queuesRoot);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const definitions: QueueDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -".md".length);
    if (!isValidQueueName(name)) {
      console.warn(
        `[queue] skipping "${path.join(dir, entry.name)}": queue names must match [a-z0-9-]+`,
      );
      continue;
    }
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      console.warn(`[queue] failed to read "${filePath}": ${(error as Error).message}`);
      continue;
    }
    const { definition, errors } = parseQueueDefinition(entry.name, content, filePath);
    if (definition === null) {
      console.warn(`[queue] skipping "${filePath}": ${errors.join("; ")}`);
      continue;
    }
    definitions.push(definition);
  }

  definitions.sort((a, b) => a.name.localeCompare(b.name));
  return definitions;
}

/**
 * Loads a single queue definition by name, or `null` when the queue is
 * missing or its file fails validation. An invalid name is treated as
 * missing (no file access).
 */
export async function loadQueueDefinition(
  name: string,
  queuesRoot: string = QUEUES_DIR,
): Promise<QueueDefinition | null> {
  if (!isValidQueueName(name)) {
    return null;
  }
  const filePath = getQueueFilePath(name, queuesRoot);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const { definition } = parseQueueDefinition(`${name}.md`, content, filePath);
  return definition;
}

/**
 * Creates a queue definition file (the `queue add` wizard): front matter
 * `workers` (default 1), `timeout`/`silence` when provided (T06), `model` and
 * `directory` when provided, then the body (the shared context, empty when
 * blank). No `channel` is written — a queue stays ownerless and unbound until
 * `/queue-here` writes both `channel` and `target` at bind time. Create-only:
 * refuses to overwrite an existing file, so an already-taken name is reported
 * as an error result (callers re-ask).
 */
export async function writeQueueDefinition(
  input: QueueDefinitionInput,
  queuesRoot: string = QUEUES_DIR,
): Promise<WriteQueueDefinitionResult> {
  const { name, workers = DEFAULT_WORKERS, model, directory, timeout, silence, body = "" } = input;
  if (!isValidQueueName(name)) {
    return { ok: false, reason: "invalid queue name" };
  }
  if (!Number.isInteger(workers) || workers < 1) {
    return { ok: false, reason: "workers must be an integer >= 1" };
  }
  const trimmedModel = model?.trim();
  if (trimmedModel !== undefined && trimmedModel === "") {
    return { ok: false, reason: "model must be a non-empty string when present" };
  }
  const trimmedDirectory = directory?.trim();
  if (trimmedDirectory !== undefined && trimmedDirectory === "") {
    return { ok: false, reason: "directory must be a non-empty string when present" };
  }
  const trimmedTimeout = timeout?.trim();
  if (trimmedTimeout !== undefined && trimmedTimeout === "") {
    return { ok: false, reason: "timeout must be a non-empty string when present" };
  }
  const trimmedSilence = silence?.trim();
  if (trimmedSilence !== undefined && trimmedSilence === "") {
    return { ok: false, reason: "silence must be a non-empty string when present" };
  }

  const filePath = getQueueFilePath(name, queuesRoot);
  try {
    await access(filePath);
    return { ok: false, reason: `queue "${name}" already exists` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return { ok: false, reason: `failed to check queue file: ${(error as Error).message}` };
    }
  }

  // Key order is stable (workers, timeout, silence, model, directory) so
  // snapshots and the parser stay predictable; present-but-blank values are
  // rejected above, so each line is written only when a non-empty value was
  // given ("empty → no line" convention, same as `model`/`directory`).
  const frontMatter = [
    "---",
    `workers: ${workers}`,
    ...(trimmedTimeout !== undefined && trimmedTimeout !== "" ? [`timeout: ${trimmedTimeout}`] : []),
    ...(trimmedSilence !== undefined && trimmedSilence !== "" ? [`silence: ${trimmedSilence}`] : []),
    ...(trimmedModel !== undefined && trimmedModel !== "" ? [`model: ${trimmedModel}`] : []),
    ...(trimmedDirectory !== undefined && trimmedDirectory !== ""
      ? [`directory: ${trimmedDirectory}`]
      : []),
    "---",
  ];
  try {
    await mkdir(getQueuesDir(queuesRoot), { recursive: true });
    const bodyText = body.trim();
    await writeFileAtomic(filePath, `${frontMatter.join("\n")}\n\n${bodyText}${bodyText === "" ? "" : "\n"}`);
  } catch (error) {
    return { ok: false, reason: `failed to write queue file: ${(error as Error).message}` };
  }
  return { ok: true, filePath };
}

/**
 * Enqueues a task: appends `queues/<name>.tasks/<taskId>.md` (created on
 * demand) with `state: pending` and `enqueuedAt` from the same clock as the
 * id's ms prefix, and returns the task id. The task is durable the moment
 * the file lands. Fails (throws) when the queue definition does not exist,
 * the queue name is invalid, or the prompt is empty. The optional overrides
 * (`directory` / `model` / `timeout` / `silence`) land in the task front
 * matter as the task-level run parameters (T03); each is written only when
 * given (blank/undefined → no line) and — except for the non-empty `model` —
 * pre-validated by the caller (the CLI checks `timeout`/`silence` with
 * parseTimeout before calling; the storage layer writes them verbatim).
 */
export async function insertQueueTask(
  name: string,
  prompt: string,
  queuesRoot: string = QUEUES_DIR,
  options: {
    directory?: string;
    model?: string;
    timeout?: string;
    silence?: string;
  } = {},
): Promise<string> {
  if (!isValidQueueName(name)) {
    throw new Error(`invalid queue name "${name}"`);
  }
  const promptText = prompt.trim();
  if (promptText === "") {
    throw new Error("task prompt must be a non-empty string");
  }
  if ((await loadQueueDefinition(name, queuesRoot)) === null) {
    throw new Error(`queue "${name}" not found`);
  }

  const { id, enqueuedAt } = generateTaskId();
  const filePath = path.join(getQueueTasksDir(name, queuesRoot), `${id}.md`);
  // Optional fields are written only when given (blank/undefined → no line),
  // the same omission convention as the definition's `model:`; the order is
  // stable (directory, model, timeout, silence) so snapshots stay predictable.
  const optionalFields = Object.entries({
    directory: options.directory?.trim(),
    model: options.model?.trim(),
    timeout: options.timeout?.trim(),
    silence: options.silence?.trim(),
  }).filter(([, value]) => value !== undefined && value !== "");
  const content = `---\nstate: pending\nenqueuedAt: ${enqueuedAt}\n${optionalFields
    .map(([key, value]) => `${key}: ${value}\n`)
    .join("")}---\n\n${promptText}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, content);
  return id;
}

/**
 * Lists a queue's tasks (pending, running and failed) in FIFO order — the
 * lexicographic file-name order of the `<enqueueMs>-<random4>` ids. Invalid
 * task files (bad state, missing/bad `enqueuedAt`, empty prompt, wrong file
 * name shape) are skipped with a log. A missing tasks directory is not an
 * error: it yields an empty list.
 */
export async function listQueueTasks(
  name: string,
  queuesRoot: string = QUEUES_DIR,
): Promise<QueueTask[]> {
  if (!isValidQueueName(name)) {
    throw new Error(`invalid queue name "${name}"`);
  }
  const tasksDir = getQueueTasksDir(name, queuesRoot);
  let entries: Dirent[];
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const tasks: QueueTask[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const id = entry.name.slice(0, -".md".length);
    if (!isValidTaskId(id)) {
      console.warn(
        `[queue] skipping "${path.join(tasksDir, entry.name)}": task ids must match <enqueueMs>-<random4>`,
      );
      continue;
    }
    const filePath = path.join(tasksDir, entry.name);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      console.warn(`[queue] failed to read "${filePath}": ${(error as Error).message}`);
      continue;
    }
    const { task, errors } = parseQueueTaskFile(entry.name, content, filePath);
    if (task === null) {
      console.warn(`[queue] skipping "${filePath}": ${errors.join("; ")}`);
      continue;
    }
    tasks.push(task);
  }

  // Lexicographic file-name order IS the FIFO order (taskId = <ms>-<random4>).
  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tasks;
}

/** The live task states {@link setQueueTaskState} flips between. */
type LiveTaskState = "pending" | "running";

/**
 * Transitions a task's `state` (`pending` ↔ `running`): a surgical,
 * atomic front-matter edit that replaces the `state:` line in place and
 * preserves the body and every other line byte-for-byte. Throws when the
 * queue name, the task id, or the task file is missing. The `failed`
 * terminal state is intentionally out of reach here: entering it goes
 * through {@link failQueueTask} (which co-writes the dead-letter fields),
 * leaving it through {@link retryQueueTask} (which clears them).
 */
export async function setQueueTaskState(
  name: string,
  taskId: string,
  state: LiveTaskState,
  queuesRoot: string = QUEUES_DIR,
): Promise<void> {
  if (!isValidQueueName(name)) {
    throw new Error(`invalid queue name "${name}"`);
  }
  if (!isValidTaskId(taskId)) {
    throw new Error(`invalid task id "${taskId}"`);
  }
  const filePath = path.join(getQueueTasksDir(name, queuesRoot), `${taskId}.md`);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`task "${taskId}" not found in queue "${name}"`);
    }
    throw error;
  }
  await writeFileAtomic(filePath, applyFrontMatterField(content, "state", state));
}

/**
 * Reads a task file for the dead-letter editors below. Throws the standard
 * "not found" error when the file is missing; the callers validate the
 * queue name / task id shapes first.
 */
async function readTaskFileForEdit(
  name: string,
  taskId: string,
  queuesRoot: string,
): Promise<{ filePath: string; content: string }> {
  const filePath = path.join(getQueueTasksDir(name, queuesRoot), `${taskId}.md`);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`task "${taskId}" not found in queue "${name}"`);
    }
    throw error;
  }
  return { filePath, content };
}

/** Input of {@link failQueueTask}: the dead-letter trace fields (spec D2). */
export interface FailQueueTaskInput {
  /**
   * Agent session id of the failed run; present only when the session was
   * actually created (a fire failure before `session.new` succeeded has
   * none).
   */
  agentSessionId?: string;
  /** Human-readable failure reason recorded alongside the state. */
  reason: string;
}

/**
 * Dead-letters a task (spec D2/T02): flips `state:` to `failed` and writes
 * `failedAt` (ISO timestamp of the failure) plus `reason` — and
 * `agentSessionId` when the run had one — in ONE atomic write (the four
 * front-matter edits are composed in memory first, then committed together,
 * never one rename per field). The body and every other line are preserved
 * byte-for-byte. The failed file stays on disk for tracing; re-queueing is
 * the explicit {@link retryQueueTask}. Throws when the queue name, the task
 * id, or the task file is missing.
 */
export async function failQueueTask(
  name: string,
  taskId: string,
  input: FailQueueTaskInput,
  queuesRoot: string = QUEUES_DIR,
): Promise<void> {
  if (!isValidQueueName(name)) {
    throw new Error(`invalid queue name "${name}"`);
  }
  if (!isValidTaskId(taskId)) {
    throw new Error(`invalid task id "${taskId}"`);
  }
  const { filePath, content } = await readTaskFileForEdit(name, taskId, queuesRoot);
  let updated = applyFrontMatterField(content, "state", "failed");
  updated = applyFrontMatterField(updated, "failedAt", new Date().toISOString());
  updated = applyFrontMatterField(updated, "reason", input.reason);
  if (input.agentSessionId !== undefined) {
    updated = applyFrontMatterField(updated, "agentSessionId", input.agentSessionId);
  }
  await writeFileAtomic(filePath, updated);
}

/** Outcome of {@link retryQueueTask} (the `queue retry` CLI): */
export type RetryQueueTaskResult = { ok: true } | { ok: false; reason: string };

/** The dead-letter fields {@link retryQueueTask} clears (kept in one place). */
const FAILED_FIELD_KEYS = new Set(["failedAt", "reason", "agentSessionId"]);

/**
 * Re-queues a dead-lettered task (the `queue retry` CLI, spec D2/T02): the
 * task must exist AND be in the `failed` terminal state — anything else is
 * an error result (retrying a pending/running task would double-run it).
 * The edit is one atomic write: `state:` goes back to `pending` and the
 * `failedAt` / `reason` / `agentSessionId` dead-letter lines are removed so
 * the file is byte-identical to a freshly enqueued one (minus `enqueuedAt`,
 * which keeps its original value). Consumption then happens naturally on the
 * controller's next tick. Never throws for the expected failures: an invalid
 * queue name, a missing task, or a non-`failed` state returns an error
 * result.
 */
export async function retryQueueTask(
  name: string,
  taskId: string,
  queuesRoot: string = QUEUES_DIR,
): Promise<RetryQueueTaskResult> {
  if (!isValidQueueName(name)) {
    return { ok: false, reason: "invalid queue name" };
  }
  if (!isValidTaskId(taskId)) {
    return { ok: false, reason: "invalid task id" };
  }
  let filePath: string;
  let content: string;
  try {
    ({ filePath, content } = await readTaskFileForEdit(name, taskId, queuesRoot));
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const { task } = parseQueueTaskFile(`${taskId}.md`, content, filePath);
  if (task === null) {
    return { ok: false, reason: `task "${taskId}" failed validation` };
  }
  if (task.state !== "failed") {
    return {
      ok: false,
      reason: `task "${taskId}" is not failed (state: ${task.state}) — only failed tasks can be retried`,
    };
  }
  try {
    const updated = removeFrontMatterFields(
      applyFrontMatterField(content, "state", "pending"),
      FAILED_FIELD_KEYS,
    );
    await writeFileAtomic(filePath, updated);
  } catch (error) {
    return { ok: false, reason: `failed to write task file: ${(error as Error).message}` };
  }
  return { ok: true };
}

/**
 * Deletes a task file. Throws when the queue name, the task id, or the task
 * file is missing.
 */
export async function deleteQueueTask(
  name: string,
  taskId: string,
  queuesRoot: string = QUEUES_DIR,
): Promise<void> {
  if (!isValidQueueName(name)) {
    throw new Error(`invalid queue name "${name}"`);
  }
  if (!isValidTaskId(taskId)) {
    throw new Error(`invalid task id "${taskId}"`);
  }
  const filePath = path.join(getQueueTasksDir(name, queuesRoot), `${taskId}.md`);
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`task "${taskId}" not found in queue "${name}"`);
    }
    throw error;
  }
}

/**
 * Binds a chat as the queue's delivery target (`/queue-here`, spec D4):
 * writes BOTH `channel` (the current channel's config name) and `target`
 * (the chat's clientSessionId) into the queue file's front matter in one
 * atomic write. Each field is applied with the same surgical, single-line
 * rules as `setQueueTaskState`'s front-matter edit: an existing line is
 * replaced in place; a file with front matter but no such line gets one
 * inserted just before the closing `---`; a file without front matter gets a
 * new front matter block prepended; an unterminated front matter block gets
 * the line appended to the end. In every case the body and all other lines
 * are preserved byte-for-byte (using the file's own line endings) and the
 * write is atomic. Never throws for the expected failures: a missing file,
 * an invalid queue name, or an empty channel/target returns an error result.
 */
export async function bindQueue(
  name: string,
  channel: string,
  target: string,
  queuesRoot: string = QUEUES_DIR,
): Promise<BindQueueResult> {
  if (!isValidQueueName(name)) {
    return { ok: false, reason: "invalid queue name" };
  }
  if (channel.trim() === "") {
    return { ok: false, reason: "channel must be a non-empty string" };
  }
  if (target.trim() === "") {
    return { ok: false, reason: "target must be a non-empty string" };
  }
  const filePath = getQueueFilePath(name, queuesRoot);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: false, reason: "queue not found" };
    }
    return { ok: false, reason: `failed to read queue file: ${(error as Error).message}` };
  }
  try {
    const updated = applyFrontMatterField(
      applyFrontMatterField(content, "channel", channel),
      "target",
      target,
    );
    await writeFileAtomic(filePath, updated);
  } catch (error) {
    return { ok: false, reason: `failed to write queue file: ${(error as Error).message}` };
  }
  return { ok: true };
}

/** Outcome of toggling a queue's `enabled` front matter (the enable/disable CLI). */
export type SetQueueEnabledResult = { ok: true } | { ok: false; reason: string };

/**
 * Sets the queue definition's `enabled` front-matter field (the persistent
 * disable switch, mirroring {@link setTaskEnabled} for scheduled tasks):
 * `false` pauses consumption — pending tasks pile up untouched; `true`
 * re-enables it and the backlog drains on the next controller tick. The edit
 * is the same surgical, atomic, single-line rewrite as {@link bindQueue}.
 * Never throws for the expected failures: an invalid queue name or a missing
 * file returns an error result (the CLI reports it).
 */
export async function setQueueEnabled(
  name: string,
  enabled: boolean,
  queuesRoot: string = QUEUES_DIR,
): Promise<SetQueueEnabledResult> {
  if (!isValidQueueName(name)) {
    return { ok: false, reason: "invalid queue name" };
  }
  const filePath = getQueueFilePath(name, queuesRoot);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: false, reason: "queue not found" };
    }
    return { ok: false, reason: `failed to read queue file: ${(error as Error).message}` };
  }
  try {
    await writeFileAtomic(
      filePath,
      applyFrontMatterField(content, "enabled", enabled ? "true" : "false"),
    );
  } catch (error) {
    return { ok: false, reason: `failed to write queue file: ${(error as Error).message}` };
  }
  return { ok: true };
}

let lastEnqueueMs = 0;

/**
 * Generates the next task id `<enqueueMs>-<random4>` plus its `enqueuedAt`
 * ISO string. The ms prefix is strictly monotonic within this process (a
 * same-ms insert bumps the prefix by 1), so lexicographic id order always
 * matches insertion order — the FIFO contract of spec D1.
 */
function generateTaskId(): { id: string; enqueuedAt: string } {
  const now = Date.now();
  const enqueueMs = now > lastEnqueueMs ? now : lastEnqueueMs + 1;
  lastEnqueueMs = enqueueMs;
  return {
    id: `${enqueueMs}-${randomBytes(2).toString("hex")}`,
    enqueuedAt: new Date(enqueueMs).toISOString(),
  };
}

