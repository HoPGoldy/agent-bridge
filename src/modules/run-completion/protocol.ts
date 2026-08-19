/**
 * Shared run-completion protocol for scheduled tasks and event queues
 * (decided in `docs/grill-context/qa-log.md`, 2026-08-19（二）, layer 1 + 2).
 *
 * The three-layer completion contract:
 *
 * 1. The agent appends {@link DONE_MARKER} on the last line of its FINAL
 *    message when the task is fully done (intermediate messages carry no
 *    marker). The bridge detects and strips it via {@link classifyMessage}.
 * 2. After N minutes of silence without a DONE marker, the controller sends
 *    a probe message ({@link buildProbeMessage}) into the session. A probe
 *    with no answer gets no special handling — layer 3 is the only backstop.
 * 3. The wall-clock run timeout (owned by the controllers) caps everything.
 *
 * Pure logic: no fs, no timers, no gateway dependencies.
 */

/** Marker the agent appends to its final message when the task is fully done. */
export const DONE_MARKER = "BRIDGE_TASK_STATUS_DONE";

/**
 * Fixed English protocol instruction appended to every task prompt by
 * {@link buildTaskPrompt}. Model-agnostic by design: it only describes the
 * marker convention, not any tool or runtime.
 */
const TASK_PROTOCOL_BLOCK = [
  "---",
  "Task completion protocol:",
  "- Work on the task above until it is FULLY complete, including any async follow-ups you are still waiting on (background jobs, sub-agents, external callbacks).",
  `- When — and only when — the task is fully complete, append the marker \`${DONE_MARKER}\` as the last line of your final message. Never include the marker in intermediate messages.`,
  "- If you are asked whether the task is finished, answer honestly; append the marker only when it truly is finished.",
].join("\n");

/**
 * Wraps a task prompt with the shared context (a queue body; may be empty)
 * and the fixed completion-protocol instruction block. Result shape:
 * `<body>\n\n<prompt>\n\n<protocol block>` (body omitted when blank).
 */
export function buildTaskPrompt(body: string, prompt: string): string {
  const trimmedBody = body.trim();
  const task = trimmedBody === "" ? prompt : `${trimmedBody}\n\n${prompt}`;
  return `${task}\n\n${TASK_PROTOCOL_BLOCK}`;
}

/**
 * The silence-probe user message (layer 2): asks the agent to either report
 * DONE or keep working / waiting on its async callbacks.
 */
export function buildProbeMessage(silentMinutes: number): string {
  return `You have been silent for ${silentMinutes} minutes. Is the task finished? If yes, reply and append ${DONE_MARKER} on the last line. If not, continue working / keep waiting for your async callbacks.`;
}

/** Outcome of {@link classifyMessage}. */
export interface MessageClassification {
  /** True when the DONE marker sits in the last non-empty line. */
  done: boolean;
  /** When done: the message with the marker line stripped; otherwise the text unchanged. */
  content: string;
}

/**
 * Classifies an assistant message against the DONE-marker protocol.
 *
 * Detection is robust: CRLF is normalized, trailing whitespace/blank lines
 * after the marker line are tolerated, and the marker may appear anywhere in
 * the last NON-EMPTY line (so `some text BRIDGE_TASK_STATUS_DONE` counts).
 * A marker in an earlier line only ("marker mid-text") is NOT a completion
 * signal — the content is returned unchanged.
 *
 * When done, the marker's whole line is stripped (plus trailing blank lines);
 * a marker-only message classifies as done with empty content.
 */
export function classifyMessage(text: string): MessageClassification {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  let markerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      if (lines[i].includes(DONE_MARKER)) {
        markerIndex = i;
      }
      break;
    }
  }

  if (markerIndex === -1) {
    return { done: false, content: text };
  }

  const kept = lines.slice(0, markerIndex);
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") {
    kept.pop();
  }
  return { done: true, content: kept.join("\n") };
}
