import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDevelopmentEnv } from "../../../../config/env";

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
 * production build emits a compiled `dist/media-prompt.js` sitting right
 * next to `dist/cli.js` / `dist/agent-bridge.js` — the same flat folder
 * this resolver's own code gets bundled into.
 *
 * Runtime selection is explicit: only `NODE_ENV=development` uses the
 * source `media-prompt.ts`; every other value (including unset) is treated
 * as production and must use the bundled `media-prompt.js`. We still walk
 * upward to find the package root because this file lives at different
 * depths when executed from `src/` versus `dist/`.
 */
export function resolveMediaPromptExtensionPath(): string {
  const selfDir = path.dirname(fileURLToPath(import.meta.url));

  let dir = selfDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "package.json"))) {
      if (isDevelopmentEnv()) {
        const sourceCandidate = path.join(dir, MEDIA_PROMPT_RELATIVE_PATH);
        if (existsSync(sourceCandidate)) {
          return sourceCandidate;
        }
        throw new Error(
          `NODE_ENV=development but could not locate ${MEDIA_PROMPT_RELATIVE_PATH} relative to the agent-bridge package root`,
        );
      }

      const bundledCandidate = path.join(selfDir, "media-prompt.js");
      if (existsSync(bundledCandidate)) {
        return bundledCandidate;
      }

      throw new Error(
        "NODE_ENV is not development, so agent-bridge expects a built dist/media-prompt.js next to the bundled runtime. Run npm run build before starting in production mode.",
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate the agent-bridge package root while resolving the media-prompt extension path",
  );
}
