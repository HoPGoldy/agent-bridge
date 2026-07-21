import os from "node:os";
import path from "node:path";
import type { ChannelRunner, RunChannelOptions } from "../types";
import { PiRpcAgentAdapter } from "../adapters/agent/pi-rpc-agent-adapter";
import { FeishuIMAdapter } from "../adapters/im/feishu-im-adapter";
import { GatewayCore } from "./gateway-core";

function parseExtraArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function runChannel({ channelName, channelConfig, defaults }: RunChannelOptions): Promise<ChannelRunner> {
  if (channelConfig.type !== "feishu") {
    throw new Error(`Unsupported channel type: ${channelConfig.type}`);
  }

  const imAdapter = new FeishuIMAdapter(channelConfig);
  const piBin = process.env.PI_BIN ?? "pi";
  const piSessionDir = process.env.PI_SESSION_DIR ?? path.join(os.homedir(), ".config", "agent-bridge", "pi-sessions");
  const piExtraArgs = parseExtraArgs(process.env.PI_RPC_EXTRA_ARGS);

  const core = new GatewayCore({
    imAdapter,
    pollIntervalMs: defaults.pollIntervalMs,
    maxQueueSize: defaults.maxQueueSize,
    agentIdleTimeoutMs: defaults.agentIdleTimeoutMs,
    agentFactory: {
      async create(sessionId, onOutput) {
        const adapter = new PiRpcAgentAdapter({
          sessionId,
          cwd: process.cwd(),
          sessionDir: piSessionDir,
          bin: piBin,
          extraArgs: piExtraArgs,
        });
        await adapter.start(onOutput);
        return adapter;
      },
    },
  });

  await core.start();
  console.log(`[runner] channel ${channelName} started`);
  console.log("[runner] press Ctrl+C to stop");

  return {
    async stop() {
      await core.stop();
      console.log(`[runner] channel ${channelName} stopped`);
    },
  };
}
