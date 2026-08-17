/**
 * Scheduled task Markdown files: front-matter subset parser, task loader and
 * validator (spec D3/D6).
 *
 * Files live at `~/.config/agent-bridge/schedules/<channel>/<task-name>.md`
 * where the task name is the file name without `.md` and must match
 * `[a-z0-9-]+`. Front matter is a flat `key: value` subset (no YAML
 * dependency): one key per line, values are bare strings with surrounding
 * quotes stripped, `#` comment lines and blank lines are ignored, unknown
 * keys produce warnings. A file that does not start with a `---` line has no
 * front matter: the whole file is the prompt body.
 *
 * Parsing never throws for bad content: every file becomes a {@link LoadedTask}
 * whose `errors`/`warnings` are surfaced by the CLI's `schedule list`. Tasks
 * with errors stay listed; fire-time validation is enforced by the scheduler
 * (spec D6).
 */

import type { Dirent } from "node:fs";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { SCHEDULES_DIR } from "../../config/channel-state";
import { parseSchedule, parseTimeout, type Schedule } from "./grammar";

/** Default max run duration: `10m` (spec D3). */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Task names are the `.md` file names without the extension (spec D3). */
const TASK_NAME_RE = /^[a-z0-9-]+$/;

const KNOWN_KEYS = new Set(["schedule", "directory", "timeout", "enabled", "target"]);

/** A parsed, validated scheduled task. Invalid tasks are still listed; see {@link LoadedTask.errors}. */
export interface ScheduleTask {
  /** Task name — the file name without `.md`; the `schedule:<name>` synthetic session suffix (spec D1). */
  name: string;
  /** Raw schedule string from the front matter, when present (for display). */
  scheduleRaw: string | undefined;
  /** Parsed schedule; `null` when missing or invalid (see `errors`). */
  schedule: Schedule | null;
  /** Working directory for the spawned session, when set (validated at fire time, spec D6). */
  directory: string | undefined;
  /** Max run duration in ms; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs: number;
  /** Whether the task may fire; `enabled: false` pauses it without deleting it (spec D3). */
  enabled: boolean;
  /** Delivery address — the destination chat's clientSessionId, when set (spec D7). */
  target: string | undefined;
  /** The prompt body (everything after the closing `---`, trimmed). */
  prompt: string;
}

/** Per-file load outcome; invalid tasks never throw, problems land in `errors`. */
export interface LoadedTask {
  task: ScheduleTask;
  errors: string[];
  warnings: string[];
}

/** True when `name` is a valid task name (`[a-z0-9-]+`, per spec D3). */
export function isValidTaskName(name: string): boolean {
  return TASK_NAME_RE.test(name);
}

/**
 * Absolute directory holding one channel's task files. The channel name is
 * percent-encoded, mirroring `getChannelStateStorePath`'s handling of channel
 * names in file paths.
 */
export function getSchedulesDir(
  channelName: string,
  schedulesRoot: string = SCHEDULES_DIR,
): string {
  return path.join(schedulesRoot, encodeURIComponent(channelName));
}

/**
 * Parses one task file's content into a {@link LoadedTask}. Never throws:
 * content problems are collected into `errors`/`warnings` so the task stays
 * listable. `fileName` is used verbatim for the task name (minus a trailing
 * `.md`); name-shape validation is the loader's job.
 */
