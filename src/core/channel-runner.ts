import type { ChannelRunner, RunChannelOptions } from "../types";
import { GatewayCore } from "./gateway-core";
import { createLogger } from "./logger";
import { createFileChannelStateStore, getChannelStateStorePath } from "../config/channel-state";
import { createAgentSessionStateRegistry } from "../config/agent-session-state";
import { createClientSessionStateStore } from "../config/client-session-state";
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

  const channelStateStore = createFileChannelStateStore(getChannelStateStorePath(channelName));
  const agentSessionStateRegistry = createAgentSessionStateRegistry(channelStateStore);
  const clientSessionStateStore = createClientSessionStateStore({
    channelStateStore,
    clientType: clientModule.type,
    codec: clientModule.sessionStateCodec,
  });

  const imAdapter = clientModule.createClientAdapter({
    config: channelConfig.client.config,
    common,
    sessionState: clientSessionStateStore,
  });

  const core = new GatewayCore({
    imAdapter,
    agentModule,
    agentConfig: channelConfig.agent.config,
    agentIdleTimeoutMs: defaults.agentIdleTimeoutMs,
    ...(defaults.allowedWorkingDirectoryRoots !== undefined
      ? { allowedWorkingDirectoryRoots: defaults.allowedWorkingDirectoryRoots }
      : {}),
    channelStateStore,
    agentSessionStateRegistry,
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
