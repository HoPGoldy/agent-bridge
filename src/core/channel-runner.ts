import type { ChannelRunner, RunChannelOptions } from "../types";
import { GatewayCore } from "./gateway-core";
import { createLogger } from "./logger";
import { createFileChannelStateStore, getChannelStateStorePath } from "../config/channel-state";
import { createAgentSessionStateRegistry } from "../config/agent-session-state";
import { createClientSessionStateStore } from "../config/client-session-state";
import { getTypedAgentModule } from "../modules/agent";
import { getTypedClientModule } from "../modules/client";
import { Scheduler } from "../modules/schedule/scheduler";
import { getTranslatorForCommon } from "../i18n";

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

  // The scheduler and the core reference each other through injected
  // callbacks, so the scheduler is declared first and assigned once both
  // sides exist: the core diverts `schedule:*` agent output to the scheduler
  // (spec D2), the scheduler dispatches synthetic fires into the core's input
  // path and delivers egress to the client adapter (spec D1/D9). The adapter
  // gets `onScheduleRun` before either exists; by the time it can fire
  // (after start), the scheduler is assigned.
  let scheduler: Scheduler;

  const imAdapter = clientModule.createClientAdapter({
    config: channelConfig.client.config,
    common,
    sessionState: clientSessionStateStore,
    // Manual trigger bridge (spec D7a): adapters handle `/schedule-run`
    // locally and hand the task name over; the trigger chat id is not needed
    // by the scheduler (the result always goes to the task's own `target`).
    onScheduleRun: (taskName) => scheduler.runNow(taskName),
    // Target-binding bridge (spec D7): adapters handle `/schedule-here` sent
    // in the destination chat locally and hand over the task name plus this
    // chat's clientSessionId; the scheduler writes them into the task file.
    onScheduleHere: (taskName, clientSessionId) => scheduler.claimTarget(taskName, clientSessionId),
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
    // Divert `schedule:*` agent output to the scheduler instead of the IM
    // adapter (spec D2): the scheduler owns run attribution and delivers the
    // result/failure to the task's `target` chat.
    onScheduleOutput: (event) => scheduler.handleOutput(event),
  });

  scheduler = new Scheduler({
    channelName,
    dispatchClientEvent: (event) => core.input(event),
    deliver: (event) => imAdapter.input(event),
    validateTarget: clientModule.validateSessionId,
    t: getTranslatorForCommon(common),
  });

  await core.start();
  await scheduler.start();
  logger.info(`channel ${channelName} started`);
  logger.info("press Ctrl+C to stop");

  return {
    async stop() {
      await scheduler.stop();
      await core.stop();
      logger.info(`channel ${channelName} stopped`);
    },
  };
}