export function parseTaskFile(fileName: string, content: string): LoadedTask {
  const name = fileName.endsWith(".md") ? fileName.slice(0, -".md".length) : fileName;
  const { frontMatter, body } = splitFrontMatter(content);
  const { fields, warnings } = parseFrontMatter(frontMatter);
  const errors: string[] = [];

  for (const key of Object.keys(fields)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`unknown front matter key "${key}"`);
    }
  }

  const scheduleRaw = fields.schedule;
  let schedule: Schedule | null = null;
  if (scheduleRaw === undefined) {
    errors.push('missing required front matter key "schedule"');
  } else {
    const parsed = parseSchedule(scheduleRaw);
    if (parsed.ok) {
      schedule = parsed.schedule;
    } else {
      errors.push(`invalid schedule "${scheduleRaw}": ${parsed.reason}`);
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (fields.timeout !== undefined) {
    const parsed = parseTimeout(fields.timeout);
    if (parsed.ok) {
      timeoutMs = parsed.ms;
    } else {
      errors.push(`invalid timeout "${fields.timeout}": ${parsed.reason}`);
    }
  }

  // Only the exact value `false` (case-insensitive) disables; anything else is enabled.
  const enabled = !(fields.enabled !== undefined && fields.enabled.toLowerCase() === "false");

  const prompt = body.trim();
  if (prompt === "") {
    errors.push("task body is empty — nothing would be sent when this task fires");
  }

  const task: ScheduleTask = {
    name,
    scheduleRaw,
    schedule,
    directory: nonEmptyString(fields.directory),
    timeoutMs,
    enabled,
    target: nonEmptyString(fields.target),
    prompt,
  };

  return { task, errors, warnings };
}

/**
 * Scans one channel's schedule directory and parses every `.md` task file.
 *
 * Files whose names are not valid task names (`[a-z0-9-]+`) are skipped with a
 * warning; non-`.md` entries are ignored. A missing directory is not an error:
 * it yields an empty list. Results are sorted by task name for deterministic
 * display.
 *
 * @param channelName Channel whose task directory is scanned.
 * @param schedulesRoot Overridable root (defaults to {@link SCHEDULES_DIR});
 *   tests point this at a temporary directory.
 */
export async function loadChannelTasks(
  channelName: string,
  schedulesRoot: string = SCHEDULES_DIR,
): Promise<LoadedTask[]> {
  const dir = getSchedulesDir(channelName, schedulesRoot);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const results: LoadedTask[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -".md".length);
    if (!isValidTaskName(name)) {
      console.warn(
        `[schedule] skipping "${path.join(dir, entry.name)}": task names must match [a-z0-9-]+`,
      );
      continue;
    }
    let content: string;
    try {
      content = await readFile(path.join(dir, entry.name), "utf8");
    } catch (error) {
      console.warn(
        `[schedule] failed to read "${path.join(dir, entry.name)}": ${(error as Error).message}`,
      );
      continue;
    }
    results.push(parseTaskFile(entry.name, content));
  }

  results.sort((a, b) => a.task.name.localeCompare(b.task.name));
  return results;
}

/**
 * Splits raw file content into front matter (lines between the two `---`
 * delimiters) and body (everything after the closing `---`, untrimmed). A file
 * that does not start with `---` has no front matter: the whole content is the
 * body. An unterminated `---` block consumes the rest of the file as front
 * matter, leaving an empty body.
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

/** Outcome of writing a task's `target` field (`/schedule-here`, spec D7). */
export type SetTaskTargetResult = { ok: true } | { ok: false; reason: string };

/**
 * Writes `clientSessionId` into the task file's `target` front-matter field
 * (spec D7, `/schedule-here`): the surgical, single-line edit that binds a
 * chat as the task's delivery target.
 *
 * Rules: an existing `target:` line is replaced in place; a file with front
 * matter but no `target` line gets one inserted just before the closing
 * `---`; a file without front matter gets a new front matter block containing
 * only the target line prepended to the head. In every case the body and all
 * other lines are preserved byte-for-byte (the inserted text uses the file's
 * own line endings). The write is atomic: a temporary sibling file is written
 * and renamed over the target (same-directory temp + rename, mirroring the
 * channel-state commit).
 *
 * Never throws for the expected failures: a missing file or an invalid task
 * name returns an error result (callers reply to the triggering chat).
 */
export async function setTaskTarget(
  channelName: string,
  taskName: string,
  clientSessionId: string,
  schedulesRoot: string = SCHEDULES_DIR,
): Promise<SetTaskTargetResult> {
  if (!isValidTaskName(taskName)) {
    return { ok: false, reason: "invalid task name" };
  }

  const filePath = path.join(getSchedulesDir(channelName, schedulesRoot), `${taskName}.md`);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: false, reason: "task not found" };
    }
    return { ok: false, reason: `failed to read task file: ${(error as Error).message}` };
  }

  try {
    await writeFileAtomic(filePath, applyTargetLine(content, clientSessionId));
  } catch (error) {
    return { ok: false, reason: `failed to write task file: ${(error as Error).message}` };
  }
  return { ok: true };
}

/**
 * Returns `content` with the `target` front-matter field set to
 * `clientSessionId`, applying the {@link setTaskTarget} replacement rules.
 * The returned text differs from the input only where the target line lives.
 */
function applyTargetLine(content: string, clientSessionId: string): string {
  // Split/join with the file's own line endings so untouched bytes survive
  // verbatim (a lone stray newline inside a line is left in place).
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(eol);
  const targetLine = `target: ${clientSessionId}`;

  // Front matter starts with a `---` delimiter line.
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
      // matter, so appending the target line keeps the file's semantics (an
      // empty body) unchanged.
      lines.push(targetLine);
      return lines.join(eol);
    }

    for (let i = 1; i < closeIndex; i++) {
      const colon = lines[i].indexOf(":");
      const key = colon === -1 ? lines[i].trim() : lines[i].slice(0, colon).trim();
      if (key === "target") {
        lines[i] = targetLine;
        return lines.join(eol);
      }
    }

    lines.splice(closeIndex, 0, targetLine);
    return lines.join(eol);
  }

  // No front matter: prepend a minimal block containing only the target line.
  return `---${eol}${targetLine}${eol}---${eol}${content}`;
}

/** Same-directory temp file + rename commit, mirroring the channel-state store. */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
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
