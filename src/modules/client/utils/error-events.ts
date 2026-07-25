import type { ClientInputEvent } from "../../../types";

export type TerminalAgentErrorEvent = Extract<ClientInputEvent, { type: "error" }>;

export function isTerminalAgentError(event: ClientInputEvent): event is TerminalAgentErrorEvent {
  return event.type === "error" && event.kind === "agent.run.failed";
}
