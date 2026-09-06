/**
 * Shared front-matter storage utilities: the flat `key: value` subset parser
 * and the surgical edit / atomic write helpers used by the schedule and queue
 * storage modules (`task-file.ts` / `queue-file.ts`). No business logic lives
 * here — key schemas, validation rules and error semantics stay with the
 * owning modules.
 *
 * Front matter is a flat `key: value` subset (no YAML dependency): one key
 * per line, values are bare strings with surrounding quotes stripped, `#`
 * comment lines and blank lines are ignored, malformed lines produce
 * warnings. A file that does not start with a `---` line has no front
 * matter: the whole file is the body. Parsing never throws for bad content.
 * All writes are atomic: a same-directory temp file (named
 * `.<basename>.<pid>.<uuid>.tmp`) is written and renamed over the target.
 */

import { rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

/** Outcome of parsing a front-matter block into raw `key -> value` fields. */
export type ParsedFrontMatter = { fields: Record<string, string>; warnings: string[] };

/**
 * Splits raw file content into front matter (lines between the two `---`
 * delimiters) and body (everything after the closing `---`, untrimmed). A
 * file that does not start with `---` has no front matter: the whole content
 * is the body. An unterminated `---` block consumes the rest of the file as
 * front matter, leaving an empty body.
 */
export function splitFrontMatter(content: string): { frontMatter: string; body: string } {
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
export function parseFrontMatter(raw: string): ParsedFrontMatter {
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
export function stripQuotes(value: string): string {
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
export function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Returns `content` with the front-matter field `key` set to `value`
 * (surgical single-line rewrite): an existing `key:` line is replaced in
 * place; a file with front matter but no such line gets one inserted just
 * before the closing `---`; a file without front matter gets a minimal block
 * prepended; an unterminated front matter block gets the line appended to
 * the end. The returned text differs from the input only where the field
 * lives; line endings are preserved (the inserted text uses the file's own
 * line endings).
 */
export function applyFrontMatterField(content: string, key: string, value: string): string {
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

/**
 * Returns `content` with every front-matter line whose key is in `keys`
 * removed (surgical single-block edit): only lines inside the front-matter
 * block are considered; the body and every other line are preserved
 * byte-for-byte (the file's own line endings are kept). A file without front
 * matter — or a block without any matching key — is returned unchanged.
 * The result is meant to be written with a single atomic write (compose with
 * {@link applyFrontMatterField} first when a field also changes value).
 */
export function removeFrontMatterFields(content: string, keys: ReadonlySet<string>): string {
  if (keys.size === 0) return content;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(eol);
  if (lines[0]?.trim() !== "---") return content;
  // An unterminated block: the parser treats the rest of the file as front
  // matter, so every matching line after the opener is removable.
  let closeIndex = lines.length;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIndex = i;
      break;
    }
  }
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i < closeIndex) {
      const colon = lines[i].indexOf(":");
      const fieldKey = colon === -1 ? lines[i].trim() : lines[i].slice(0, colon).trim();
      if (keys.has(fieldKey)) continue;
    }
    kept.push(lines[i]);
  }
  return kept.join(eol);
}

/**
 * Expands `~` / `~/...` against the bridge user's home directory. A
 * caller-supplied homedir overrides the resolution (testability).
 */
export function expandHome(input: string, homedir: string = os.homedir()): string {
  if (input === "~") return homedir;
  if (input.startsWith("~/")) return path.join(homedir, input.slice(2));
  return input;
}

/** Same-directory temp file + rename commit (atomic single-file write). */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
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
