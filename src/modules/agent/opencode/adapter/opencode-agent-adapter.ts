import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Event, FilePart, Message, Part, ToolPart } from "@opencode-ai/sdk/v2/types";
import { createLogger, type Logger } from "../../../../core/logger";
import { extractMediaMarkers, MEDIA_CONVENTION_PROMPT } from "../../media-convention";
import type {
  AgentAdapter,
  AgentAvailableModel,
  AgentInputEvent,
  AgentOutputEvent,
  AgentSessionStatus,
  AgentSessionStateApi,
  NewAgentSessionStateApi,
  OpenCodeAgentConfig,
  OutboundAttachment,
} from "../../../../types";
import { describeOpenCodeError, type OpenCodeApi, type OpenCodeMessage } from "./opencode-api";
import { OpenCodeRuntime, type OpenCodeRuntimeAdapter } from "./opencode-runtime";
import type { OpenCodeAgentSessionStateV1, OpenCodeWorkingDirectorySource } from "../index";

export function parseConfiguredModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error("OpenCode model must use provider/modelID format");
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/**
 * Lexical-only boundary check for a remote/container path override against the
 * configured allowed roots. The OpenCode Server may run on a different host or
 * inside a container, so no local filesystem access happens here: both sides
 * are normalized purely lexically with `path.resolve` and `path.relative`, and
 * final validation plus symlink resolution is the remote service's
 * responsibility (documented, not enforced locally).
 *
 * Equal paths and strict descendants of any root are allowed; sibling prefixes
 * (`/srv/work` vs `/srv/work2`) and any `..` escape are rejected, while literal
 * child names that merely start with two dots (`..foo`, `...`) stay allowed.
 *
 * When an allowlist is configured the override must be an absolute path: the
 * server may be remote, so a relative directory would be resolved against the
 * server's cwd rather than the bridge's, and the bridge cannot verify it. With
 * no allowlist configured, relative overrides are allowed and forwarded to the
 * server unchanged. The returned value is never used to rewrite the directory
 * sent to the server.
 */
export function assertAllowedWorkingDirectory(
  workingDirectory: string,
  allowedWorkingDirectoryRoots: string[] | undefined,
): void {
  const roots = (allowedWorkingDirectoryRoots ?? [])
    .map((root) => root.trim())
    .filter((root) => root.length > 0);
  if (roots.length === 0) return;

  const trimmed = workingDirectory.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error(
      `working directory "${trimmed}" must be an absolute path when allowed working directory roots are configured`,
    );
  }

  const target = path.resolve(trimmed);
  for (const rawRoot of roots) {
    const root = path.resolve(rawRoot);
    const rel = path.relative(root, target);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
      return;
    }
  }
  throw new Error(`working directory "${trimmed}" is not inside an allowed root`);
}

class OpenCodeModelCommandError extends Error {
  readonly kind: "agent.model.invalid" | "agent.model.busy" | "agent.model.set.unavailable";

