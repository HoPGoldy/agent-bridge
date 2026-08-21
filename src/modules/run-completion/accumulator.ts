/**
 * Run output accumulator (decided in the 2026-08-19 grill,
 * 2026-08-19（二）, decision 3): during a run, every assistant message
 * (including silence-probe Q&A) is appended to a per-run Markdown file under
 * `RUN_OUTPUTS_DIR`. The accumulator tracks the LAST appended message (used
 * for delivery) and the full file is kept as a durable transcript; the
 * delivery suffix references the file so recipients can read the whole run.
 *
 * Pure fs, no gateway dependencies: the controllers (scheduler T3, queue
 * controller T4) own the run lifecycle and call `append` on every
 * `assistant.message` they divert.
 *
 * Durability choice (documented per ticket): plain append-mode writes
 * (`appendFile`) instead of write-tmp-rename. The accumulation file is a
 * best-effort progress log whose value is surviving process crashes so a
 * long run's partial output can still be delivered; an append is already
 * atomic at the OS level for the sizes involved (single small write, local
 * fs, O_APPEND), and a torn write at worst loses the tail of one message.
 * Full-file atomic rewrite (tmp+rename) would protect against partial
 * writes but is O(file) per message and offers no meaningful extra
 * guarantee for a log-structured file.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OutboundAttachment } from "../../types";
import { RUN_OUTPUTS_DIR } from "../../config/channel-state";

/** Attachment collected from a run's assistant messages. */
export interface CollectedAttachment {
  filePath: string;
  fileName?: string;
}

/**
 * Sanitizes a synthetic run session id (`schedule:<task>:<yyyymmdd-hhmmss>-<seq>`,
 * `queue:<queue>:<taskId>`) into a safe file-name stem: every character
 * outside `[A-Za-z0-9._-]` collapses to `_`, and the stem is truncated to a
 * bounded length.
 */
export function sanitizeSessionId(sessionId: string): string {
  const sanitized = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized.slice(0, 128);
}

/** Per-run accumulator handle. See {@link createRunAccumulator}. */
export interface RunAccumulator {
  /** Absolute path of the accumulation file. */
  readonly filePath: string;
  /**
   * Writes the run's header (Markdown front matter + the full prompt,
   * run-history spec D6) at the very START of the accumulation file,
   * creating the directory and the file (registration-time creation — a
   * registered run always has an Output File). Contract: call at most ONCE
   * and BEFORE any {@link append} — a header cannot be prepended in front
   * of existing messages, so a second call (or one after an append) throws.
   * The caller owns the format; this method only ensures the block ends
   * with a blank line so the first appended message stays clearly
   * separated from the header.
   */
  writeHeader(markdown: string): Promise<void>;
  /** Appends one assistant message's text and collects its attachments. */
  append(text: string, attachments?: readonly OutboundAttachment[]): Promise<void>;
  /** Attachments collected from every appended message, in arrival order. */
  readonly collectedAttachments: readonly CollectedAttachment[];
  /** The last appended message's text (marker already stripped). */
  readonly lastMessage: string;
  /** Reads everything accumulated so far. */
  readAll(): Promise<string>;
}

export interface RunAccumulatorOptions {
  /** Synthetic run session id; the file stem is {@link sanitizeSessionId} of it. */
  sessionId: string;
  /** Storage root; defaults to the shared `RUN_OUTPUTS_DIR`. */
  outputsDir?: string;
}

/** Creates a per-run output accumulator. See module doc. */
export function createRunAccumulator(options: RunAccumulatorOptions): RunAccumulator {
  const dir = options.outputsDir ?? RUN_OUTPUTS_DIR;
  const filePath = path.join(dir, `${sanitizeSessionId(options.sessionId)}.md`);

  // The file accumulates text; attachments are collected for the final
  // delivery (read back via `collectedAttachments`). `last` tracks the most
  // recently appended message so a controller can deliver only that one
  // while the file keeps the whole run.
  const collected: CollectedAttachment[] = [];
  let last = "";
  let headerWritten = false;
  let appended = false;

  async function writeHeader(markdown: string): Promise<void> {
    if (headerWritten) {
      throw new Error("run accumulator header already written");
    }
    if (appended) {
      throw new Error("run accumulator header must be written before any append");
    }
    headerWritten = true;
    await mkdir(dir, { recursive: true });
    // Normalize the tail to a blank line so the header and the first
    // appended message never glue together.
    const block = markdown.endsWith("\n\n")
      ? markdown
      : markdown.endsWith("\n")
        ? `${markdown}\n`
        : `${markdown}\n\n`;
    await writeFile(filePath, block, "utf8");
  }

  async function append(text: string, messageAttachments?: readonly OutboundAttachment[]): Promise<void> {
    appended = true;
    for (const attachment of messageAttachments ?? []) {
      collected.push({ filePath: attachment.filePath, ...(attachment.fileName !== undefined ? { fileName: attachment.fileName } : {}) });
    }
    await mkdir(dir, { recursive: true });
    last = text;
    const block = text.trim() === "" ? "\n" : `${text}\n\n`;
    await appendFile(filePath, block, "utf8");
  }

  return {
    filePath,
    writeHeader,
    append,
    get collectedAttachments(): readonly CollectedAttachment[] {
      return collected;
    },
    get lastMessage(): string {
      return last;
    },
    async readAll(): Promise<string> {
      try {
        return await readFile(filePath, "utf8");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return "";
        }
        throw error;
      }
    },
  };
}
