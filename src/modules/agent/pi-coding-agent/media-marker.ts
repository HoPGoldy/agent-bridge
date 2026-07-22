import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { OutboundAttachment } from "../../../types";

/**
 * `MEDIA:<path>` outbound attachment convention: the regex/validation that
 * recognizes the format lives here. The system-prompt text that *describes*
 * the format to the model lives in `./adapter/media-prompt.ts` (its only
 * consumer) instead of here, since nothing in this file depends on that
 * prose. The one invariant that must never drift — a marker written the way
 * the prompt describes is actually recognized by this module — is guarded
 * by a coherence test in `media-marker.test.ts`, not by file co-location.
 */

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const DELIVERABLE_EXTS = new Set([
  ...IMAGE_EXTS,
  "pdf",
  "txt",
  "md",
  "csv",
  "zip",
  "docx",
  "xlsx",
  "pptx",
  "json",
]);

// Not anchored to line start — the marker may appear mid-sentence, matching
// Hermes's proven behavior. The path must look absolute (~/, /, or a Windows
// drive letter) and end in a recognized extension; optionally quoted/backticked.
const MEDIA_TAG_RE =
  /[`"']?MEDIA:\s*(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|(?:~\/|\/|[A-Za-z]:[/\\])[^\s`"']+\.\w+)[`"']?/gi;

/**
 * Replace fenced code blocks and inline code spans with spaces (preserving
 * length/offsets) so example snippets that merely *mention* the MEDIA:
 * convention are never mistaken for a real delivery directive. Pi is a
 * coding agent, so this risk is materially higher than in a general chat
 * agent.
 */
function maskProtectedSpans(text: string): string {
  const chars = [...text];
  const maskRange = (re: RegExp) => {
    for (const match of text.matchAll(re)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      for (let i = start; i < end; i++) {
        if (chars[i] !== "\n") chars[i] = " ";
      }
    }
  };
  maskRange(/```[\s\S]*?```/g);
  maskRange(/`[^`\n]+`/g);
  return chars.join("");
}

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && "`\"'".includes(trimmed[0])) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Single judgment call shared by both "should this be delivered" and "should
 * this be stripped from the visible text" — never two independently
 * maintained checks.
 *
 * The existence check (`existsSync` + `realpathSync`) is the primary defense
 * against false positives: a hallucinated or documentation-example path
 * essentially never exists at that literal location, so it is left alone
 * instead of misfiring.
 */
function resolveDeliverablePath(rawPath: string): string | null {
  const stripped = stripQuotes(rawPath);
  const expanded = stripped.startsWith("~") ? path.join(os.homedir(), stripped.slice(1)) : stripped;
  const candidate = path.resolve(expanded);
  const ext = candidate.split(".").pop()?.toLowerCase() ?? "";
  if (!DELIVERABLE_EXTS.has(ext)) return null;
  if (!existsSync(candidate)) return null;
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

export interface ExtractedMediaMarkers {
  text: string;
  attachments: OutboundAttachment[];
}

export function extractMediaMarkers(rawText: string): ExtractedMediaMarkers {
  const scanText = maskProtectedSpans(rawText);
  const attachments: OutboundAttachment[] = [];
  const spansToStrip: Array<[number, number]> = [];

  for (const match of scanText.matchAll(MEDIA_TAG_RE)) {
    const resolved = resolveDeliverablePath(match[1]);
    if (!resolved) continue;
    const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
    attachments.push({
      kind: IMAGE_EXTS.has(ext) ? "image" : "file",
      filePath: resolved,
    });
    const start = match.index ?? 0;
    spansToStrip.push([start, start + match[0].length]);
  }

  let cleaned = rawText;
  for (const [start, end] of spansToStrip.reverse()) {
    cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  }

  return { text: cleaned.trim(), attachments };
}
