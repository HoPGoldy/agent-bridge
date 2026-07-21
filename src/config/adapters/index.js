import { feishuConfigAdapter } from './feishu.js';

const registry = new Map([
  [feishuConfigAdapter.type, feishuConfigAdapter],
]);

export function listConfigAdapters() {
  return [...registry.values()];
}

export function getConfigAdapter(type) {
  return registry.get(type);
}
