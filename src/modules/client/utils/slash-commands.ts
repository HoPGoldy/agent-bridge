import type { ClientOutputEvent } from "../../../types";

/**
 * Parses a trimmed inbound text as one of the standard agent-bridge slash
 * commands (`/new`, `/n`, `/compact`, `/c`, `/stop`) and returns the
 * corresponding `ClientOutputEvent`, or `null` if `text` is not a recognized
 * command and should be treated as a regular user message.
 */
export function parseSlashCommand(text: string, clientSessionId: string): ClientOutputEvent | null {
  switch (text.toLowerCase()) {
    case "/new":
    case "/n":
      return { type: "command.session.new", clientSessionId };
    case "/compact":
    case "/c":
      return { type: "command.session.compact", clientSessionId };
    case "/stop":
      return { type: "command.session.stop", clientSessionId };
    default:
      return null;
  }
}
