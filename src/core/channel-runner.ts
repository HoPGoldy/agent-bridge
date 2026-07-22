import type { ChannelRunner, RunChannelOptions } from "../types";
import { GatewayCore } from "./gateway-core";
import { createLogger } from "./logger";
import { getTypedAgentModule } from "../modules/agent";
import { getTypedClientModule } from "../modules/client";

const logger = createLogger("runner");

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
  logger.info(`channel ${channelName} started`);
  logger.info("press Ctrl+C to stop");

  return {
    async stop() {
      await core.stop();
      logger.info(`channel ${channelName} stopped`);
    },
  };
}
