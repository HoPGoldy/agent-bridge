import type { Translator } from "../../../i18n";
import type {
  ClientOutputEvent,
  ClientSessionStateApi,
  ClientWorkingDirectorySource,
  ScheduleHereResult,
  ScheduleRunResult,
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
 * Adapter-local `/schedule-run <task-name>` command (spec D7a): the adapter
 * triggers the named task through the injected `onScheduleRun` bridge and
 * replies with a localized result. Never reaches the core.
 */
export interface ScheduleRunCommand {
  type: "schedule.run";
  clientSessionId: string;
  taskName: string;
}

/**
 * Adapter-local usage error for a malformed `/schedule-run` (spec D7a): the
 * task name is missing or does not match `[a-z0-9-]+`. The adapter replies
 * with a localized usage hint; nothing reaches the core.
 */
export interface ScheduleRunUsageCommand {
  type: "schedule.run.usage";
  clientSessionId: string;
}

/** Task names are lowercased slugs matching the task file names (spec D3). */
const TASK_NAME_RE = /^[a-z0-9-]+$/i;

function parseScheduleRunCommand(
  text: string,
  clientSessionId: string,
): ScheduleRunCommand | ScheduleRunUsageCommand | null {
  const match = text.match(/^\/schedule-run(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }

  const raw = match[1]?.trim() ?? "";
  if (!TASK_NAME_RE.test(raw)) {
    return { type: "schedule.run.usage", clientSessionId };
  }

  // Task files are lowercased slugs; normalize so `/schedule-run DailyReport`
  // triggers the `dailyreport` task.
  return { type: "schedule.run", clientSessionId, taskName: raw.toLowerCase() };
}

/**
 * Adapter-local `/schedule-here <task-name>` command (spec D7): the adapter
 * binds this chat as the task's delivery target through the injected
 * `onScheduleHere` bridge and replies with a localized result. This chat's
 * `clientSessionId` is written into the task file's `target` line — a
 * one-line shortcut for the manual `/st` copy-paste. Never reaches the core.
 */
export interface ScheduleHereCommand {
  type: "schedule.here";
  clientSessionId: string;
  taskName: string;
}

/**
 * Adapter-local usage error for a malformed `/schedule-here` (spec D7): the
 * task name is missing or does not match `[a-z0-9-]+`. The adapter replies
 * with a localized usage hint; nothing reaches the core.
 */
export interface ScheduleHereUsageCommand {
  type: "schedule.here.usage";
  clientSessionId: string;
}

function parseScheduleHereCommand(
  text: string,
  clientSessionId: string,
): ScheduleHereCommand | ScheduleHereUsageCommand | null {
  const match = text.match(/^\/schedule-here(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }

  const raw = match[1]?.trim() ?? "";
  if (!TASK_NAME_RE.test(raw)) {
    return { type: "schedule.here.usage", clientSessionId };
  }

  // Task files are lowercased slugs; normalize so `/schedule-here DailyReport`
  // binds the `dailyreport` task.
  return { type: "schedule.here", clientSessionId, taskName: raw.toLowerCase() };
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
 * commands (`/new [path]`, `/n [path]`, `/compact`, `/c`, `/stop`, `/s`, `/status`, `/st`, `/model`, `/m`, `/schedule-run <name>`, `/schedule-here <name>`) and returns the
 * corresponding {@link ParsedSlashCommand} (or an adapter-local
 * {@link ScheduleRunCommand}/{@link ScheduleRunUsageCommand}/
 * {@link ScheduleHereCommand}/{@link ScheduleHereUsageCommand}), or `null` if
 * `text` is not a recognized command and should be treated as a regular user
 * message.
 */
export function parseSlashCommand(
  text: string,
  clientSessionId: string,
):
  | ParsedSlashCommand
  | ScheduleRunCommand
  | ScheduleRunUsageCommand
  | ScheduleHereCommand
  | ScheduleHereUsageCommand
  | null {
  // `/schedule-run` and `/schedule-here` are handled entirely by the adapter
  // (spec D7a/D7): they never go through `resolveSlashCommandEvent` nor reach
  // the core.
  const scheduleRunCommand = parseScheduleRunCommand(text, clientSessionId);
  if (scheduleRunCommand) {
    return scheduleRunCommand;
  }

  const scheduleHereCommand = parseScheduleHereCommand(text, clientSessionId);
  if (scheduleHereCommand) {
    return scheduleHereCommand;
  }

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
 * Localized reply text for a `/schedule-run` outcome (spec D7a). Maps the
 * scheduler's caller-facing English reasons (see the `runNow`/`fire` path in
 * the scheduler) to localized messages; unrecognized reasons fall back to a
 * generic failure message carrying the raw reason.
 */
export function formatScheduleRunReply(
  result: ScheduleRunResult,
  taskName: string,
  t: Translator,
): string {
  if (result.ok) {
    return t("client.scheduleRunTriggered", { name: taskName });
  }

  switch (result.reason) {
    case "task not found":
      return t("client.scheduleRunTaskNotFound", { name: taskName });
    case "task is disabled":
      return t("client.scheduleRunTaskDisabled", { name: taskName });
    case "task has no valid target":
      return t("client.scheduleRunNoTarget", { name: taskName });
    default:
      // T2 ownership rejection: `task belongs to channel "X"` (dynamic name).
      // Prefix-match and extract the channel name; fall back to carrying the
      // raw reason when it cannot be extracted.
      if (result.reason.startsWith("task belongs to channel ")) {
        const channelMatch = /^task belongs to channel "([^"]+)"$/.exec(result.reason);
        return t("client.scheduleRunWrongChannel", {
          name: taskName,
          channel: channelMatch?.[1] ?? result.reason,
        });
      }
      return t("client.scheduleRunFailed", { name: taskName, reason: result.reason });
  }
}

/**
 * Localized reply text for a `/schedule-here` outcome (spec D7). Maps the
 * scheduler's caller-facing English reasons (see the `claimTarget`/`setTask-
 * Target` path) to localized messages; unrecognized reasons fall back to a
 * generic failure message carrying the raw reason.
 */
export function formatScheduleHereReply(
  result: ScheduleHereResult,
  taskName: string,
  t: Translator,
): string {
  if (result.ok) {
    return t("client.scheduleHereBound", { name: taskName });
  }

  switch (result.reason) {
    case "task not found":
      return t("client.scheduleHereTaskNotFound", { name: taskName });
    case "task already bound":
      return t("client.scheduleHereAlreadyBound", { name: taskName });
    default:
      return t("client.scheduleHereFailed", { name: taskName, reason: result.reason });
  }
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
