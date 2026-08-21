/**
 * Shared run-completion module: the DONE-marker protocol, silence probe and
 * per-run output accumulator used by BOTH the scheduler (T3) and the queue
 * controller (T4). Decided in the 2026-08-19 grill session（二）.
 */
export {
  DONE_MARKER,
  buildProbeMessage,
  buildTaskPrompt,
  classifyMessage,
  type MessageClassification,
} from "./protocol";
export {
  createRunAccumulator,
  sanitizeSessionId,
  type CollectedAttachment,
  type RunAccumulator,
  type RunAccumulatorOptions,
} from "./accumulator";
export { createSilenceProbe, type SilenceProbe, type SilenceProbeOptions } from "./silence-probe";
