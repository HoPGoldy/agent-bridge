export type ClientOutputEvent =
  | {
      type: "user.message";
      clientSessionId: string;
      text: string;
    }
  | {
      type: "command.session.new";
      clientSessionId: string;
      /**
       * Always a concrete directory: the client adapter resolves the path
       * itself (explicit argument, remembered client-session default, or the
       * bridge process cwd fallback) before emitting the command.
       */
      workingDirectory: string;
      /**
       * Trust classification decided by the client adapter. `user` marks
       * user-originated paths (an explicit `/new <path>` argument or a
       * remembered default), which stay subject to the agent-side working
       * directory allowlist; `default` marks the client-side fallback (the
       * bridge process cwd), which is trusted and never allowlist-checked.
       */
      workingDirectorySource: ClientWorkingDirectorySource;
    }
  | {
      type: "command.session.compact";
      clientSessionId: string;
    }
  | {
      type: "command.session.stop";
      clientSessionId: string;
    }
  | {
      type: "command.session.status";
      clientSessionId: string;
    }
  | {
      type: "command.session.model.list";
      clientSessionId: string;
    }
  | {
      type: "command.session.model.set";
      clientSessionId: string;
      target: string;
    };

export type AgentInputEvent =
  | {
      type: "user.message";
      text: string;
    }
  | {
      type: "command.session.compact";
    };

export interface OutboundAttachment {
  kind: "image" | "file";
  filePath: string;
  fileName?: string;
  caption?: string;
}

export interface AgentSessionStatus {
  sessionId: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  context?: {
    tokens: number | null;
    contextWindow: number | null;
    percent: number | null;
  };
}

export interface AgentAvailableModel {
  provider: string;
  modelId: string;
  isCurrent: boolean;
}

type ToolProgressPayload = {
  toolName: string;
  toolCallId?: string;
  toolInput?: unknown;
  toolLabel?: string;
  text?: string;
};

type AgentOutputPayload =
  | {
      type: "assistant.message";
      text: string;
      attachments?: OutboundAttachment[];
    }
  | {
      type: "assistant.thinking";
      text?: string;
    }
  | {
      type: "agent.status.info";
      status: AgentSessionStatus;
    }
  | {
      type: "agent.model.list";
      models: AgentAvailableModel[];
    }
  | {
      type: "agent.model.updated";
      provider: string;
      modelId: string;
    }
  | {
      type: "error";
      kind: string;
      detail?: string;
    }
  | ({
      type: "assistant.tool.running";
    } & ToolProgressPayload)
  | ({
      type: "assistant.tool.update";
      partialResult?: unknown;
    } & ToolProgressPayload)
  | ({
      type: "assistant.tool.done";
      result?: unknown;
    } & ToolProgressPayload)
  | ({
      type: "assistant.tool.error";
      result?: unknown;
    } & ToolProgressPayload)
  | {
      type: "session.compacting";
      text?: string;
    };

export type AgentOutputEvent = AgentOutputPayload & {
  agentSessionId: string;
};

export type ClientInputEvent = AgentOutputPayload & {
  clientSessionId: string;
};

export type LegacyAgentInputEvent = AgentInputEvent;

/**
 * Trust classification for a working directory handed from a client adapter
 * to the gateway/agent side. `user` paths are user-originated and enforced
 * against the configured allowlist; `default` paths are trusted client-side
 * fallbacks and are never allowlist-checked.
 */
export type ClientWorkingDirectorySource = "user" | "default";

