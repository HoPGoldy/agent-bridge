import type { Translator } from "../../../i18n";
import type { ClientOutputEvent } from "../../../types";

function isHelpCommand(text: string): boolean {
  switch (text.toLowerCase()) {
    case "/help":
    case "/h":
      return true;
    default:
      return false;
  }
}

/**
 * Resolves a trimmed inbound text as the local help command (`/help`, `/h`) and
 * returns a localized help markdown string, or `null` if `text` is not a help
 * command and should continue through the normal command/message flow.
 */
export function resolveHelpMarkdown(text: string, t: Translator): string | null {
  return isHelpCommand(text) ? t("client.helpMessage") : null;
}

/**
 * Parses a trimmed inbound text as one of the standard agent-bridge slash
 * commands (`/new`, `/n`, `/compact`, `/c`, `/stop`, `/s`) and returns the
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
    case "/s":
      return { type: "command.session.stop", clientSessionId };
    default:
      return null;
  }
}