  constructor(kind: OpenCodeModelCommandError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

type SelectedModel = { providerID: string; modelID: string };
type AgentOutputPayload = AgentOutputEvent extends infer T
  ? T extends { agentSessionId: string }
    ? Omit<T, "agentSessionId">
    : never
  : never;

type MessageBuffer = {
  parts: Map<string, string>;
  attachments: Map<string, OutboundAttachment>;
};

export interface OpenCodeAgentAdapterOptions {
  agentSessionId: string;
  /**
   * Lifecycle phase. `create` resolves the working-directory policy, creates
   * the OpenCode provider session and initializes the reserved state handle;
   * `resume` reads, re-validates and upgrades the opened handle. The module
   * passes the phase and the matching handle kind.
   */
  mode: "create" | "resume";
  /** Session-scoped state handle injected by the gateway (reserved in create, opened in resume). */
  sessionState:
    | NewAgentSessionStateApi<OpenCodeAgentSessionStateV1>
    | AgentSessionStateApi<OpenCodeAgentSessionStateV1>;
  /** Channel-level OpenCode configuration. Never mutated. */
  config: OpenCodeAgentConfig;
  /**
   * Optional per-task model override (design spec
   * `docs/scheduled-task-model-spec.md`): set only for scheduler task-run
   * sessions; chat-originated sessions never carry it. Resolved with
   * precedence override > channel `config.model`, applied on the create path
   * only (`#startCreate`) — resume never receives it (task sessions never
   * resume). The module already validated format and availability against the
   * effective model before constructing the adapter.
   */
  model?: string;
  /** Channel name; part of the directory-scoped runtime cache key. */
  channelName: string;
  /**
   * Raw working directory requested for a brand-new session. A `/new` command
   * always carries a concrete directory resolved by the client side; absent
   * (or empty) only for implicitly created sessions (first user message),
   * where the adapter falls back to the channel-configured directory, then
   * the actual process cwd.
   */
  workingDirectory?: string;
  /**
   * Trust classification of `workingDirectory` as decided by the client
   * adapter: `user` paths are allowlist-checked; `default` marks the
   * client-side cwd fallback, which is trusted — and the channel-configured
   * directory still takes precedence over it. When absent it is derived from
   * whether a directory was supplied (legacy behavior for direct constructor
   * callers).
   */
  workingDirectorySource?: "user" | "default";
  /**
   * Optional allowlist of allowed working-directory roots. Enforced for
   * user-supplied directories only (`user` source); a configured directory and
   * the bridge-default cwd are never checked.
   */
  allowedWorkingDirectoryRoots?: string[];
  /**
   * Returns the runtime bound to the (effective) directory of this session,
   * so sessions on the same server + directory share one SSE subscription.
   */
  getRuntime: (channelName: string, config: OpenCodeAgentConfig) => OpenCodeRuntime;
  logger?: Logger;
}

export class OpenCodeAgentAdapter implements AgentAdapter, OpenCodeRuntimeAdapter {
  readonly #agentSessionId: string;
  readonly #handle:
    | { mode: "create"; sessionState: NewAgentSessionStateApi<OpenCodeAgentSessionStateV1> }
    | { mode: "resume"; sessionState: AgentSessionStateApi<OpenCodeAgentSessionStateV1> };
  readonly #config: OpenCodeAgentConfig;
  readonly #modelOverride?: string;
  readonly #channelName: string;
  readonly #workingDirectory?: string;
  readonly #workingDirectorySource?: "user" | "default";
  readonly #allowedWorkingDirectoryRoots?: string[];
  readonly #getRuntime: (channelName: string, config: OpenCodeAgentConfig) => OpenCodeRuntime;
  readonly #logger: Logger;
  /** Directory-scoped runtime selected during start(); set before any API call. */
  #runtime: OpenCodeRuntime | null = null;
  /** Provider session id on the OpenCode Server; resolved during start(). */
  #openCodeSessionId: string | null = null;
  #onOutput: ((event: AgentOutputEvent) => Promise<void> | void) | null = null;
  #started = false;
  #busy = false;
  #statusKnown = false;
  #compacting = false;
  #compactWaiter?: {
    promise: Promise<boolean>;
    resolve(value: boolean): void;
  };
  #model?: SelectedModel;
  #assistantMessageIds = new Set<string>();
  #ignoredMessageIds = new Set<string>();
  #messages = new Map<string, MessageBuffer>();
  #toolStatuses = new Map<string, string>();
  #handledPermissionIds = new Set<string>();
  #handledQuestionIds = new Set<string>();
  #latestAssistantMessage?: Extract<Message, { role: "assistant" }>;

  constructor(options: OpenCodeAgentAdapterOptions) {
    this.#agentSessionId = options.agentSessionId;
    // The module guarantees the pairing: a reserved handle in create mode, an
    // opened handle in resume mode. The branch narrows the union for the rest
    // of the class while keeping the handle truly scoped.
    this.#handle =
      options.mode === "create"
        ? {
            mode: "create",
            sessionState: options.sessionState as NewAgentSessionStateApi<OpenCodeAgentSessionStateV1>,
          }
        : {
            mode: "resume",
            sessionState: options.sessionState as AgentSessionStateApi<OpenCodeAgentSessionStateV1>,
          };
    this.#config = options.config;
    this.#modelOverride = options.model;
    this.#channelName = options.channelName;
    this.#workingDirectory = options.workingDirectory;
    this.#workingDirectorySource = options.workingDirectorySource;
    this.#allowedWorkingDirectoryRoots = options.allowedWorkingDirectoryRoots;
    this.#getRuntime = options.getRuntime;
    this.#logger = options.logger ?? createLogger("opencode-agent");
  }

  /**
   * Provider session id on the OpenCode Server. Only available once start()
   * has resolved it (create) or read it back (resume); before that the getter
   * throws. The runtime is registered only after this is set, so the runtime
   * can never observe an adapter without a provider session id.
   */
  get openCodeSessionId(): string {
    if (this.#openCodeSessionId === null) {
      throw new Error(
        `OpenCodeAgentAdapter ${this.#agentSessionId} has no openCodeSessionId before start() completes`,
      );
    }
    return this.#openCodeSessionId;
  }

  /**
   * The directory-scoped API of the runtime selected during start(). Unset
   * before start() (or after a failed start), so no API call can ever be made
   * without a resolved provider session.
   */
  get #api(): OpenCodeApi {
    if (!this.#runtime) {
      throw new Error("OpenCodeAgentAdapter is not started");
    }
    return this.#runtime.api;
  }