export interface IMAdapter {
  start(onOutput: (event: ClientOutputEvent) => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
  input(event: ClientInputEvent): Promise<void>;
  isBusy(): Promise<boolean>;
}

export interface AgentAdapter {
  start(onOutput: (event: AgentOutputEvent) => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
  abort?(): Promise<void>;
  getStatus?(): Promise<AgentSessionStatus>;
  getAvailableModels?(): Promise<AgentAvailableModel[]>;
  setModel?(target: string): Promise<{ provider: string; modelId: string }>;
  input(event: AgentInputEvent): Promise<void>;
  isBusy(): Promise<boolean>;
}

export interface ConfigSelectOption {
  label: string;
  value: string;
}

export interface ConfigInputOptions {
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  validate?: (value: string) => string | null;
}

export interface ConfigCollectContext {
  input(label: string, opts?: ConfigInputOptions): Promise<string>;
  select(label: string, options: ConfigSelectOption[]): Promise<string>;
  confirm(label: string, defaultValue?: boolean): Promise<boolean>;
  close(): void;
}

export interface ConfigAdapter<TConfig = unknown> {
  collect(ctx: ConfigCollectContext): Promise<TConfig>;
  validate(config: TConfig): Promise<void> | void;
  summarize?(config: TConfig): string;
}

export type LocaleCode = "zh-CN" | "en-US";

export interface ChannelCommonConfig {
  language: LocaleCode;
}

export interface ChannelCommonContext extends ChannelCommonConfig {
  channelName: string;
}

export interface ClientModule<TConfig = unknown, TState extends object = Record<string, never>> {
  readonly type: string;
  /**
   * Codec that validates and encodes this module's persisted client session
   * state (for example the remembered `/new` working directory). The runner
   * uses it to build the per-channel store handed to the adapter; the module
   * must keep its state JSON-compatible and versioned.
   */
  readonly sessionStateCodec: ClientSessionStateCodec<TState>;
  createConfigCollector?: () => ConfigAdapter<TConfig>;
  createClientAdapter(args: {
    config: TConfig;
    common: ChannelCommonContext;
    /** Per-channel client session state store scoped to this module's codec. */
    sessionState: ClientSessionStateStore<TState>;
  }): IMAdapter;
}

export interface AgentModule<TConfig = unknown, TState extends object = Record<string, never>> {
  readonly type: string;
  /**
   * Codec that validates and encodes this module's persisted session state.
   * The core uses it to reserve/open state handles; the module must accept the
   * handle in create/resume and keep its state JSON-compatible and versioned.
   */
  readonly sessionStateCodec: AgentSessionStateCodec<TState>;
  createConfigCollector?: () => ConfigAdapter<TConfig>;
  createAgentSession(args: {
    config: TConfig;
    common: ChannelCommonContext;
    /**
     * Core-owned bridge agent session id. The module must use it verbatim as
     * the adapter's agentSessionId and must not derive provider ids from it:
     * provider ids live in the session state.
     */
    agentSessionId: string;
    sessionState: NewAgentSessionStateApi<TState>;
    workingDirectory?: string;
    /**
     * Trust classification of `workingDirectory` as decided by the client
     * adapter: `user` paths are allowlist-checked, `default` paths (the
     * client-side cwd fallback) are trusted. Absent for implicitly created
     * sessions (first user message), where the module applies its own
     * default-directory policy.
     */
    workingDirectorySource?: ClientWorkingDirectorySource;
    /**
     * Optional list of allowed working-directory roots. When present and
     * non-empty, `workingDirectory` overrides must resolve inside one of the
     * roots; when absent/empty the provider is permissive. Provider-specific
     * enforcement applies (local realpath for Pi, lexical-only for OpenCode).
     */
    allowedWorkingDirectoryRoots?: string[];
  }): Promise<AgentAdapter>;
  /**
   * Restores an adapter for an existing persisted agent session from its
   * scoped state handle. Required for every persistable module: the core never
   * reads adapter-owned state (for example the working directory) to guess how
   * to restore a session; the module must read what it needs from
   * `sessionState` itself.
   */
  resumeAgentSession(args: {
    config: TConfig;
    common: ChannelCommonContext;
    agentSessionId: string;
    sessionState: AgentSessionStateApi<TState>;
    allowedWorkingDirectoryRoots?: string[];
  }): Promise<AgentAdapter>;
}

export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
  encryptKey?: string;
  verificationToken?: string;
  requireMentionInGroup?: boolean;
}

export interface WecomClientConfig {
  botId: string;
  secret: string;
  websocketUrl?: string;
  requireMentionInGroup?: boolean;
}

export interface WeixinClientConfig {
  accountId: string;
  token: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
}

export interface PiCodingAgentConfig {
  bin?: string;
  sessionDir?: string;
  model?: string;
  extraArgs?: string[];
}

export interface OpenCodeAgentConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  directory?: string;
  agent?: string;
  model?: string;
}

export type ClientConfig =
  | {
      type: "feishu";
      config: FeishuClientConfig;
    }
  | {
      type: "wecom";
      config: WecomClientConfig;
    }
  | {
      type: "weixin";
      config: WeixinClientConfig;
    };

export type AgentConfig =
  | {
      type: "pi-coding-agent";
      config: PiCodingAgentConfig;
    }
  | {
      type: "opencode";
      config: OpenCodeAgentConfig;
    };

export interface ChannelConfig {
  common: ChannelCommonConfig;
  client: ClientConfig;
  agent: AgentConfig;
}

