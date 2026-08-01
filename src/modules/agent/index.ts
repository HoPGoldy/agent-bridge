import type { AgentConfig, AgentModule } from "../../types";
import { openCodeAgentModule } from "./opencode";
import { piCodingAgentModule } from "./pi-coding-agent";

const registry = new Map<string, AgentModule<any>>([
  [piCodingAgentModule.type, piCodingAgentModule],
  [openCodeAgentModule.type, openCodeAgentModule],
]);

export function listAgentModules(): AgentModule<any>[] {
  return [...registry.values()];
}

export function getAgentModule(type: string): AgentModule<any> | undefined {
  return registry.get(type);
}

export function getTypedAgentModule(config: AgentConfig): AgentModule<any> {
  const module = registry.get(config.type);
  if (!module) {
    throw new Error(`Unsupported agent module type: ${config.type}`);
  }
  return module;
}
