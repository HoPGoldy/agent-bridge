import { realpath } from "node:fs/promises";
import type {
  AgentAdapter,
  AgentAvailableModel,
  AgentInputEvent,
  AgentOutputEvent,
  AgentSessionStatus,
  AgentSessionStateApi,
  NewAgentSessionStateApi,
  OutboundAttachment,
} from "../../../../types";
import { createLogger, type Logger } from "../../../../core/logger";
import { extractMediaMarkers } from "../../media-convention";
import { PiRpcClient } from "./pi-rpc-client";
import { toPiSessionId } from "./pi-session-id";
import { resolveWorkingDirectory } from "../working-directory";
import type { PiCodingAgentSessionStateV1 } from "../index";

class PiModelCommandError extends Error {
  readonly kind: "agent.model.invalid" | "agent.model.busy" | "agent.model.set.unavailable";

  constructor(kind: "agent.model.invalid" | "agent.model.busy" | "agent.model.set.unavailable", message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface PiCodingAgentAdapterOptions {
  agentSessionId: string;
  /**
   * Lifecycle phase. `create` initializes the reserved handle with the
   * resolved working directory; `resume` reads, re-validates and rewrites the
   * opened handle. The module passes the phase and the matching handle kind.
   */
  mode: "create" | "resume";
  /** Session-scoped state handle injected by the gateway (reserved in create, opened in resume). */
  sessionState:
    | NewAgentSessionStateApi<PiCodingAgentSessionStateV1>
    | AgentSessionStateApi<PiCodingAgentSessionStateV1>;
  /**
   * Raw user-requested working directory for a brand-new session. Absent (or
   * empty) only for implicitly created sessions (first user message): a `/new`
   * command always carries a concrete directory resolved by the client side.
   */
  workingDirectory?: string;
  /**
   * Trust classification of `workingDirectory` as decided by the client
   * adapter. When absent it is derived from whether a directory was supplied
   * (legacy behavior for direct constructor callers).
   */
  workingDirectorySource?: "user" | "default";
  /**
   * Optional allowlist of allowed working-directory roots. Enforced for
   * user-supplied directories only (`workingDirectorySource === "user"`); a
   * bare `/new` default is never checked.
   */
  allowedWorkingDirectoryRoots?: string[];
  sessionDir?: string;
  bin?: string;
  model?: string;
  extraArgs?: string[];
  logger?: Logger;
}

export class PiCodingAgentAdapter implements AgentAdapter {
  readonly #agentSessionId: string;
  readonly #piSessionId: string;
  readonly #handle:
    | { mode: "create"; sessionState: NewAgentSessionStateApi<PiCodingAgentSessionStateV1> }
    | { mode: "resume"; sessionState: AgentSessionStateApi<PiCodingAgentSessionStateV1> };
  readonly #sessionDir?: string;
  readonly #bin: string;
  readonly #model?: string;
  readonly #extraArgs: string[];
  readonly #workingDirectory?: string;
  readonly #workingDirectorySource?: "user" | "default";
  readonly #allowedWorkingDirectoryRoots?: string[];
  readonly #logger: Logger;
  #client: PiRpcClient | null = null;
  #onOutput: ((event: AgentOutputEvent) => Promise<void> | void) | null = null;
  #activeRun = false;
  #toolLabelByCallId = new Map<string, string>();
  #toolInputByCallId = new Map<string, unknown>();

  constructor(options: PiCodingAgentAdapterOptions) {
    this.#agentSessionId = options.agentSessionId;
    this.#piSessionId = toPiSessionId(options.agentSessionId);
    // The module guarantees the pairing: a reserved handle in create mode, an
    // opened handle in resume mode. The branch narrows the union for the rest
    // of the class while keeping the handle truly scoped.
    this.#handle =
      options.mode === "create"
        ? {
            mode: "create",
            sessionState: options.sessionState as NewAgentSessionStateApi<PiCodingAgentSessionStateV1>,
          }
        : {
            mode: "resume",
            sessionState: options.sessionState as AgentSessionStateApi<PiCodingAgentSessionStateV1>,
          };
    this.#workingDirectory = options.workingDirectory;
    this.#workingDirectorySource = options.workingDirectorySource;
    this.#allowedWorkingDirectoryRoots = options.allowedWorkingDirectoryRoots;
    this.#sessionDir = options.sessionDir;
    this.#bin = options.bin ?? "pi";
    this.#model = options.model;
    this.#extraArgs = options.extraArgs ?? [];
    this.#logger = options.logger ?? createLogger("pi-coding-agent");
  }

  async start(onOutput: (event: AgentOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;

    // Resolve and persist the session working directory before anything can
    // spawn: creation failures (missing/invalid/unallowed path, revoke) must
    // never reach the process spawn step.
    const cwd = await this.#prepareWorkingDirectory();

    this.#client = new PiRpcClient({
      agentSessionId: this.#agentSessionId,
      piSessionId: this.#piSessionId,
      cwd,
      sessionDir: this.#sessionDir,
      bin: this.#bin,
      model: this.#model,
      extraArgs: this.#extraArgs,
      logger: this.#logger,
    });
    this.#client.onEvent((rpcEvent) => {
      void this.#handleRpcEvent(rpcEvent);
      if (rpcEvent.type === "extension_error") {
        this.#logger.error(`extension_error for ${this.#agentSessionId}:`, rpcEvent);
      }
    });
    this.#logger.info(`starting agent instance (bin=${this.#bin} cwd=${cwd})`);
    await this.#client.start();
    this.#logger.info(`session ${this.#agentSessionId} started (piSessionId=${this.#piSessionId})`);
  }

  /**
   * Resolves the canonical working directory and persists the session state
   * before the Pi process is spawned.
   *
   * Create mode: canonicalizes the requested path (or the default cwd for a
   * bare `/new`), enforces the user-path allowlist, then initializes the
   * persisted record with the canonical directory and its source.
   *
   * Resume mode: reads the persisted directory, re-validates it (the user-path
   * allowlist is enforced only for user-supplied directories), and rewrites
   * legacy binding-migrated records or drifted canonical paths into the
   * canonical V1 shape.
   */
  async #prepareWorkingDirectory(): Promise<string> {
    if (this.#handle.mode === "create") {
      const { sessionState } = this.#handle;
      const requested = this.#workingDirectory;
      const source: "user" | "default" =
        this.#workingDirectorySource ??
        (requested !== undefined && requested.trim() !== "" ? "user" : "default");

      if (source === "user") {
        if (requested === undefined || requested.trim() === "") {
          throw new Error('working directory source "user" requires a non-empty workingDirectory');
        }
        // resolveWorkingDirectory already canonicalizes with realpath and
        // enforces the allowlist on that canonical result. Re-resolving the
        // returned path would reopen a TOCTOU window: a swapped symlink could
        // yield a different, un-checked path that gets persisted and spawned.
        // Persist and spawn the checked result directly.
        const canonical = await resolveWorkingDirectory(requested, {
          allowedWorkingDirectoryRoots: this.#allowedWorkingDirectoryRoots,
        });
        await sessionState.initialize({
          version: 1,
          workingDirectory: canonical,
          workingDirectorySource: "user",
        });
        return canonical;
      }

      // Default directory: either the client-side fallback path (trusted, so
      // never allowlist-checked) or the process cwd for implicitly created
      // sessions. The helper already canonicalizes a supplied path with
      // realpath; the extra realpath keeps the bare-cwd result stable across
      // restarts even when the process cwd is a symlinked path.
      const resolved = await resolveWorkingDirectory(requested, {});
      const canonical = await realpath(resolved);
      await sessionState.initialize({
        version: 1,
        workingDirectory: canonical,
        workingDirectorySource: "default",
      });
      return canonical;
    }

    const { sessionState } = this.#handle;
    const state = await sessionState.read();
    const roots =
      state.workingDirectorySource === "user" ? this.#allowedWorkingDirectoryRoots : undefined;
    const canonical = await resolveWorkingDirectory(state.workingDirectory, {
      allowedWorkingDirectoryRoots: roots,
    });
    if (state.migratedFromBinding || state.workingDirectory !== canonical) {
      await sessionState.update((current) => ({
        version: 1,
        workingDirectory: canonical,
        workingDirectorySource: current.workingDirectorySource,
      }));
    }
    return canonical;
  }

  async stop(): Promise<void> {
    this.#toolLabelByCallId.clear();
    this.#toolInputByCallId.clear();
    await this.#client?.stop();
    this.#client = null;
    this.#activeRun = false;
    this.#onOutput = null;
    this.#logger.info(`session ${this.#agentSessionId} stopped`);
  }

  async abort(): Promise<void> {
    this.#logger.info(`aborting agent turn (session=${this.#agentSessionId})`);
    await this.#client?.abort();
  }

  async input(event: AgentInputEvent): Promise<void> {
    if (!this.#client || !this.#onOutput) {
      throw new Error("PiCodingAgentAdapter is not started");
    }

    await this.#processEvent(event);
  }

  async isBusy(): Promise<boolean> {
    return this.#activeRun;
  }

  async getStatus(): Promise<AgentSessionStatus> {
    if (!this.#client) {
      throw new Error("PiCodingAgentAdapter is not started");
    }

    const [state, stats] = await Promise.all([this.#client.getState(), this.#client.getSessionStats()]);
    const contextUsage = stats.contextUsage;

    return {
      sessionId: state.sessionId ?? this.#agentSessionId,
      provider: state.model?.provider,
      modelId: state.model?.id,
      thinkingLevel: state.thinkingLevel,
      context: contextUsage
        ? {
            tokens: contextUsage.tokens ?? null,
            contextWindow: contextUsage.contextWindow ?? null,
            percent: contextUsage.percent ?? null,
          }
        : undefined,
    };
  }

  async getAvailableModels(): Promise<AgentAvailableModel[]> {
    if (!this.#client) {
      throw new Error("PiCodingAgentAdapter is not started");
    }

    const [state, models] = await Promise.all([this.#client.getState(), this.#client.getAvailableModels()]);
    return models
      .filter((model): model is { provider: string; id: string } => typeof model.provider === "string" && typeof model.id === "string")
      .map((model) => ({
        provider: model.provider,
        modelId: model.id,
        isCurrent: state.model?.provider === model.provider && state.model?.id === model.id,
      }));
  }

  async setModel(target: string): Promise<{ provider: string; modelId: string }> {
    if (!this.#client) {
      throw new PiModelCommandError("agent.model.set.unavailable", "PiCodingAgentAdapter is not started");
    }

    const parsed = this.#parseModelTarget(target);
    const state = await this.#client.getState();
    if (state.isStreaming || state.isCompacting) {
      throw new PiModelCommandError("agent.model.busy", "Current session is busy, so the model cannot be switched. Please use /stop first.");
    }

    try {
      const result = await this.#client.setModel(parsed.provider, parsed.modelId);
      return {
        provider: result.provider ?? parsed.provider,
        modelId: result.id ?? parsed.modelId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Model not found:/i.test(message)) {
        throw new PiModelCommandError("agent.model.invalid", message);
      }
      throw new PiModelCommandError("agent.model.set.unavailable", message);
    }
  }

  #parseModelTarget(target: string): { provider: string; modelId: string } {
    const trimmed = target.trim();
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
      throw new PiModelCommandError("agent.model.invalid", `Invalid model target: ${target}`);
    }

    const provider = trimmed.slice(0, slashIndex).trim();
    const modelId = trimmed.slice(slashIndex + 1).trim();
    if (!provider || !modelId) {
      throw new PiModelCommandError("agent.model.invalid", `Invalid model target: ${target}`);
    }

    return { provider, modelId };
  }

  async #processEvent(event: AgentInputEvent): Promise<void> {
    if (!this.#client) {
      throw new Error("PiCodingAgentAdapter is not started");
    }

    try {
      if (event.type === "user.message") {
        this.#logger.info(`sending prompt to agent (session=${this.#agentSessionId})`);
        await this.#emitProgress({
          type: "assistant.thinking",
          agentSessionId: this.#agentSessionId,
          text: "Processing request",
        });
        // Let Pi atomically decide whether this starts a new run or steers the
        // current one. This avoids duplicating Pi's message queue in the adapter.
        const wasActive = this.#activeRun;
        this.#activeRun = true;
        try {
          await this.#client.prompt(event.text, "steer");
        } catch (error) {
          this.#activeRun = wasActive;
          throw error;
        }
        return;
      }

      this.#logger.info(`compacting context (session=${this.#agentSessionId})`);
      await this.#emitProgress({
        type: "session.compacting",
        agentSessionId: this.#agentSessionId,
        text: "Compacting context",
      });
      const result = await this.#client.compact();
      this.#logger.debug(
        `compact finished (session=${this.#agentSessionId} estimatedTokensAfter=${result.estimatedTokensAfter ?? "unknown"})`,
      );
      const suffix =
        typeof result.estimatedTokensAfter === "number"
          ? ` Estimated tokens after: ${result.estimatedTokensAfter}.`
          : "";
      await this.#emitAssistant(`Context compacted.${suffix}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.error(
        `event processing failed (session=${this.#agentSessionId} type=${event.type}):`,
        error,
      );
      await this.#emitAssistant(`[pi-coding-agent error] ${message}`);
    }
  }

  async #emitAssistant(text: string, attachments?: OutboundAttachment[]): Promise<void> {
    if (!this.#onOutput) {
      this.#logger.error(`dropped assistant output for stopped session ${this.#agentSessionId}`);
      return;
    }

    await this.#onOutput({
      type: "assistant.message",
      agentSessionId: this.#agentSessionId,
      text,
      attachments,
    });
  }

  async #emitProgress(event: Exclude<AgentOutputEvent, { type: "assistant.message" }>): Promise<void> {
    if (!this.#onOutput) {
      return;
    }
    await this.#onOutput(event);
  }

  async #emitRunFailed(detail: string): Promise<void> {
    await this.#emitProgress({
      type: "error",
      agentSessionId: this.#agentSessionId,
      kind: "agent.run.failed",
      detail,
    });
  }

  async #handleRpcEvent(rpcEvent: { type: string; [key: string]: unknown }): Promise<void> {
    if (!this.#onOutput) {
      return;
    }

    if (rpcEvent.type === "agent_start") {
      this.#activeRun = true;
      return;
    }

    if (rpcEvent.type === "agent_settled") {
      this.#activeRun = false;
      this.#toolLabelByCallId.clear();
      this.#toolInputByCallId.clear();
      return;
    }

    if (rpcEvent.type === "message_end") {
      const message = rpcEvent.message;
      if (this.#isAssistantMessage(message)) {
        this.#logger.debug(`assistant message_end content shape (session=${this.#agentSessionId})`, {
          contentType: Array.isArray(message.content) ? "array" : typeof message.content,
          contentPreview: this.#summarizeContentShape(message.content),
        });

        if (message.stopReason === "error") {
          const detail =
            typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
              ? message.errorMessage.trim()
              : "The agent run failed without additional error details.";
          this.#logger.error(`agent run failed (session=${this.#agentSessionId})`, {
            errorMessage: detail,
            responseId: typeof message.responseId === "string" ? message.responseId : undefined,
            provider: typeof message.provider === "string" ? message.provider : undefined,
            model: typeof message.model === "string" ? message.model : undefined,
          });
          await this.#emitRunFailed(detail);
          return;
        }

        const rawText = this.#extractMessageText(message.content);
        const { text, attachments } = extractMediaMarkers(rawText);
        this.#logger.debug(
          `assistant message_end received (session=${this.#agentSessionId} textLength=${rawText.length} attachmentCount=${attachments.length})`,
        );
        if (!text.trim() && attachments.length === 0) {
          this.#logger.debug(
            `ignoring assistant message_end without visible content (session=${this.#agentSessionId})`,
          );
          return;
        }
        await this.#emitAssistant(text, attachments);
      }
      return;
    }

    if (rpcEvent.type === "tool_execution_start") {
      const toolName = typeof rpcEvent.toolName === "string" ? rpcEvent.toolName : "unknown";
      const toolCallId = typeof rpcEvent.toolCallId === "string" ? rpcEvent.toolCallId : undefined;
      const toolInput = "args" in rpcEvent ? rpcEvent.args : undefined;
      const toolLabel = this.#summarizeToolLabel(toolName, toolInput);
      if (toolCallId) {
        if (toolLabel) this.#toolLabelByCallId.set(toolCallId, toolLabel);
        if (toolInput !== undefined) this.#toolInputByCallId.set(toolCallId, toolInput);
      }
      await this.#emitProgress({
        type: "assistant.tool.running",
        agentSessionId: this.#agentSessionId,
        toolName,
        toolCallId,
        toolInput,
        toolLabel,
        text: undefined,
      });
      return;
    }

    if (rpcEvent.type === "tool_execution_update") {
      const toolName = typeof rpcEvent.toolName === "string" ? rpcEvent.toolName : "unknown";
      const toolCallId = typeof rpcEvent.toolCallId === "string" ? rpcEvent.toolCallId : undefined;
      const toolInput = "args" in rpcEvent ? rpcEvent.args : this.#toolInputForCall(toolCallId);
      const toolLabel = this.#toolLabelForCall(toolCallId, toolName, toolInput);
      if (toolCallId) {
        if (toolLabel) this.#toolLabelByCallId.set(toolCallId, toolLabel);
        if (toolInput !== undefined) this.#toolInputByCallId.set(toolCallId, toolInput);
      }
      await this.#emitProgress({
        type: "assistant.tool.update",
        agentSessionId: this.#agentSessionId,
        toolName,
        toolCallId,
        toolInput,
        toolLabel,
        partialResult: "partialResult" in rpcEvent ? rpcEvent.partialResult : undefined,
        text: undefined,
      });
      return;
    }

    if (rpcEvent.type === "tool_execution_end") {
      const toolName = typeof rpcEvent.toolName === "string" ? rpcEvent.toolName : "unknown";
      const toolCallId = typeof rpcEvent.toolCallId === "string" ? rpcEvent.toolCallId : undefined;
      const isError = Boolean(rpcEvent.isError);
      const toolInput = this.#toolInputForCall(toolCallId);
      const toolLabel = this.#toolLabelForCall(toolCallId, toolName, toolInput);
      await this.#emitProgress({
        type: isError ? "assistant.tool.error" : "assistant.tool.done",
        agentSessionId: this.#agentSessionId,
        toolName,
        toolCallId,
        toolInput,
        toolLabel,
        result: "result" in rpcEvent ? rpcEvent.result : undefined,
        text: undefined,
      });
      if (toolCallId) {
        this.#toolLabelByCallId.delete(toolCallId);
        this.#toolInputByCallId.delete(toolCallId);
      }
    }
  }

  #toolInputForCall(toolCallId: string | undefined): unknown {
    return toolCallId ? this.#toolInputByCallId.get(toolCallId) : undefined;
  }

  #toolLabelForCall(toolCallId: string | undefined, toolName: string, toolInput: unknown): string | undefined {
    return (toolCallId ? this.#toolLabelByCallId.get(toolCallId) : undefined) ?? this.#summarizeToolLabel(toolName, toolInput);
  }

  #summarizeToolLabel(toolName: string, toolInput: unknown): string | undefined {
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
      return undefined;
    }

    const input = toolInput as Record<string, unknown>;
    const stringField = (key: string): string | undefined => {
      const value = input[key];
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
    };
    const stringArrayField = (key: string): string[] | undefined => {
      const value = input[key];
      if (!Array.isArray(value)) return undefined;
      const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      return items.length > 0 ? items.map((item) => item.trim()) : undefined;
    };

    switch (toolName) {
      case "bash":
        return stringField("command");
      case "read":
      case "write":
      case "edit":
      case "find":
      case "ls":
        return stringField("path");
      case "grep": {
        const pattern = stringField("pattern");
        const path = stringField("path");
        if (pattern && path) return `${pattern} in ${path}`;
        return pattern ?? path;
      }
      case "web_search": {
        const query = stringField("query");
        const queries = stringArrayField("queries");
        return query ?? (queries ? queries.join(" | ") : undefined);
      }
      case "fetch_content": {
        const url = stringField("url");
        const urls = stringArrayField("urls");
        return url ?? (urls ? urls.join(" | ") : undefined);
      }
      default:
        return this.#truncate(this.#safeJson(toolInput), 120);
    }
  }

  #safeJson(value: unknown): string | undefined {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }

  #truncate(value: string | undefined, maxLength: number): string | undefined {
    if (!value) return undefined;
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
  }

  #isAssistantMessage(value: unknown): value is {
    role: "assistant";
    content?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    responseId?: unknown;
    provider?: unknown;
    model?: unknown;
  } {
    if (!value || typeof value !== "object") {
      return false;
    }

    return (value as { role?: unknown }).role === "assistant";
  }

  #extractMessageText(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }

    if (this.#isTextBlock(content)) {
      return content.text;
    }

    if (!Array.isArray(content)) {
      return "";
    }

    const textParts: string[] = [];
    for (const block of content) {
      if (this.#isTextBlock(block)) {
        textParts.push(block.text);
        continue;
      }

      if (!block || typeof block !== "object") {
        continue;
      }

      const candidate = block as { content?: unknown };
      if (typeof candidate.content === "string") {
        textParts.push(candidate.content);
      }
    }

    return textParts.join("");
  }

  #isTextBlock(value: unknown): value is { type: "text"; text: string } {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string";
  }

  #summarizeContentShape(content: unknown): unknown {
    if (typeof content === "string") {
      return { kind: "string", length: content.length, preview: content.slice(0, 200) };
    }

    if (!Array.isArray(content)) {
      return { kind: typeof content };
    }

    return content.slice(0, 10).map((block) => {
      if (!block || typeof block !== "object") {
        return { kind: typeof block };
      }

      const candidate = block as { type?: unknown; text?: unknown; content?: unknown; mimeType?: unknown };
      return {
        type: candidate.type,
        textLength: typeof candidate.text === "string" ? candidate.text.length : undefined,
        contentType: Array.isArray(candidate.content) ? "array" : typeof candidate.content,
        mimeType: candidate.mimeType,
      };
    });
  }
}
