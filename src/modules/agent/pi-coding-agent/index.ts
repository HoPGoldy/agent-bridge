import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PiCodingAgentAdapter } from "./adapter/pi-coding-agent-adapter";
import { createLogger } from "../../../core/logger";
import type { AgentAdapter, AgentModule, ConfigAdapter, PiCodingAgentConfig } from "../../../types";

const logger = createLogger("pi-coding-agent");

function parseExtraArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildAdapter(config: PiCodingAgentConfig, agentSessionId: string): AgentAdapter {
  return new PiCodingAgentAdapter({
    agentSessionId,
    cwd: process.cwd(),
    sessionDir:
      config.sessionDir ??
      process.env.PI_SESSION_DIR ??
      path.join(os.homedir(), ".config", "agent-bridge", "pi-sessions"),
    bin: config.bin ?? process.env.PI_BIN ?? "pi",
    model: config.model ?? process.env.PI_MODEL,
    extraArgs: config.extraArgs ?? parseExtraArgs(process.env.PI_RPC_EXTRA_ARGS),
  });
}

function createPiCodingAgentConfigCollector(): ConfigAdapter<PiCodingAgentConfig> {
  return {
    async collect(ctx) {
      const model = await ctx.input("Pi model (leave empty for pi default)");
      return model ? { model } : {};
    },

    validate(config) {
      if (config.model !== undefined && !config.model.trim()) {
        throw new Error("Pi model must be non-empty when provided");
      }
    },

    summarize(config) {
      return `type=pi-coding-agent model=${config.model ?? "default"}`;
    },
  };
}

export const piCodingAgentModule: AgentModule<PiCodingAgentConfig> = {
  type: "pi-coding-agent",
  createConfigCollector: createPiCodingAgentConfigCollector,
  async createAgentSession({ config }) {
    const agentSessionId = `pi-coding-agent:${randomUUID()}`;
    logger.info(`creating agent session ${agentSessionId}`);
    return {
      agentSessionId,
      agentAdapter: buildAdapter(config, agentSessionId),
    };
  },
  async resumeAgentSession({ config, agentSessionId }) {
    logger.info(`resuming agent session ${agentSessionId}`);
    return buildAdapter(config, agentSessionId);
  },
};
