import type { Translator } from "../../../i18n";
import type {
  ClientOutputEvent,
  ClientSessionStateApi,
  ClientWorkingDirectorySource,
} from "../../../types";
import type { ImClientSessionStateV1 } from "./client-session-state";
import { validateWorkingDirectory } from "./working-directory";

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

function parseModelCommand(text: string, clientSessionId: string): ParsedSlashCommand | null {
  const match = text.match(/^\/(model|m)(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }

  const target = match[2]?.trim();
  if (!target) {
    return { type: "command.session.model.list", clientSessionId };
  }

  return {
    type: "command.session.model.set",
    clientSessionId,
    target,
  };
}

function parseNewCommand(text: string, clientSessionId: string): ParsedSlashCommand | null {
  const match = text.match(/^\/(new|n)(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }

  const workingDirectory = match[2]?.trim();
  if (!workingDirectory) {
    return { type: "command.session.new", clientSessionId };
  }

  return {
    type: "command.session.new",
    clientSessionId,
    workingDirectory,
  };
}

/**
 * Result of syntactic slash-command parsing. Identical to
 * {@link ClientOutputEvent} except that a parsed `command.session.new` still
 * has an optional, unresolved `workingDirectory` (exactly what the user
 * typed). Use {@link resolveSlashCommandEvent} to turn it into the final
 * event whose working directory is always concrete.
 */
export type ParsedSlashCommand =
  | {
      type: "command.session.new";
      clientSessionId: string;
      workingDirectory?: string;
    }
  | Exclude<ClientOutputEvent, { type: "command.session.new" }>;

/**
 * Parses a trimmed inbound text as one of the standard agent-bridge slash
 * commands (`/new [path]`, `/n [path]`, `/compact`, `/c`, `/stop`, `/s`, `/status`, `/st`, `/model`, `/m`) and returns the
 * corresponding {@link ParsedSlashCommand}, or `null` if `text` is not a recognized
 * command and should be treated as a regular user message.
 */
export function parseSlashCommand(text: string, clientSessionId: string): ParsedSlashCommand | null {
  const newCommand = parseNewCommand(text, clientSessionId);
  if (newCommand) {
    return newCommand;
  }

  const modelCommand = parseModelCommand(text, clientSessionId);
  if (modelCommand) {
    return modelCommand;
  }

  switch (text.toLowerCase()) {
    case "/compact":
    case "/c":
      return { type: "command.session.compact", clientSessionId };
    case "/stop":
    case "/s":
      return { type: "command.session.stop", clientSessionId };
    case "/status":
    case "/st":
      return { type: "command.session.status", clientSessionId };
    default:
      return null;
  }
}

export interface ResolveSlashCommandEventDeps {
  /** Session-scoped handle for the chat the command came from. */
  sessionState: ClientSessionStateApi<ImClientSessionStateV1>;
  /** Fallback directory when nothing is remembered; defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Reports client-session store failures. The memory feature is best-effort:
   * a store failure must never block or break the `/new` command itself.
   */
  onError?: (error: unknown) => void;
}

/**
 * Local reply produced when a `/new` working directory fails the client-side
 * validation. No event is emitted to the core in this case and nothing is
 * remembered; the client adapter renders this as a localized error message.
 */
export interface InvalidWorkingDirectoryReply {
  type: "invalid-working-directory";
  /** The resolved (absolute) target that failed validation. */
  workingDirectory: string;
  /** User-facing failure reason (for example "no such file or directory"). */
  detail: string;
  /** True when the invalid path came from the chat's remembered default. */
  remembered: boolean;
}

export type ResolvedSlashCommand = ClientOutputEvent | InvalidWorkingDirectoryReply;

async function resolveNewCommandEvent(
  parsed: Extract<ParsedSlashCommand, { type: "command.session.new" }>,
  deps: ResolveSlashCommandEventDeps,
): Promise<ResolvedSlashCommand> {
  const build = (
    workingDirectory: string,
    workingDirectorySource: ClientWorkingDirectorySource,
  ): ClientOutputEvent => ({
    type: "command.session.new",
    clientSessionId: parsed.clientSessionId,
    workingDirectory,
    workingDirectorySource,
  });

  const explicit = parsed.workingDirectory?.trim();
  if (explicit) {
    // Validate before anything else: an invalid path is rejected locally, no
    // event is emitted, and it is never remembered as the chat's default.
    const validation = await validateWorkingDirectory(explicit, { cwd: deps.cwd });
    if (!validation.ok) {
      return {
        type: "invalid-working-directory",
        workingDirectory: validation.directory,
        detail: validation.detail,
        remembered: false,
      };
    }
    // Remember the canonical directory as this chat's default for later bare
    // `/new` commands. Canonical (absolute, realpath-resolved) so the memory
    // stays correct even if the bridge is later restarted from another cwd.
    try {
      await deps.sessionState.update(() => ({
        version: 1,
        defaultWorkingDirectory: validation.directory,
      }));
    } catch (error) {
      deps.onError?.(error);
    }
    return build(validation.directory, "user");
  }

  let remembered: string | undefined;
  try {
    remembered = (await deps.sessionState.read())?.defaultWorkingDirectory;
  } catch (error) {
    deps.onError?.(error);
  }
  if (remembered) {
    // The remembered default was originally user supplied and validated, but
    // it may have gone stale (deleted or unmounted since): re-validate before
    // use. A stale default is reported, never silently replaced by the cwd
    // fallback, and left stored so a transient filesystem issue does not
    // erase the user's choice.
    const validation = await validateWorkingDirectory(remembered, { cwd: deps.cwd });
    if (!validation.ok) {
      return {
        type: "invalid-working-directory",
        workingDirectory: validation.directory,
        detail: validation.detail,
        remembered: true,
      };
    }
    return build(validation.directory, "user");
  }

  // Nothing remembered: fall back to the bridge process cwd. This is a
  // trusted client-side fallback, never validated or allowlist-checked.
  return build(deps.cwd ?? process.cwd(), "default");
}

/**
 * Turns a parsed slash command into the final {@link ClientOutputEvent}. For
 * `command.session.new` this validates and resolves the always-present
 * working directory (explicit argument, remembered chat default, or the
 * process cwd fallback) and its trust classification; an invalid directory
 * yields an {@link InvalidWorkingDirectoryReply} instead of an event. Every
 * other command passes through unchanged.
 */
export async function resolveSlashCommandEvent(
  parsed: ParsedSlashCommand,
  deps: ResolveSlashCommandEventDeps,
): Promise<ResolvedSlashCommand> {
  if (parsed.type !== "command.session.new") {
    return parsed;
  }
  return resolveNewCommandEvent(parsed, deps);
}
