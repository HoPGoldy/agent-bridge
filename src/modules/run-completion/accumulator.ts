/**
 * Run output accumulator (decided in `docs/grill-context/qa-log.md`,
 * 2026-08-19（二）, decision 3): during a run, every assistant message
 * (including silence-probe Q&A) is appended to a per-run Markdown file under
 * `RUN_OUTPUTS_DIR`; the full file is delivered once when the run ends.
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

import { appendFile, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { OutboundAttachment } from "../../types";
import { RUN_OUTPUTS_DIR } from "../../config/channel-state";

/** Attachment collected from a run's assistant messages. */
export interface CollectedAttachment {
  filePath: string;
  fileName?: string;
}

/**
 * Sanitizes a synthetic run session id (`schedule:<task>:<n>`,
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
  /** Appends one assistant message's text and collects its attachments. */
  append(text: string, attachments?: readonly OutboundAttachment[]): Promise<void>;
  /** Attachments collected from every appended message, in arrival order. */
  readonly collectedAttachments: readonly CollectedAttachment[];
  /** Reads everything accumulated so far (final delivery). */
  readAll(): Promise<string>;
  /** Deletes the accumulation file (idempotent). */
  dispose(): Promise<void>;
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
  // delivery (read back via `collectedAttachments`).
  const collected: CollectedAttachment[] = [];

  async function append(text: string, messageAttachments?: readonly OutboundAttachment[]): Promise<void> {
    for (const attachment of messageAttachments ?? []) {
      collected.push({ filePath: attachment.filePath, ...(attachment.fileName !== undefined ? { fileName: attachment.fileName } : {}) });
    }
    await mkdir(dir, { recursive: true });
    const block = text.trim() === "" ? "\n" : `${text}\n\n`;
    await appendFile(filePath, block, "utf8");
  }

  return {
    filePath,
    append,
    get collectedAttachments(): readonly CollectedAttachment[] {
      return collected;
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
    async dispose(): Promise<void> {
      await unlink(filePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw error;
        }
      });
    },
  };
}
