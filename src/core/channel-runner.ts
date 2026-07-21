import type { ChannelRunner, RunChannelOptions } from "../types";
import { PiRpcAgentAdapter } from "../adapters/agent/pi-rpc-agent-adapter";
import { FeishuIMAdapter } from "../adapters/im/feishu-im-adapter";
import { GatewayCore } from "./gateway-core";

export async function runChannel({ channelName, channelConfig, defaults }: RunChannelOptions): Promise<ChannelRunner> {
  if (channelConfig.type !== "feishu") {
    throw new Error(`Unsupported channel type: ${channelConfig.type}`);
  }

  const imAdapter = new FeishuIMAdapter(channelConfig);
  const rpcEndpoint = process.env.PI_RPC_ENDPOINT ?? "http://127.0.0.1:8787";

  const core = new GatewayCore({
    imAdapter,
    pollIntervalMs: defaults.pollIntervalMs,
    maxQueueSize: defaults.maxQueueSize,
    agentIdleTimeoutMs: defaults.agentIdleTimeoutMs,
    agentFactory: {
      async create(sessionId, onOutput) {
        const adapter = new PiRpcAgentAdapter({ sessionId, endpoint: rpcEndpoint });
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
