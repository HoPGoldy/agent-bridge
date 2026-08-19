/**
 * Event queue Markdown files: queue definitions and task files — the storage
 * layer of the event queue (design spec `docs/event-queue-spec.md` D1).
 *
 * Storage root: `~/.config/agent-bridge/queues/`, mirroring the schedules
 * layout. A queue definition is `queues/<name>.md` — front matter `channel`
 * (optional, absent until the queue is bound; written by `/queue-here`),
 * `workers` (integer >= 1, default 1), `model` (optional, blank/absent →
 * undefined), `target` (optional, non-empty, written by `/queue-here`) —
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
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { QUEUES_DIR } from "../../config/channel-state";
import { DEFAULT_SILENCE_MS } from "../schedule/task-file";
import { parseTimeout } from "../schedule/grammar";

/** Synthetic clientSessionId prefix for queue runs (spec D1). Shared with the core. */
export const QUEUE_SESSION_PREFIX = "queue:";

/** Default worker count when the definition's `workers` field is absent (spec D1). */
export const DEFAULT_WORKERS = 1;

/** Queue names are the `.md` file names without the extension (spec D1). */
const QUEUE_NAME_RE = /^[a-z0-9-]+$/;

/** Task ids are `<enqueueMs>-<random4>`; the shape is part of the FIFO contract (spec D1). */
const TASK_ID_RE = /^\d+-[0-9a-f]{4}$/;

const TASK_STATES = new Set(["pending", "running"]);

const KNOWN_DEFINITION_KEYS = new Set(["channel", "workers", "silence", "model", "target"]);
const KNOWN_TASK_KEYS = new Set(["state", "enqueuedAt"]);

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
   * (qa-log 2026-08-19, layer 2); parsed from the definition's `silence:`
   * front matter with the same duration syntax as `timeout:`, defaults to
   * {@link DEFAULT_SILENCE_MS}.
   */
  silenceMs: number;
  /** Worker model override; absent/blank → the channel agent config's model. */
  model: string | undefined;
  /** Delivery address — the destination chat's clientSessionId, written by `/queue-here`. */
  target: string | undefined;
  /** Shared context appended to every task prompt of this queue (may be empty). */
  body: string;
  /** Absolute path of the definition file. */
  filePath: string;
}

/** A parsed, validated queue task (spec D1). */
export interface QueueTask {
  /** Task id — the file name without `.md`; `queue:<name>:<taskId>` run suffix. */
  id: string;
  /** `pending` | `running`; a `running` task at shutdown is re-enqueued on start. */
  state: "pending" | "running";
  /** ISO timestamp of enqueue; the id's ms prefix comes from the same clock. */
  enqueuedAt: string;
  /** The task prompt (required, non-empty). */
  prompt: string;
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

