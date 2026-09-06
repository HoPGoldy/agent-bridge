import type { ClientConfig, ClientModule } from "../../types";
import { feishuClientModule } from "./feishu";
import { wecomClientModule } from "./wecom";
import { weixinClientModule } from "./weixin";

// Client-module contract surface (re-exported for adapter-side consumers; the
// `ClientModule` interface itself lives in `src/types.ts`). T7's
// `/schedule-run`, T10's `/schedule-here` and T05's `/queue-here` read the
// `OnScheduleRun`/`OnScheduleHere`/`OnQueueHere` shapes from here: all three
// are adapter-local commands — the adapters parse them and dispatch through
// the injected bridge callbacks; nothing of them reaches the core as raw
// text.
export type {
  OnQueueHere,
  OnScheduleHere,
  OnScheduleRun,
  QueueHereResult,
  ScheduleHereResult,
  ScheduleRunResult,
} from "../../types";

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