  async start(onOutput: (event: AgentOutputEvent) => Promise<void> | void): Promise<void> {
    if (this.#started) return;
    this.#onOutput = onOutput;
    try {
      if (this.#handle.mode === "create") {
        await this.#startCreate();
      } else {
        await this.#startResume();
      }
      this.#started = true;
    } catch (error) {
      this.#onOutput = null;
      throw error;
    }
  }

  /**
   * Create lifecycle: resolve the working-directory policy, select the
   * directory-scoped runtime, create the OpenCode provider session, initialize
   * the persisted state record, then set the provider session/model and
   * register the runtime. Any failure before `register` leaves the runtime
   * unregistered and the reserved record uninitialized (the gateway deletes
   * it); a provider session created before a later failure cannot be deleted
   * through the OpenCode API (there is none) and is a documented residual
   * orphan on the server.
   */
  async #startCreate(): Promise<void> {
    if (this.#handle.mode !== "create") {
      throw new Error("OpenCodeAgentAdapter start in create mode requires a reserved state handle");
    }
    const { sessionState } = this.#handle;
    const { directory, source } = this.#resolveCreateDirectory();
    // The effective model is the per-task override when present, else the
    // channel config model — createSession, state init and
    // currentModelFromSessionData all observe the same effective value.
    const effective = {
      ...this.#config,
      directory,
      ...(this.#modelOverride !== undefined ? { model: this.#modelOverride } : {}),
    };
    const runtime = this.#getRuntime(this.#channelName, effective);
    this.#runtime = runtime;
    const session = await runtime.api.createSession({
      title: `agent-bridge:${this.#channelName}`,
      agent: effective.agent,
      model: parseConfiguredModel(effective.model),
    });
    // Residual risk (documented): from here on the provider session exists on
    // the server. If initialize fails there is no OpenCode API to delete it,
    // so the orphan session is never registered or resumed by the bridge.
    await sessionState.initialize({
      version: 1,
      openCodeSessionId: session.id,
      workingDirectory: directory,
      workingDirectorySource: source,
    });
    this.#openCodeSessionId = session.id;
    this.#model = currentModelFromSessionData(session, [], effective.model);
    await runtime.register(this);
  }

  /**
   * Resume lifecycle: read the persisted state (authoritative for the working
   * directory and its source), rebuild the runtime from the persisted
   * directory, fetch the provider session and messages, upgrade legacy state,
   * then register. The persisted working directory is never replaced by the
   * current channel config or process cwd; the user allowlist is the only
   * re-validation.
   */
  async #startResume(): Promise<void> {
    if (this.#handle.mode !== "resume") {
      throw new Error("OpenCodeAgentAdapter start in resume mode requires an opened state handle");
    }
    const { sessionState } = this.#handle;
    const state = await sessionState.read();
    if (state.workingDirectorySource === "user") {
      // Re-enforce the user-path allowlist against the persisted directory;
      // configured and bridge-default directories are never checked.
      assertAllowedWorkingDirectory(state.workingDirectory, this.#allowedWorkingDirectoryRoots);
    }
    const effective = { ...this.#config, directory: state.workingDirectory };
    const runtime = this.#getRuntime(this.#channelName, effective);
    this.#runtime = runtime;
    const [session, messages] = await Promise.all([
      runtime.api.getSession(state.openCodeSessionId),
      runtime.api.getMessages(state.openCodeSessionId, 50),
    ]);
    this.#openCodeSessionId = state.openCodeSessionId;
    this.#model = currentModelFromSessionData(session, messages, effective.model);
    if (state.migratedFromBinding) {
      // First successful resume rewrites a legacy binding-migrated record into
      // the canonical V1 form (encode strips the decode-only marker).
      await sessionState.update((current) => this.#canonicalizeLegacyState(current));
    }
    await runtime.register(this);
  }

  /**
   * Resolves the working-directory policy for a brand-new session. The server
   * may run remotely or inside a container, so only lexical rules apply here:
   * no local filesystem access, no realpath, and no shell/env/`~` expansion.
   * The returned directory is exactly what gets sent to the server and what is
   * persisted, so a restart from a different process cwd resumes the same
   * directory.
   *
   * - user: the trimmed raw override, enforced against the allowlist (absolute
   *   path + lexical boundary check) when one is configured.
   * - configured: the trimmed channel `config.directory` value, never checked
   *   against the user allowlist.
   * - bridge-default: the client-side cwd fallback (or the actual process cwd
   *   when the session was created implicitly), persisted so a restart from a
   *   different cwd still restores the same value. A `default`-sourced
   *   override lands here and is never allowlist-checked, and the configured
   *   directory still takes precedence over it.
   */
  #resolveCreateDirectory(): { directory: string; source: OpenCodeWorkingDirectorySource } {
    const trimmedOverride = this.#workingDirectory?.trim();
    const source = this.#workingDirectorySource ?? (trimmedOverride ? "user" : "default");
    if (source === "user" && !trimmedOverride) {
      // Matches the Pi adapter: a user-sourced directory must be explicit.
      // Unreachable through the client command flow (the client trims before
      // classifying); only direct constructor callers can hit this.
      throw new Error('working directory source "user" requires a non-empty workingDirectory');
    }
    if (trimmedOverride && source === "user") {
      assertAllowedWorkingDirectory(trimmedOverride, this.#allowedWorkingDirectoryRoots);
      return { directory: trimmedOverride, source: "user" };
    }
    const configured = this.#config.directory?.trim();
    if (configured) {
      return { directory: configured, source: "configured" };
    }
    return { directory: trimmedOverride ? trimmedOverride : process.cwd(), source: "bridge-default" };
  }

  /**
   * Upgrades a legacy binding-migrated state into the canonical V1 shape. The
   * codec already decoded the legacy record: a migrated working directory is
   * user-sourced, while a record without one was provisionally derived from
   * the current process cwd as bridge-default. When the channel config has a
   * directory, that configured value is preferred over the provisional cwd
   * guess (matching how the original session was created before the state
   * store existed). `encode()` strips the decode-only marker when persisting.
   */
  #canonicalizeLegacyState(
    current: Readonly<OpenCodeAgentSessionStateV1>,
  ): OpenCodeAgentSessionStateV1 {
    let { workingDirectory, workingDirectorySource } = current;
    if (workingDirectorySource === "bridge-default") {
      const configured = this.#config.directory?.trim();
      if (configured) {
        workingDirectory = configured;
        workingDirectorySource = "configured";
      }
    }
    return {
      version: 1,
      openCodeSessionId: current.openCodeSessionId,
      workingDirectory,
      workingDirectorySource,
    };
  }

  async stop(): Promise<void> {
    this.#settleCompact(false);
    if (this.#started && this.#runtime) {
      await this.#runtime.unregister(this);
    }
    this.#started = false;
    this.#busy = false;
    this.#statusKnown = false;
    this.#compacting = false;
    this.#onOutput = null;
    this.#clearTurnState();
  }

  async abort(): Promise<void> {
    this.#assertStarted();
    this.#settleCompact(false);
    try {
      await this.#api.abort(this.openCodeSessionId);
      await this.#refreshBusyStatus();
    } finally {
      this.#compacting = false;
      this.#clearTurnState();
    }
  }

  async input(event: AgentInputEvent): Promise<void> {
    this.#assertStarted();
    try {
      if (event.type === "user.message") {
        if (!this.#busy) this.#clearTurnState();
        this.#busy = true;
        this.#statusKnown = true;
        await this.#emit({ type: "assistant.thinking", text: "Processing request" });
        await this.#api.promptAsync(this.openCodeSessionId, {
          text: event.text,
          agent: this.#config.agent,
          model: this.#model,
          system: MEDIA_CONVENTION_PROMPT,
        });
        return;
      }

      const model = await this.#resolveCurrentModel();
      const compactCompletion = this.#beginCompact();
      this.#busy = true;
      this.#statusKnown = true;
      this.#compacting = true;
      await this.#emit({ type: "session.compacting", text: "Compacting context" });
      await this.#api.summarize(this.openCodeSessionId, model);
      if (await compactCompletion) await this.#emitAssistant("Context compacted.");
    } catch (error) {
      this.#settleCompact(false);
      this.#compacting = false;
      await this.#refreshBusyStatus().catch(() => {
        this.#busy = false;
        this.#statusKnown = false;
      });
      await this.#emitError("agent.run.failed", describeOpenCodeError(error, [this.#config.password]));
    }
  }

  async isBusy(): Promise<boolean> {
    if (!this.#statusKnown) await this.#refreshBusyStatus();
    return this.#busy || this.#compacting;
  }

  async getStatus(): Promise<AgentSessionStatus> {
    this.#assertStarted();
    const [statuses, messages, providers] = await Promise.all([
      this.#api.getSessionStatuses(),
      this.#api.getMessages(this.openCodeSessionId, 50),
      this.#api.getProviders(),
    ]);
    const latestUser = this.#latestMessage(messages, "user");
    const latestAssistant = this.#latestMessage(messages, "assistant") ?? this.#latestAssistantMessage;
    const model = this.#model ?? latestUser?.model;
    const provider = model ? providers.all.find((item) => item.id === model.providerID) : undefined;
    const providerModel = model ? provider?.models[model.modelID] : undefined;
    const tokens = latestAssistant ? this.#assistantTokens(latestAssistant) : null;
    const contextWindow = providerModel?.limit.context ?? null;

    const currentStatus = statuses[this.openCodeSessionId];
    if (currentStatus) {
      this.#busy = currentStatus.type === "busy" || currentStatus.type === "retry";
      this.#statusKnown = true;
    }

    return {
      sessionId: this.#agentSessionId,
      provider: model?.providerID,
      modelId: model?.modelID,
      context:
        tokens !== null || contextWindow !== null
          ? {
              tokens,
              contextWindow,
              percent:
                tokens !== null && contextWindow !== null && contextWindow > 0
                  ? Math.min(100, (tokens / contextWindow) * 100)
                  : null,
            }
          : undefined,
    };
  }

  async getAvailableModels(): Promise<AgentAvailableModel[]> {
    this.#assertStarted();
    const providers = await this.#api.getProviders();
    const connected = new Set(providers.connected);
    return providers.all
      .filter((provider) => connected.has(provider.id))
      .flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          provider: provider.id,
          modelId: model.id,
          isCurrent: this.#model?.providerID === provider.id && this.#model.modelID === model.id,
        })),
      );
  }

  async setModel(target: string): Promise<{ provider: string; modelId: string }> {
    this.#assertStarted();
    if (this.#busy || this.#compacting) {
      throw new OpenCodeModelCommandError("agent.model.busy", "Current OpenCode session is busy");
    }
    const parsed = this.#parseModelTarget(target);
    const providers = await this.#api.getProviders();
    const provider = providers.all.find((item) => item.id === parsed.providerID);
    if (!providers.connected.includes(parsed.providerID) || !provider?.models[parsed.modelID]) {
      throw new OpenCodeModelCommandError("agent.model.invalid", `OpenCode model is not available: ${target}`);
    }
    this.#model = parsed;
    return { provider: parsed.providerID, modelId: parsed.modelID };
  }

  async handleOpenCodeEvent(event: Event): Promise<void> {
    switch (event.type) {
      case "session.status":
        this.#busy = event.properties.status.type === "busy" || event.properties.status.type === "retry";
        this.#statusKnown = true;
        return;
      case "session.idle":
        this.#busy = false;
        this.#statusKnown = true;
        await this.#flushAssistantMessages();
        return;
      case "session.compacted":
        this.#busy = false;
        this.#statusKnown = true;
        this.#compacting = false;
        this.#settleCompact(true);
        return;
      case "session.error":
        this.#busy = false;
        this.#statusKnown = true;
        this.#compacting = false;
        this.#settleCompact(false);
        await this.#emitError("agent.run.failed", this.#errorDetail(event.properties.error));
        return;
      case "message.updated":
        await this.#handleMessageUpdated(event.properties.info);
        return;
      case "message.part.updated":
        await this.#handlePartUpdated(event.properties.part);
        return;
      case "permission.asked":
        await this.#handlePermission(event.properties.id);
        return;
      case "question.asked":
        await this.#handleQuestion(event.properties.id);
        return;
      default:
        return;
    }
  }

  async #handleMessageUpdated(message: Message): Promise<void> {
    if (message.role !== "assistant") return;
    if (message.summary) {
      this.#ignoredMessageIds.add(message.id);
      this.#assistantMessageIds.delete(message.id);
      this.#messages.delete(message.id);
      return;
    }
    this.#assistantMessageIds.add(message.id);
    this.#latestAssistantMessage = message;
    if (message.error) {
      await this.#emitError("agent.run.failed", this.#errorDetail(message.error));
    }
  }

  async #handlePartUpdated(part: Part): Promise<void> {
    if (this.#ignoredMessageIds.has(part.messageID)) return;
    const buffer = this.#messageBuffer(part.messageID);
    if (part.type === "text") {
      buffer.parts.set(part.id, part.text);
      return;
    }
    if (part.type === "reasoning") {
      await this.#emit({ type: "assistant.thinking", text: part.text });
      return;
    }
    if (part.type === "file") {
      const attachment = this.#toAttachment(part);
      if (attachment) buffer.attachments.set(attachment.filePath, attachment);
      return;
    }
    if (part.type === "tool") {
      await this.#handleToolPart(part, buffer);
    }
  }

  async #handleToolPart(part: ToolPart, buffer: MessageBuffer): Promise<void> {
    const previous = this.#toolStatuses.get(part.callID);
    const status = part.state.status;
    this.#toolStatuses.set(part.callID, status);
    const common = {
      toolName: part.tool,
      toolCallId: part.callID,
      toolInput: part.state.input,
      toolLabel: "title" in part.state ? part.state.title : undefined,
    };

    if (status === "pending" || status === "running") {
      await this.#emit(
        previous === undefined
          ? { type: "assistant.tool.running", ...common }
          : {
              type: "assistant.tool.update",
              ...common,
              partialResult: "metadata" in part.state ? part.state.metadata : undefined,
            },
      );
      return;
    }

    if (status === "completed") {
      if (previous === "completed") return;
      for (const file of part.state.attachments ?? []) {
        const attachment = this.#toAttachment(file);
        if (attachment) buffer.attachments.set(attachment.filePath, attachment);
      }
      await this.#emit({ type: "assistant.tool.done", ...common, result: part.state.output });
      return;
    }

    if (previous === "error") return;
    await this.#emit({ type: "assistant.tool.error", ...common, result: part.state.error });
  }

  #beginCompact(): Promise<boolean> {
    if (this.#compactWaiter) throw new Error("OpenCode session is already compacting");
    let resolve!: (value: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    this.#compactWaiter = { promise, resolve };
    return promise;
  }

  #settleCompact(value: boolean): void {
    const waiter = this.#compactWaiter;
    this.#compactWaiter = undefined;
    waiter?.resolve(value);
  }

  async #refreshBusyStatus(): Promise<void> {
    const statuses = await this.#api.getSessionStatuses();
    const status = statuses[this.openCodeSessionId];
    this.#busy = status?.type === "busy" || status?.type === "retry";
    this.#statusKnown = true;
  }

  async #handlePermission(requestID: string): Promise<void> {
    if (this.#handledPermissionIds.has(requestID)) return;
    this.#handledPermissionIds.add(requestID);
    try {
      await this.#api.replyPermission(requestID, "once");
    } catch (error) {
      this.#handledPermissionIds.delete(requestID);
      throw error;
    }
  }

  async #handleQuestion(requestID: string): Promise<void> {
    if (this.#handledQuestionIds.has(requestID)) return;
    this.#handledQuestionIds.add(requestID);
    try {
      await this.#api.rejectQuestion(requestID);
      await this.#emitError(
        "agent.question.unsupported",
        "OpenCode attempted to ask a question, but interactive questions are disabled for agent-bridge.",
      );
    } catch (error) {
      this.#handledQuestionIds.delete(requestID);
      throw error;
    }
  }

  async #flushAssistantMessages(): Promise<void> {
    for (const [messageID, buffer] of this.#messages) {
      if (!this.#assistantMessageIds.has(messageID)) continue;
      const extracted = extractMediaMarkers([...buffer.parts.values()].join(""));
      for (const attachment of extracted.attachments) {
        if (!buffer.attachments.has(attachment.filePath)) {
          buffer.attachments.set(attachment.filePath, attachment);
        }
      }
      const attachments = [...buffer.attachments.values()];
      if (extracted.text.trim() || attachments.length > 0) {
        await this.#emitAssistant(extracted.text, attachments.length > 0 ? attachments : undefined);
      }
    }
    this.#clearTurnState();
  }

  #clearTurnState(): void {
    this.#assistantMessageIds.clear();
    this.#ignoredMessageIds.clear();
    this.#messages.clear();
    this.#toolStatuses.clear();
  }

  #messageBuffer(messageID: string): MessageBuffer {
    let buffer = this.#messages.get(messageID);
    if (!buffer) {
      buffer = { parts: new Map(), attachments: new Map() };
      this.#messages.set(messageID, buffer);
    }
    return buffer;
  }

  #toAttachment(part: FilePart): OutboundAttachment | undefined {
    let filePath: string | undefined;
    if (part.url.startsWith("file://")) {
      try {
        filePath = fileURLToPath(part.url);
      } catch {
        return undefined;
      }
    } else if (part.source?.type === "file" && part.source.path.startsWith("/")) {
      filePath = part.source.path;
    }
    if (!filePath) return undefined;
    return {
      kind: part.mime.startsWith("image/") ? "image" : "file",
      filePath,
      fileName: part.filename,
    };
  }

  async #resolveCurrentModel(): Promise<SelectedModel> {
    if (this.#model) return this.#model;
    const messages = await this.#api.getMessages(this.openCodeSessionId, 50);
    const latestUser = this.#latestMessage(messages, "user");
    if (latestUser) {
      this.#model = latestUser.model;
      return latestUser.model;
    }
    const providers = await this.#api.getProviders();
    for (const providerID of providers.connected) {
      const modelID = providers.default[providerID];
      if (modelID) {
        this.#model = { providerID, modelID };
        return this.#model;
      }
    }
    throw new Error("OpenCode has no connected provider with a default model");
  }

  #latestMessage<T extends Message["role"]>(
    messages: OpenCodeMessage[],
    role: T,
  ): Extract<Message, { role: T }> | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = messages[index]?.info;
      if (info?.role === role) return info as Extract<Message, { role: T }>;
    }
    return undefined;
  }

  #assistantTokens(message: Extract<Message, { role: "assistant" }>): number {
    return (
      message.tokens.total ??
      message.tokens.input +
        message.tokens.output +
        message.tokens.reasoning +
        message.tokens.cache.read +
        message.tokens.cache.write
    );
  }

  #parseModelTarget(target: string): SelectedModel {
    const trimmed = target.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) {
      throw new OpenCodeModelCommandError("agent.model.invalid", `Invalid model target: ${target}`);
    }
    const providerID = trimmed.slice(0, slash).trim();
    const modelID = trimmed.slice(slash + 1).trim();
    if (!providerID || !modelID) {
      throw new OpenCodeModelCommandError("agent.model.invalid", `Invalid model target: ${target}`);
    }
    return { providerID, modelID };
  }

  #errorDetail(error: unknown): string {
    if (error && typeof error === "object") {
      const data = (error as { data?: { message?: unknown } }).data;
      if (typeof data?.message === "string") return data.message;
      const name = (error as { name?: unknown }).name;
      if (typeof name === "string") return name;
    }
    return "OpenCode session failed";
  }

  async #emitAssistant(text: string, attachments?: OutboundAttachment[]): Promise<void> {
    await this.#emit({ type: "assistant.message", text, attachments });
  }

  async #emitError(kind: string, detail: string): Promise<void> {
    await this.#emit({ type: "error", kind, detail });
  }

  async #emit(payload: AgentOutputPayload): Promise<void> {
    if (!this.#onOutput) return;
    await this.#onOutput({ ...payload, agentSessionId: this.#agentSessionId } as AgentOutputEvent);
  }

  #assertStarted(): void {
    if (!this.#started || !this.#onOutput) {
      throw new Error("OpenCodeAgentAdapter is not started");
    }
  }
}

export function currentModelFromSessionData(
  session: { model?: { providerID: string; id: string } },
  messages: OpenCodeMessage[],
  fallback?: string,
): SelectedModel | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.role === "user") return info.model;
  }
  if (session.model) return { providerID: session.model.providerID, modelID: session.model.id };
  if (!fallback) return undefined;
  const slash = fallback.indexOf("/");
  if (slash <= 0 || slash === fallback.length - 1) return undefined;
  return { providerID: fallback.slice(0, slash), modelID: fallback.slice(slash + 1) };
}