export interface AppDefaults {
  agentIdleTimeoutMs: number;
  /**
   * Optional allowlist of working-directory roots for `/new <path>`. When
   * configured (non-empty), each override must resolve inside one of these
   * roots; when absent or empty the bridge is permissive.
   */
  allowedWorkingDirectoryRoots?: string[];
}

export interface AppConfig {
  channels: Record<string, ChannelConfig>;
  defaults: AppDefaults;
}

export interface ChannelRunner {
  stop(): Promise<void>;
}

export interface GatewayCoreOptions {
  imAdapter: IMAdapter;
  agentModule: AgentModule<any, any>;
  agentConfig: AgentConfig["config"];
  agentIdleTimeoutMs: number;
  allowedWorkingDirectoryRoots?: string[];
  /**
   * Per-channel persistent document store. When omitted, an in-memory store is
   * used (no durability). When `agentSessionStateRegistry` is also provided,
   * this store must be the registry's backing store.
   */
  channelStateStore?: ChannelStateStore;
  /**
   * Registry for scoped agent session state handles. Derived from
   * `channelStateStore` when omitted.
   */
  agentSessionStateRegistry?: AgentSessionStateRegistry;
  common?: ChannelCommonContext;
}

export interface SessionBinding {
  agentSessionId: string;
  workingDirectory?: string;
}

export interface SessionBindingStore {
  load(): Promise<Record<string, SessionBinding>>;
  save(bindings: Record<string, SessionBinding>): Promise<void>;
}

/**
 * Core-owned envelope for a persisted agent session. The `state` payload is
 * opaque to the core: it is owned by the agent module (or by legacy binding
 * migration) and must be JSON-compatible.
 */
export interface AgentSessionRecord {
  recordVersion: 1;
  agentType: string;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
  state: unknown;
}

/**
 * Versioned per-channel persistent document. `bindings` is a pure routing map
 * (client session id -> agent session id); agent-side metadata lives in
 * `agentSessions`, keyed by agent session id; client-side per-chat state
 * (owned by the client module) lives in `clientSessions`, keyed by client
 * session id.
 */
export interface ChannelPersistentState {
  version: 3;
  bindings: Record<string, string>;
  agentSessions: Record<string, AgentSessionRecord>;
  clientSessions: Record<string, ClientSessionRecord>;
}

/**
 * Core-owned envelope for a persisted client session. The `state` payload is
 * opaque to the core: it is owned by the client module and must be
 * JSON-compatible. Client session records are created lazily on the first
 * write (a chat exists as soon as it messages the bot; there is no explicit
 * session lifecycle like on the agent side).
 */
export interface ClientSessionRecord {
  recordVersion: 1;
  clientType: string;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
  state: unknown;
}

/**
 * Store interface for the full per-channel persistent document.
 *
 * `load`/`save` are the legacy facade surface; `transaction` and `flush` are
 * the serialized, atomic mutation surface. All mutations (bindings and agent
 * session state) must share the same write queue so no two writers can
 * overwrite each other.
 */
export interface ChannelStateStore {
  load(): Promise<ChannelPersistentState>;
  save(state: ChannelPersistentState): Promise<void>;
  /**
   * Runs `updater` strictly in order behind all earlier writes. The updater
   * must be synchronous: it either mutates the provided draft in place or
   * returns a complete next state. The resulting document is committed
   * atomically (temp file + rename).
   */
  transaction<T>(
    updater: (draft: ChannelPersistentState) => T | ChannelPersistentState,
  ): Promise<T>;
  /** Resolves once every enqueued write has been committed (queue drain). */
  flush(): Promise<void>;
}

/**
 * Runtime codec owned by an agent module. `encode` produces a
 * JSON-compatible payload; `decode` validates (and optionally migrates) a
 * persisted payload using the stored `stateVersion`.
 */
export interface AgentSessionStateCodec<TState extends object> {
  readonly currentVersion: number;
  decode(raw: unknown, stateVersion: number, context: { agentSessionId: string }): TState;
  encode(state: TState): unknown;
}

/**
 * Adapter-visible, session-scoped state handle. Every operation is confined
 * to the single agent session the handle was created for: the handle exposes
 * no other session ids and no delete/lifecycle operations.
 */
