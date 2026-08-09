import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PiCodingAgentAdapter } from "./adapter/pi-coding-agent-adapter";
import { resolveWorkingDirectory } from "./working-directory";
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

async function buildAdapter(
  config: PiCodingAgentConfig,
  agentSessionId: string,
  workingDirectory?: string,
): Promise<AgentAdapter> {
  const cwd = await resolveWorkingDirectory(workingDirectory);
  return new PiCodingAgentAdapter({
    agentSessionId,
    cwd,
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
      const model = await ctx.input("Pi model (leave empty for pi default)", {
        placeholder: "Example: azure-openai-responses/gpt-5.6-terra",
      });
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
  async createAgentSession({ config, common, workingDirectory }) {
    const agentSessionId = `pi-coding-agent:${randomUUID()}`;
    logger.info(`creating agent session ${agentSessionId} for channel ${common.channelName}`);
    return {
      agentSessionId,
      agentAdapter: await buildAdapter(config, agentSessionId, workingDirectory),
    };
  },
  async resumeAgentSession({ config, common, agentSessionId, workingDirectory }) {
    logger.info(`resuming agent session ${agentSessionId} for channel ${common.channelName}`);
    return buildAdapter(config, agentSessionId, workingDirectory);
  },
};
