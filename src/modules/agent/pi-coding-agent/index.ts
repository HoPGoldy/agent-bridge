import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PiRpcAgentAdapter } from "./adapter/pi-rpc-agent-adapter";
import { createLogger } from "../../../core/logger";
import type { AgentAdapter, AgentModule, PiRpcAgentConfig } from "../../../types";

const logger = createLogger("pi-rpc");

function parseExtraArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildAdapter(config: PiRpcAgentConfig, agentSessionId: string): AgentAdapter {
  return new PiRpcAgentAdapter({
    agentSessionId,
    cwd: process.cwd(),
    sessionDir:
      config.sessionDir ??
      process.env.PI_SESSION_DIR ??
      path.join(os.homedir(), ".config", "agent-bridge", "pi-sessions"),
    bin: config.bin ?? process.env.PI_BIN ?? "pi",
    extraArgs: config.extraArgs ?? parseExtraArgs(process.env.PI_RPC_EXTRA_ARGS),
  });
}

export const piRpcAgentModule: AgentModule<PiRpcAgentConfig> = {
  type: "pi-rpc",
  async createAgentSession({ config }) {
    const agentSessionId = `pi-rpc:${randomUUID()}`;
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
