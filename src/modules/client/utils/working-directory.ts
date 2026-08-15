import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ValidateWorkingDirectoryOptions {
  /** Base for resolving relative paths; defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory used for `~` expansion; defaults to `os.homedir()`. */
  homedir?: string;
}

export type WorkingDirectoryValidation =
  | { ok: true; directory: string }
  | { ok: false; directory: string; detail: string };

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
 * Client-side UX pre-check for `/new <path>`: expands `~`, resolves relative
 * paths against the bridge process cwd, canonicalizes with `realpath`, and
 * verifies the target exists, is a directory, and is readable/enterable.
 *
 * This mirrors the agent-side validation (Pi's `resolveWorkingDirectory`) but
 * deliberately skips the allowlist — the allowlist is a security boundary and
 * stays enforced by the agent backend. The client check exists so an invalid
 * path is rejected before any event is emitted and is never remembered as the
 * chat's default.
 *
 * Assumption (documented in `docs/opencode.md`): the agent runtime shares the
 * bridge's filesystem. Deployments where the agent server runs on another
 * host/container are not recommended, because this local check can misjudge
 * remote-only paths.
 *
 * On success the canonical directory is returned (used both in the emitted
 * event and as the remembered default); on failure `directory` is the
 * resolved (pre-canonicalization) target for display and `detail` is a
 * user-facing reason.
 */
export async function validateWorkingDirectory(
  raw: string,
  options: ValidateWorkingDirectoryOptions = {},
): Promise<WorkingDirectoryValidation> {
  const homedir = options.homedir ?? os.homedir();
  const baseCwd = options.cwd ?? process.cwd();
  const expanded = expandHome(raw.trim(), homedir);
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(baseCwd, expanded);

  let canonical: string;
  try {
    canonical = await realpath(resolved);
  } catch (error) {
    return { ok: false, directory: resolved, detail: describeFsError(error) };
  }

  const info = await stat(canonical).catch(() => null);
  if (!info?.isDirectory()) {
    return { ok: false, directory: canonical, detail: "not a directory" };
  }

  try {
    await access(canonical, constants.R_OK | constants.X_OK);
  } catch (error) {
    return { ok: false, directory: canonical, detail: describeFsError(error) };
  }

  return { ok: true, directory: canonical };
}
