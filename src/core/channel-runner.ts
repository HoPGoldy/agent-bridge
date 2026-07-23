import type { ChannelRunner, RunChannelOptions } from "../types";
import { GatewayCore } from "./gateway-core";
import { createLogger } from "./logger";
import { createFileSessionBindingStore, getSessionBindingStorePath } from "../config/session-bindings";
import { getTypedAgentModule } from "../modules/agent";
import { getTypedClientModule } from "../modules/client";

const logger = createLogger("runner");

export async function runChannel({ channelName, channelConfig, defaults }: RunChannelOptions): Promise<ChannelRunner> {
  const clientModule = getTypedClientModule(channelConfig.client);
  const agentModule = getTypedAgentModule(channelConfig.agent);
  const common = {
    channelName,
    language: channelConfig.common.language,
  };

  const imAdapter = clientModule.createClientAdapter({ config: channelConfig.client.config, common });
  const bindingStore = createFileSessionBindingStore(getSessionBindingStorePath(channelName));

  const core = new GatewayCore({
    imAdapter,
    agentModule,
    agentConfig: channelConfig.agent.config,
    agentIdleTimeoutMs: defaults.agentIdleTimeoutMs,
    bindingStore,
    common,
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
