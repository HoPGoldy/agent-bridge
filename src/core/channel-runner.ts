import type { ChannelRunner, RunChannelOptions } from "../types";
import { GatewayCore } from "./gateway-core";
import { getTypedAgentModule } from "../modules/agent";
import { getTypedClientModule } from "../modules/client";

export async function runChannel({ channelName, channelConfig, defaults }: RunChannelOptions): Promise<ChannelRunner> {
  const clientModule = getTypedClientModule(channelConfig.client);
  const agentModule = getTypedAgentModule(channelConfig.agent);

  const imAdapter = clientModule.createClientAdapter(channelConfig.client.config);

  const core = new GatewayCore({
    imAdapter,
    agentModule,
    agentConfig: channelConfig.agent.config,
    agentIdleTimeoutMs: defaults.agentIdleTimeoutMs,
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
