import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Path to `media-prompt.ts`, relative to the agent-bridge package root.
 * Used only for the dev-mode fallback (running via `tsx`, unbuilt). Kept as
 * a single named constant so a future rename/move only needs to update
 * this one line.
 */
const MEDIA_PROMPT_RELATIVE_PATH = path.join(
  "src",
  "modules",
  "agent",
  "pi-coding-agent",
  "adapter",
  "media-prompt.ts",
);

/**
 * Resolve the absolute path to the media-prompt extension, passed to a
 * spawned `pi` subprocess via `--extension`.
 *
 * `media-prompt.ts` is its own tsup entry (see tsup.config.ts), so a
 * production build always emits a compiled `dist/media-prompt.js` sitting
 * right next to `dist/cli.js` / `dist/agent-bridge.js` — the same flat
 * folder this resolver's own code gets bundled into. Checking for that
 * sibling first means production/dev is decided by a plain `existsSync`
 * check on what's actually on disk, not by an env var (e.g. `NODE_ENV`)
 * that some caller has to remember to set correctly — a raw `tsx`/`node`
 * invocation that forgets to set it would otherwise silently fall through
 * to the wrong branch.
 *
 * When there's no bundled sibling (running via `tsx` straight from source,
 * before any `npm run build`), this falls back to walking up from its own
 * location looking for `package.json` (the package root marker) and
 * descending into the known source path — `dist/` and deeply-nested `src/`
 * sit at different depths from the package root, so a fixed number of
 * `..` segments can't cover both.
 */
export function resolveMediaPromptExtensionPath(): string {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));

  const bundledCandidate = path.join(selfDir, "media-prompt.js");
  if (existsSync(bundledCandidate)) {
    return bundledCandidate;
  }

  let dir = selfDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "package.json"))) {
      const candidate = path.join(dir, MEDIA_PROMPT_RELATIVE_PATH);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate a built dist/media-prompt.js or ${MEDIA_PROMPT_RELATIVE_PATH} relative to the agent-bridge package root`,
  );
}
