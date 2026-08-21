/**
 * Run history index (run-history spec D1/D2): one append-only JSONL file per
 * module (`run-history/schedule.jsonl`, `run-history/queue.jsonl`) holding
 * exactly one line per finished run — outcome, duration and pointers to the
 * Output File / agent session. Schedule and queue deliberately keep separate
 * files (persistence is split per module), but the read/write code is shared,
 * which is this module.
 *
 * Durability mirrors the accumulator's philosophy: plain append-mode writes
 * (`mkdir(recursive)` + single-line `appendFile`) instead of
 * write-tmp-rename. Each line is a small (< 1 KB) single write on a local fs
 * under O_APPEND, so appends are atomic at the OS level and multiple
 * channels/processes can share the file without a lock. The index is pure
 * observability: a failed append is logged (warn) and swallowed — it must
 * never affect the run lifecycle or the delivery.
 *
 * The reader is intentionally forgiving (CLI use): a missing file reads as
 * an empty list and malformed lines are skipped with a warning instead of
 * failing the whole listing.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { RUN_HISTORY_DIR } from "../../config/channel-state";
import { createLogger, type Logger } from "../../core/logger";

/** Which module's history file a record belongs to (spec D1: per-module files). */
export type RunHistoryKind = "schedule" | "queue";

/** How a run ended (spec D2). `fire-failed` covers a failed synthetic dispatch. */
export type RunHistoryOutcome = "completed" | "failed" | "timeout" | "fire-failed";

/** One finished run; the JSONL line format (spec D2). */
export interface RunHistoryRecord {
  /** Synthetic clientSessionId (`schedule:<task>:<ts>-<seq>` / `queue:<queue>:<taskId>`). */
  runId: string;
  /** Run start time, ISO UTC. */
  ts: string;
  /** Wall-clock duration in milliseconds (end time − registration time). */
  ms: number;
  outcome: RunHistoryOutcome;
  /** Failure/timeout reason; present on non-completed outcomes. */
  reason?: string;
  /** Config name of the channel that executed the run. */
  channel: string;
  /** agentSessionId, present when the synthetic session.new succeeded (D5). */
  agent?: string;
  /** Absolute path of the run's Output File. */
  file: string;
}

const OUTCOMES: readonly RunHistoryOutcome[] = [
  "completed",
  "failed",
  "timeout",
  "fire-failed",
];

/** History file path for a kind: `<root>/<kind>.jsonl`. */
export function runHistoryFilePath(kind: RunHistoryKind, root?: string): string {
  return path.join(root ?? RUN_HISTORY_DIR, `${kind}.jsonl`);
}

/**
 * Appends one record as a single JSONL line (best-effort, spec D1/D3):
 * creates the directory, appends, and NEVER throws — any failure is logged
 * as a warn through the `run-history` logger (or the injected one, for
 * tests) and swallowed, because the index is pure observability.
 */
export async function appendRunHistory(
  kind: RunHistoryKind,
  record: RunHistoryRecord,
  root?: string,
  logger: Logger = createLogger("run-history"),
): Promise<void> {
  const filePath = runHistoryFilePath(kind, root);
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error: unknown) {
    logger.warn(
      `failed to append ${kind} history line to ${filePath}:`,
      error,
    );
  }
}

/**
 * Reads and parses a kind's whole history file (CLI use, spec D7). A missing
 * file returns `[]`; malformed or invalid lines are skipped with a warn
 * instead of failing the listing. Validation is loose on purpose: the six
 * required fields must merely have the right types (`reason`/`agent` are
 * optional), so an older line missing a newly added field still lists.
 */
export async function readRunHistory(
  kind: RunHistoryKind,
  root?: string,
  logger: Logger = createLogger("run-history"),
): Promise<RunHistoryRecord[]> {
  const filePath = runHistoryFilePath(kind, root);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records: RunHistoryRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRunHistoryLine(line);
    if (record === null) {
      logger.warn(`skipping malformed ${kind} history line in ${filePath}`);
      continue;
    }
    records.push(record);
  }
  return records;
}

/** Parses and loosely validates one JSONL line; `null` when unusable. */
function parseRunHistoryLine(line: string): RunHistoryRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.runId !== "string" || value.runId.length === 0) return null;
  if (typeof value.ts !== "string" || value.ts.length === 0) return null;
  if (typeof value.ms !== "number" || !Number.isFinite(value.ms)) return null;
  if (typeof value.outcome !== "string" || !OUTCOMES.includes(value.outcome as RunHistoryOutcome)) {
    return null;
  }
  if (typeof value.channel !== "string" || value.channel.length === 0) return null;
  if (typeof value.file !== "string" || value.file.length === 0) return null;
  if (value.reason !== undefined && typeof value.reason !== "string") return null;
  if (value.agent !== undefined && typeof value.agent !== "string") return null;
  return {
    runId: value.runId,
    ts: value.ts,
    ms: value.ms,
    outcome: value.outcome as RunHistoryOutcome,
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
    channel: value.channel,
    ...(value.agent !== undefined ? { agent: value.agent } : {}),
    file: value.file,
  };
}