  const definition: QueueDefinition | null =
    errors.length === 0
      ? {
          name,
          channel,
          workers,
          silenceMs,
          model: nonEmptyString(fields.model),
          target: nonEmptyString(fields.target),
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
    errors.push(`invalid state "${stateRaw}": must be "pending" or "running"`);
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

  const task: QueueTask | null =
    errors.length === 0
      ? {
          id,
          state: stateRaw as "pending" | "running",
          enqueuedAt: enqueuedAt as string,
          prompt,
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
 * `workers` (default 1) and `model` when provided, then an empty body. No
 * `channel` is written — a queue stays ownerless and unbound until
 * `/queue-here` writes both `channel` and `target` at bind time. Create-only:
 * refuses to overwrite an existing file, so an already-taken name is reported
 * as an error result (callers re-ask).
 */
export async function writeQueueDefinition(
  input: QueueDefinitionInput,
  queuesRoot: string = QUEUES_DIR,
): Promise<WriteQueueDefinitionResult> {
  const { name, workers = DEFAULT_WORKERS, model, body = "" } = input;
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

  const filePath = getQueueFilePath(name, queuesRoot);
  try {
    await access(filePath);
    return { ok: false, reason: `queue "${name}" already exists` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return { ok: false, reason: `failed to check queue file: ${(error as Error).message}` };
    }
  }

  const frontMatter = [
    "---",
    `workers: ${workers}`,
    ...(trimmedModel !== undefined && trimmedModel !== "" ? [`model: ${trimmedModel}`] : []),
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
 * the queue name is invalid, or the prompt is empty.
 */
export async function insertQueueTask(
  name: string,
  prompt: string,
  queuesRoot: string = QUEUES_DIR,
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
  const content = `---\nstate: pending\nenqueuedAt: ${enqueuedAt}\n---\n\n${promptText}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, content);
  return id;
}

/**
 * Lists a queue's tasks (pending and running) in FIFO order — the
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

/**
 * Transitions a task's `state` (`pending` ↔ `running`): a surgical,
 * atomic front-matter edit that replaces the `state:` line in place and
 * preserves the body and every other line byte-for-byte. Throws when the
 * queue name, the task id, or the task file is missing.
 */
export async function setQueueTaskState(
  name: string,
  taskId: string,
  state: "pending" | "running",
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

/**
 * Splits raw file content into front matter (lines between the two `---`
 * delimiters) and body (everything after the closing `---`, untrimmed). A
 * file that does not start with `---` has no front matter: the whole content
 * is the body. An unterminated `---` block consumes the rest of the file as
 * front matter, leaving an empty body. (Same subset parser as task-file.ts.)
 */
function splitFrontMatter(content: string): { frontMatter: string; body: string } {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontMatter: "", body: content };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return { frontMatter: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
    }
  }
  return { frontMatter: lines.slice(1).join("\n"), body: "" };
}

/** Parses the front-matter block into raw `key -> value` fields. */
function parseFrontMatter(raw: string): { fields: Record<string, string>; warnings: string[] } {
  const fields: Record<string, string> = {};
  const warnings: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      warnings.push(`ignoring malformed front matter line "${line}" — expected "key: value"`);
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = stripQuotes(line.slice(colon + 1).trim());
    fields[key] = value;
  }
  return { fields, warnings };
}

/** Strips a matching pair of surrounding single or double quotes from a value. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Returns the trimmed value, or `undefined` when empty/whitespace-only. */
function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Returns `content` with the front-matter field `key` set to `value`,
 * applying the same surgical rules as `bindTask` in task-file.ts: an
 * existing `key:` line is replaced in place; a file with front matter but no
 * such line gets one inserted just before the closing `---`; a file without
 * front matter gets a minimal block prepended; an unterminated front matter
 * block gets the line appended to the end. The returned text differs from
 * the input only where the field lives; line endings are preserved.
 */
function applyFrontMatterField(content: string, key: string, value: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(eol);
  const line = `${key}: ${value}`;

  if (lines[0]?.trim() === "---") {
    let closeIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        closeIndex = i;
        break;
      }
    }
    if (closeIndex === -1) {
      // Unterminated block: the parser treats the rest of the file as front
      // matter, so appending the line keeps the file's semantics unchanged.
      lines.push(line);
      return lines.join(eol);
    }

    let replaced = false;
    for (let i = 1; i < closeIndex; i++) {
      const colon = lines[i].indexOf(":");
      const fieldKey = colon === -1 ? lines[i].trim() : lines[i].slice(0, colon).trim();
      if (fieldKey === key) {
        lines[i] = line;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      lines.splice(closeIndex, 0, line);
    }
    return lines.join(eol);
  }

  // No front matter: prepend a minimal block containing only the field.
  return `---${eol}${line}${eol}---${eol}${content}`;
}

/** Expands `~` / `~/...` against the bridge user's home directory. */
function expandHome(input: string, homedir: string = os.homedir()): string {
  if (input === "~") return homedir;
  if (input.startsWith("~/")) return path.join(homedir, input.slice(2));
  return input;
}

/** Same-directory temp file + rename commit, mirroring task-file.ts. */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
