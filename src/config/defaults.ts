import type { AppDefaults } from "../types";

export const DEFAULTS: AppDefaults = {
  // Pure event-timestamp idle reap (T1): a session is reaped once its last
  // activity is older than this (default 24h). The /model command performs
  // no busy gating anywhere anymore.
  agentIdleTimeoutMs: 24 * 60 * 60 * 1000,
};
