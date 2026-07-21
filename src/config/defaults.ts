import type { AppDefaults } from "../types";

export const DEFAULTS: AppDefaults = {
  pollIntervalMs: 500,
  maxQueueSize: 10,
  agentIdleTimeoutMs: 10 * 60 * 1000,
};
