export type ClientOutputEvent =
  | {
      type: "user.message";
      clientSessionId: string;
      text: string;
    }
  | {
      type: "command.session.new";
      clientSessionId: string;
      workingDirectory?: string;
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

export interface ClientModule<TConfig = unknown> {
  readonly type: string;
  createConfigCollector?: () => ConfigAdapter<TConfig>;
  createClientAdapter(args: { config: TConfig; common: ChannelCommonContext }): IMAdapter;
}

export interface AgentModule<TConfig = unknown> {
  readonly type: string;
  createConfigCollector?: () => ConfigAdapter<TConfig>;
  createAgentSession(args: {
    config: TConfig;
    common: ChannelCommonContext;
    workingDirectory?: string;
    /**
     * Optional list of allowed working-directory roots. When present and
     * non-empty, `workingDirectory` overrides must resolve inside one of the
     * roots; when absent/empty the provider is permissive. Provider-specific
     * enforcement applies (local realpath for Pi, lexical-only for OpenCode).
     */
    allowedWorkingDirectoryRoots?: string[];
  }): Promise<{
    agentSessionId: string;
    agentAdapter: AgentAdapter;
  }>;
  resumeAgentSession?(args: {
    config: TConfig;
    common: ChannelCommonContext;
    agentSessionId: string;
    workingDirectory?: string;
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
  agentModule: AgentModule<any>;
  agentConfig: AgentConfig["config"];
  agentIdleTimeoutMs: number;
  allowedWorkingDirectoryRoots?: string[];
  bindingStore?: SessionBindingStore;
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
 * `agentSessions`, keyed by agent session id.
 */
export interface ChannelPersistentState {
  version: 2;
  bindings: Record<string, string>;
  agentSessions: Record<string, AgentSessionRecord>;
}

/** Store interface for the full per-channel persistent document. */
export interface ChannelStateStore {
  load(): Promise<ChannelPersistentState>;
  save(state: ChannelPersistentState): Promise<void>;
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
