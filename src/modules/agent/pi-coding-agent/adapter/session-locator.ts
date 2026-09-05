import { open, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A provider session located for adoption: the canonical jsonl file plus the
 * authoritative header values (pi writes `id` and `cwd` into the first line).
 */
export interface LocatedPiSession {
  /** Canonical (realpath-resolved) absolute path of the session jsonl file. */
  sessionFile: string;
  /** Session id from the file header (preferred over the queried string). */
  sessionId: string;
  /** Working directory recorded in the file header; not yet canonicalized. */
  cwd: string;
}

export interface LocatePiSessionOptions {
  /**
   * Bridge session directory (same precedence as the spawn step:
   * config.sessionDir > PI_SESSION_DIR > default private dir). Searched
   * before the pi default sessions root.
   */
  sessionDir?: string;
  /** Home directory for `~` expansion and the pi sessions root; defaults to `os.homedir()`. */
  homedir?: string;
  /** Base for resolving relative path-shaped input; defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Thrown when a provider session string cannot be resolved to exactly one
 * session file (not found, ambiguous prefix, unreadable file or malformed
 * header). The raw query is always part of the message.
 */
export class PiSessionLocateError extends Error {
  /** Candidate session ids when the failure is an ambiguous match. */
  readonly candidates?: string[];

  constructor(message: string, candidates?: string[]) {
    super(message);
    this.name = "PiSessionLocateError";
    this.candidates = candidates;
  }
}

const JSONL_SUFFIX = ".jsonl";

function expandHome(input: string, homedir: string): string {
  if (input === "~") return homedir;
  if (input.startsWith("~/")) return path.join(homedir, input.slice(2));
  return input;
}

function describeFsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "no such file";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  return error instanceof Error ? error.message : String(error);
}

/**
 * Extracts the `<id>` part of a pi session file name. pi names session files
 * `<timestamp>_<id>.jsonl`; files without the separator are not session
 * files and never match.
 */
function sessionIdFromFileName(fileName: string): string | undefined {
  if (!fileName.endsWith(JSONL_SUFFIX)) return undefined;
  const base = fileName.slice(0, -JSONL_SUFFIX.length);
  const separator = base.indexOf("_");
  if (separator <= 0) return undefined;
  const id = base.slice(separator + 1);
  return id.length > 0 ? id : undefined;
}

interface DirectoryMatches {
  exact: string[];
  prefix: string[];
}

/** Matches `*.jsonl` session file names in one flat directory. A missing or unreadable directory yields no matches. */
async function matchSessionFilesInDir(dir: string, query: string): Promise<DirectoryMatches> {
  const matches: DirectoryMatches = { exact: [], prefix: [] };
  let fileNames: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return matches;
  }
  for (const fileName of fileNames) {
    const id = sessionIdFromFileName(fileName);
    if (id === undefined) continue;
    if (id === query) {
      matches.exact.push(path.join(dir, fileName));
    } else if (id.startsWith(query)) {
      matches.prefix.push(path.join(dir, fileName));
    }
  }
  return matches;
}

/**
 * Scans the pi default sessions root (`~/.pi/agent/sessions/<project-dir>/`,
 * context §3.3). Only descends when the root exists; a missing root simply
 * yields no matches.
 */
async function matchSessionFilesInPiRoot(root: string, query: string): Promise<DirectoryMatches> {
  const matches: DirectoryMatches = { exact: [], prefix: [] };
  let projectDirs: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    projectDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return matches;
  }
  for (const dir of projectDirs) {
    const found = await matchSessionFilesInDir(dir, query);
    matches.exact.push(...found.exact);
    matches.prefix.push(...found.prefix);
  }
  return matches;
}

function candidateIds(files: string[]): string[] {
  const ids = files
    .map((file) => sessionIdFromFileName(path.basename(file)))
    .filter((id): id is string => id !== undefined);
  return [...new Set(ids)].sort();
}

/**
 * Upper bound for the header read. The header is a single short JSON line;
 * the cap only guards against reading an unbounded file that has no newline
 * at all, so the subsequent JSON.parse reports the malformed file instead of
 * buffering megabytes of session history.
 */
const FIRST_LINE_MAX_BYTES = 1_048_576;

/**
 * Reads only up to the first newline. Session files grow into the megabytes
 * over a session's lifetime; reading the whole file to parse the header would
 * scale with that history for every `/resume`.
 */
