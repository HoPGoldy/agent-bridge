import type { ClientConfig, ClientModule } from "../../types";
import { feishuClientModule } from "./feishu";
import { wecomClientModule } from "./wecom";
import { weixinClientModule } from "./weixin";

const registry = new Map<string, ClientModule<any>>([
  [feishuClientModule.type, feishuClientModule],
  [wecomClientModule.type, wecomClientModule],
  [weixinClientModule.type, weixinClientModule],
]);

export function listClientModules(): ClientModule<any>[] {
  return [...registry.values()];
}

export function getClientModule(type: string): ClientModule<any> | undefined {
  return registry.get(type);
}

export function getTypedClientModule(config: ClientConfig): ClientModule<any> {
  const module = registry.get(config.type);
  if (!module) {
    throw new Error(`Unsupported client module type: ${config.type}`);
  }
  return module;
}
