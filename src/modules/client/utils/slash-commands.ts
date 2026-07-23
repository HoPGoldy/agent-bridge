import type { ClientOutputEvent } from "../../../types";

/**
 * Parses a trimmed inbound text as one of the standard agent-bridge slash
 * commands (`/new`, `/compact`, `/stop`) and returns the corresponding
 * `ClientOutputEvent`, or `null` if `text` is not a recognized command and
 * should be treated as a regular user message.
 */
export function parseSlashCommand(text: string, clientSessionId: string): ClientOutputEvent | null {
  switch (text) {
    case "/new":
      return { type: "command.session.new", clientSessionId };
    case "/compact":
      return { type: "command.session.compact", clientSessionId };
    case "/stop":
      return { type: "command.session.stop", clientSessionId };
    default:
      return null;
  }
}
