import type { ClientConfig, ClientModule } from "../../types";
import { feishuClientModule } from "./feishu";
import { wecomClientModule } from "./wecom";
import { weixinClientModule } from "./weixin";

// Client-module contract surface (re-exported for adapter-side consumers; the
// `ClientModule` interface itself lives in `src/types.ts`). T7's
// `/schedule-run` and T10's `/schedule-here` read the `OnScheduleRun`/
// `OnScheduleHere` shapes from here.
//
// T5's `/queue-here` is deliberately NOT registered here: unlike
// `/schedule-here` it is not an adapter-local command with a bridge callback.
// The adapters do not parse it (an unrecognized slash command passes through
// as a plain `user.message`), and the core recognizes the raw text itself —
// see `GatewayCore#handleQueueHereCommand` — writing the binding with
// queue-file's `bindQueue`. No command shape needs surfacing here.
export type { OnScheduleHere, OnScheduleRun, ScheduleHereResult, ScheduleRunResult } from "../../types";

const registry = new Map<string, ClientModule<any, any>>([
  [feishuClientModule.type, feishuClientModule],
  [wecomClientModule.type, wecomClientModule],
  [weixinClientModule.type, weixinClientModule],
]);

export function listClientModules(): ClientModule<any, any>[] {
  return [...registry.values()];
}

export function getClientModule(type: string): ClientModule<any, any> | undefined {
  return registry.get(type);
}

export function getTypedClientModule(config: ClientConfig): ClientModule<any, any> {
  const module = registry.get(config.type);
  if (!module) {
    throw new Error(`Unsupported client module type: ${config.type}`);
  }
  return module;
}