async function readFirstLine(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const stream = handle.createReadStream({ encoding: "utf8" });
    let buffer = "";
    for await (const chunk of stream) {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        return buffer.slice(0, newlineIndex);
      }
      if (buffer.length >= FIRST_LINE_MAX_BYTES) {
        break; // leaving the iterator destroys the stream
      }
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * Parses the session header. pi stores `{"type":"session","id":...,"cwd":...}`
 * as the first line of every session file; only that line is read and the
 * document version is never interpreted (context §3.3).
 */
async function readSessionHeader(sessionFile: string, query: string): Promise<LocatedPiSession> {
  let canonical: string;
  try {
    // Canonicalize so the persisted sessionFile (and the occupancy registry
    // key derived from it) is stable across symlinked path spellings.
    canonical = await realpath(sessionFile);
  } catch (error) {
    throw new PiSessionLocateError(
      `provider session "${query}": cannot open session file "${sessionFile}": ${describeFsError(error)}`,
    );
  }

  let firstLine: string;
  try {
    firstLine = await readFirstLine(canonical);
  } catch (error) {
    throw new PiSessionLocateError(
      `provider session "${query}": cannot read session file "${canonical}": ${describeFsError(error)}`,
    );
  }

  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch (error) {
    throw new PiSessionLocateError(
      `provider session "${query}": malformed session header in "${canonical}" (first line is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  const record = header !== null && typeof header === "object" ? (header as Record<string, unknown>) : undefined;
  const id = record?.id;
  const cwd = record?.cwd;
  if (typeof id !== "string" || id.length === 0 || typeof cwd !== "string" || cwd.length === 0) {
    throw new PiSessionLocateError(
      `provider session "${query}": malformed session header in "${canonical}" (expected non-empty "id" and "cwd" fields)`,
    );
  }
  return { sessionFile: canonical, sessionId: id, cwd };
}

/** Resolves one tier (exact or prefix hits) to a session, or undefined when the tier is empty. */
async function resolveTier(files: string[], query: string): Promise<LocatedPiSession | undefined> {
  if (files.length === 0) return undefined;
  if (files.length === 1) return readSessionHeader(files[0]!, query);
  const ids = candidateIds(files);
  throw new PiSessionLocateError(
    `provider session "${query}" is ambiguous: it matches ${files.length} sessions (${ids.join(", ")})`,
    ids,
  );
}

/**
 * Locates a provider session from the raw `/resume` string (adopt spec,
 * implementation requirement 1). Tries, in order:
 *
 * 1. path-shaped input (contains a path separator or ends with `.jsonl`) —
 *    treated as a literal session file path (`~` expanded, relative paths
 *    resolved against `options.cwd` or the process cwd);
 * 2. exact `*_<id>.jsonl` match in the bridge session dir;
 * 3. unique id-prefix match in the bridge session dir (multiple hits →
 *    ambiguous error listing the candidate ids);
 * 4. the pi default sessions root `~/.pi/agent/sessions/<project-dir>/`,
 *    scanned only when it exists.
 *
 * The located file's first line supplies the authoritative `id` and `cwd`.
 * Every failure carries the original query string.
 */
export async function locatePiSession(
  raw: string,
  options: LocatePiSessionOptions = {},
): Promise<LocatedPiSession> {
  const query = raw.trim();
  if (!query) {
    throw new PiSessionLocateError("provider session id must not be empty");
  }
  const homedir = options.homedir ?? os.homedir();

  // ① Path-shaped input is taken literally: a missing path-shaped file can
  // never be a session id, so there is nothing to fall through to.
  if (query.includes("/") || query.includes(path.sep) || query.endsWith(JSONL_SUFFIX)) {
    const expanded = expandHome(query, homedir);
    const sessionFile = path.isAbsolute(expanded) ? expanded : path.resolve(options.cwd ?? process.cwd(), expanded);
    return readSessionHeader(sessionFile, query);
  }

  // ②③ Bridge session dir first (flat layout).
  if (options.sessionDir !== undefined) {
    const found = await matchSessionFilesInDir(options.sessionDir, query);
    const resolved = (await resolveTier(found.exact, query)) ?? (await resolveTier(found.prefix, query));
    if (resolved) return resolved;
  }

  // ④ pi default sessions root, one subdirectory per project directory.
  const piRoot = path.join(homedir, ".pi", "agent", "sessions");
  const piFound = await matchSessionFilesInPiRoot(piRoot, query);
  const piResolved = (await resolveTier(piFound.exact, query)) ?? (await resolveTier(piFound.prefix, query));
  if (piResolved) return piResolved;

  const searched = [options.sessionDir, piRoot].filter((dir) => dir !== undefined).join(", ");
  throw new PiSessionLocateError(`provider session "${query}" not found (searched ${searched})`);
}