export interface AgentSessionStateApi<TState extends object> {
  readonly agentSessionId: string;
  /** Returns the current persisted state (waiting for pending writes). */
  read(): Promise<Readonly<TState>>;
  /** Replaces the persisted state atomically. */
  replace(next: TState): Promise<void>;
  /**
   * Atomic read-modify-write. `updater` must be synchronous; concurrent
   * updates are serialized and never lose changes.
   */
  update(updater: (current: Readonly<TState>) => TState): Promise<Readonly<TState>>;
  /** Waits until every pending write for this session has been persisted. */
  flush(): Promise<void>;
}

/** Creation-phase state handle: adds a one-shot {@link AgentSessionStateApi}. */
export interface NewAgentSessionStateApi<TState extends object>
  extends AgentSessionStateApi<TState> {
  /**
   * Atomically creates the persisted record. Succeeds exactly once; before
   * it is called, read/replace/update fail with a clear error.
   */
  initialize(initial: TState): Promise<void>;
}

/** Core-visible lifecycle surface for agent session state handles. */
export interface AgentSessionStateRegistry {
  /**
   * Reserves an in-memory creation handle for a brand-new session. Fails if
   * the id is already reserved/open or already persisted. Nothing is written
   * until {@link NewAgentSessionStateApi.initialize} is called.
   */
  reserve<TState extends object>(args: {
    agentSessionId: string;
    agentType: string;
    codec: AgentSessionStateCodec<TState>;
  }): Promise<NewAgentSessionStateApi<TState>>;
  /**
   * Opens a read/write handle for an existing persisted session. Validates
   * that the record exists, the agent type matches, and the stored state
   * decodes with the supplied codec.
   */
  open<TState extends object>(args: {
    agentSessionId: string;
    agentType: string;
    codec: AgentSessionStateCodec<TState>;
  }): Promise<AgentSessionStateApi<TState>>;
  /**
   * Invalidates every live handle for the session. The persisted record is
   * left intact so the session can be opened again later (for example after
   * an idle release). Idempotent.
   */
  revoke(agentSessionId: string): Promise<void>;
  /**
   * Revokes every live handle and removes the persisted record. Idempotent:
   * deleting a session that does not exist succeeds. Old handles can never
   * resurrect the record.
   */
  delete(agentSessionId: string): Promise<void>;
}

/**
 * Runtime codec owned by a client module. `encode` produces a
 * JSON-compatible payload; `decode` validates (and optionally migrates) a
 * persisted payload using the stored `stateVersion`.
 */
export interface ClientSessionStateCodec<TState extends object> {
  readonly currentVersion: number;
  decode(raw: unknown, stateVersion: number, context: { clientSessionId: string }): TState;
  encode(state: TState): unknown;
}

/**
 * Adapter-visible, session-scoped client state handle. Client sessions are
 * created lazily: a chat needs no explicit lifecycle, so `read` returns
 * `undefined` until the first `update` persists a record. Every operation is
 * confined to the single client session the handle was created for.
 */
export interface ClientSessionStateApi<TState extends object> {
  readonly clientSessionId: string;
  /** Returns the current persisted state, or `undefined` when nothing was stored yet. */
  read(): Promise<Readonly<TState> | undefined>;
  /**
   * Atomic read-modify-write behind the channel store's write queue. Creates
   * the persisted record on the first write. `updater` must be synchronous
   * and receives `undefined` when no state exists yet.
   */
  update(updater: (current: Readonly<TState> | undefined) => TState): Promise<Readonly<TState>>;
  /** Waits until every pending write for the channel has been persisted. */
  flush(): Promise<void>;
}

/**
 * Per-channel store of client session state, scoped to one client module
 * (type + codec). Handles are cheap and can be requested at any time; records
 * live in the channel state document under `clientSessions`.
 */
export interface ClientSessionStateStore<TState extends object> {
  session(clientSessionId: string): ClientSessionStateApi<TState>;
}

export interface RunChannelOptions {
  channelName: string;
  channelConfig: ChannelConfig;
  defaults: AppDefaults;
}

export interface FeishuInboundMessage {
  chatId: string;
  chatType: "p2p" | "group";
  messageId: string;
  text: string;
  mentionedBot?: boolean;
  raw?: unknown;
}

export interface WecomInboundMessage {
  chatId: string;
  chatType: "dm" | "group";
  messageId: string;
  text: string;
  mentionedBot?: boolean;
  raw?: unknown;
}

export interface WeixinInboundMessage {
  chatId: string;
  chatType: "dm" | "group";
  messageId: string;
  text: string;
  mentionedBot?: boolean;
  raw?: unknown;
}
