import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ResolveWorkingDirectoryOptions {
  /** Base for resolving relative paths; defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory used for `~` expansion; defaults to `os.homedir()`. */
  homedir?: string;
  /**
   * Optional allowlist of allowed working-directory roots. When present and
   * non-empty, a user-supplied working directory must resolve inside one of
   * the roots. Bare `/new` (no working directory) is never checked.
   */
  allowedWorkingDirectoryRoots?: string[];
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
 * Canonicalizes every configured root with `realpath` and verifies each one is
 * an existing directory. A broken root is a configuration error and surfaces as
 * a clear error instead of silently weakening the allowlist.
 */
async function resolveAllowedRoots(
  roots: string[],
  options: { cwd?: string; homedir?: string },
): Promise<string[]> {
  const homedir = options.homedir ?? os.homedir();
  const baseCwd = options.cwd ?? process.cwd();
  const canonical: string[] = [];
  for (const rawRoot of roots) {
    const trimmedRoot = rawRoot.trim();
    // Defense in depth: the config store already drops empty entries, but a
    // direct module caller could pass one; an empty root would silently resolve
    // to the base cwd and widen the allowlist.
    if (!trimmedRoot) continue;
    const expanded = expandHome(trimmedRoot, homedir);
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(baseCwd, expanded);

    let root: string;
    try {
      root = await realpath(resolved);
    } catch (error) {
      throw new Error(`invalid allowed working directory root "${resolved}": ${describeFsError(error)}`);
    }

    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new Error(`invalid allowed working directory root "${root}": not a directory`);
    }
    canonical.push(root);
  }
  return canonical;
}

/**
 * Boundary check against a single canonical root. Equal paths and strict
 * descendants are allowed; sibling prefixes (`/work` vs `/work2`) and any `..`
 * escape resolve outside the root and are rejected, while literal child names
 * that merely start with two dots (`..foo`, `...`) stay allowed. Both inputs
 * are already canonical (`realpath`), so symlinks cannot bypass the check.
 */
function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Enforces the optional allowlist. Throws a user-facing error when the
 * canonical target is not inside any allowed root.
 */
async function assertAllowed(canonical: string, roots: string[], options: { cwd?: string; homedir?: string }): Promise<void> {
  if (roots.length === 0) return;
  const allowedRoots = await resolveAllowedRoots(roots, options);
  if (allowedRoots.some((root) => isInsideRoot(root, canonical))) return;
  throw new Error(
    `working directory "${canonical}" is not inside an allowed root (${allowedRoots.join(", ")})`,
  );
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
 *
 * The allowlist is enforced only for user-supplied working directories: a bare
 * `/new` (empty input) keeps the default cwd without any allowlist check.
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

  await assertAllowed(canonical, options.allowedWorkingDirectoryRoots ?? [], { homedir, cwd: baseCwd });

  return canonical;
}
