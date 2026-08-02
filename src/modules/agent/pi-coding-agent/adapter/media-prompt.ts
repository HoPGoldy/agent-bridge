import { MEDIA_CONVENTION_PROMPT } from "../../media-convention";

/**
 * Loaded per-invocation via `--extension <path>` when agent-bridge spawns a
 * `pi` subprocess (see PiRpcClient.start()). This is intentionally the only
 * thing this extension does: no tool registration, no IPC, no env vars.
 *
 * `before_agent_start` fires with `event.systemPrompt` already being Pi's
 * fully-assembled prompt — all of Pi's own file-based discovery
 * (project `.pi/APPEND_SYSTEM.md`, global `~/.pi/agent/APPEND_SYSTEM.md`)
 * has already run by this point. The hook's result is documented as
 * "chained" across multiple extensions, so appending here cannot clobber
 * another extension's or the project's own system-prompt contributions —
 * unlike passing `--append-system-prompt` directly, which replaces Pi's own
 * file discovery outright (see docs/attachment-transfer-spec.md).
 *
 * Lives under `src/` and is built as a separate tsup entry because nothing
 * in the main agent-bridge import graph references it directly. It is loaded
 * by an external `pi` process via the path resolved by `pi-extension-path.ts`.
 *
 * The model-facing convention is shared with other agent adapters; this
 * file only adapts it to Pi's extension hook.
 */
export default function (pi: {
  on: (
    event: "before_agent_start",
    handler: (event: { systemPrompt: string }) => { systemPrompt: string },
  ) => void;
}) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${MEDIA_CONVENTION_PROMPT}`,
  }));
}
