import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ResolveWorkingDirectoryOptions {
  /** Base for resolving relative paths; defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory used for `~` expansion; defaults to `os.homedir()`. */
  homedir?: string;
}

function expandHome(input: string, homedir: string): string {
  if (input === "~") return homedir;
  if (input.startsWith("~/")) return path.join(homedir, input.slice(2));
  return input;
}

function describeFsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "ENOENT":
      return "no such file or directory";
    case "ENOTDIR":
      return "a path component is not a directory";
    case "EACCES":
    case "EPERM":
      return "permission denied";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Normalizes and validates a user-supplied working directory for a new agent
 * session.
 *
 * - empty/undefined input keeps the current process working directory
 * - `~` and `~/...` are expanded against the home directory
 * - relative paths are resolved against `process.cwd()` (or `options.cwd`)
 * - symlinks are canonicalized with `realpath`
 * - the target must exist, be a directory, and be readable/enterable by this
 *   process
 * - no shell-style environment variable expansion is performed
 *
 * Throws a user-facing error that includes the resolved target path and the
 * reason, so it can be surfaced directly through the gateway failure message.
 */
export async function resolveWorkingDirectory(
  raw: string | undefined,
  options: ResolveWorkingDirectoryOptions = {},
): Promise<string> {
  if (!raw || !raw.trim()) {
    return options.cwd ?? process.cwd();
  }

  const homedir = options.homedir ?? os.homedir();
  const baseCwd = options.cwd ?? process.cwd();
  const expanded = expandHome(raw.trim(), homedir);
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(baseCwd, expanded);

  let canonical: string;
  try {
    canonical = await realpath(resolved);
  } catch (error) {
    throw new Error(`invalid working directory "${resolved}": ${describeFsError(error)}`);
  }

  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new Error(`invalid working directory "${canonical}": not a directory`);
  }

  try {
    await access(canonical, constants.R_OK | constants.X_OK);
  } catch (error) {
    throw new Error(`invalid working directory "${canonical}": ${describeFsError(error)}`);
  }

  return canonical;
}
