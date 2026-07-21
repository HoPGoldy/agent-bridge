import type { ChannelConfig, ConfigAdapter } from "../../types";
import { feishuConfigAdapter } from "./feishu";

const registry = new Map<string, ConfigAdapter<ChannelConfig>>([
  [feishuConfigAdapter.type, feishuConfigAdapter],
]);

export function listConfigAdapters(): ConfigAdapter<ChannelConfig>[] {
  return [...registry.values()];
}

export function getConfigAdapter(type: string): ConfigAdapter<ChannelConfig> | undefined {
  return registry.get(type);
}
