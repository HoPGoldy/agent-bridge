import os from "node:os";
import path from "node:path";
import { PiRpcAgentAdapter } from "../../adapters/agent/pi-rpc-agent-adapter";
import type { AgentModule, PiRpcAgentConfig } from "../../types";

function parseExtraArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

export const piRpcAgentModule: AgentModule<PiRpcAgentConfig> = {
  type: "pi-rpc",
  createAgentAdapter(config) {
    return new PiRpcAgentAdapter({
      cwd: process.cwd(),
      sessionDir:
        config.sessionDir ??
        process.env.PI_SESSION_DIR ??
        path.join(os.homedir(), ".config", "agent-bridge", "pi-sessions"),
      bin: config.bin ?? process.env.PI_BIN ?? "pi",
      extraArgs: config.extraArgs ?? parseExtraArgs(process.env.PI_RPC_EXTRA_ARGS),
    });
  },
};
