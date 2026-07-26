import type { ClientInputEvent } from "../../../types";

export type TerminalAgentErrorEvent = Extract<ClientInputEvent, { type: "error" }>;

export function isTerminalAgentError(event: ClientInputEvent): event is TerminalAgentErrorEvent {
  return event.type === "error" && event.kind === "agent.run.failed";
}

/** Successful responses to local slash commands have no accompanying assistant message. */
export function isCompletedCommandResponse(event: ClientInputEvent): boolean {
  return event.type === "agent.status.info" || event.type === "agent.model.list" || event.type === "agent.model.updated";
}
