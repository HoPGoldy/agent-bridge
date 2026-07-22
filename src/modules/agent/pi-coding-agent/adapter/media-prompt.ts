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
 * Lives under `src/` (typechecked normally by `tsc`/the editor, unlike a
 * loose top-level file) but is never bundled by tsup — nothing in the
 * agent-bridge import graph references this file directly. It is only ever
 * loaded by an external `pi` process via its own file path, resolved at
 * runtime by `pi-extension-path.ts`.
 *
 * `MEDIA_CONVENTION_PROMPT` is defined here (not imported from
 * `../media-marker.ts`) since this is its only consumer — the marker
 * regex/validation in `media-marker.ts` has no dependency on this prose.
 * `media-marker.test.ts` carries a coherence test asserting a marker
 * written the way this text describes is actually recognized, so the two
 * cannot silently drift apart without a test failing.
 */
export const MEDIA_CONVENTION_PROMPT = `When you want to send a local image or file to the user in this chat, include a line containing \`MEDIA:<absolute_path>\` in your reply (the path must point to a file that actually exists on disk). You can put it inline in a sentence or on its own line. Do not use this for files the user should not receive (e.g. credentials, temp scratch files unrelated to the request).`;

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
