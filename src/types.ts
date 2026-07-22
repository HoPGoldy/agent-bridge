export type ClientOutputEvent =
  | {
      type: "user.message";
      clientSessionId: string;
      text: string;
    }
  | {
      type: "command.session.new";
      clientSessionId: string;
    }
  | {
      type: "command.session.compact";
      clientSessionId: string;
    }
  | {
      type: "command.session.stop";
      clientSessionId: string;
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
      type: "assistant.tool.running";
      toolName: string;
      text?: string;
    }
  | {
      type: "assistant.tool.done";
      toolName: string;
      text?: string;
    }
  | {
      type: "assistant.tool.error";
      toolName: string;
      text?: string;
    }
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
  input(event: AgentInputEvent): Promise<void>;
  isBusy(): Promise<boolean>;
}

export interface ConfigSelectOption {
  label: string;
  value: string;
}

export interface ConfigInputOptions {
  defaultValue?: string;
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

export interface ClientModule<TConfig = unknown> {
  readonly type: string;
  createConfigCollector?: () => ConfigAdapter<TConfig>;
  createClientAdapter(config: TConfig): IMAdapter;
}

export interface AgentModule<TConfig = unknown> {
  readonly type: string;
  createConfigCollector?: () => ConfigAdapter<TConfig>;
  createAgentSession(args: { config: TConfig }): Promise<{
    agentSessionId: string;
    agentAdapter: AgentAdapter;
  }>;
  resumeAgentSession?(args: { config: TConfig; agentSessionId: string }): Promise<AgentAdapter>;
}

export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
  encryptKey?: string;
  verificationToken?: string;
  requireMentionInGroup?: boolean;
}

export interface PiCodingAgentConfig {
  bin?: string;
  sessionDir?: string;
  model?: string;
  extraArgs?: string[];
}

export type ClientConfig = {
  type: "feishu";
  config: FeishuClientConfig;
};

export type AgentConfig = {
  type: "pi-coding-agent";
  config: PiCodingAgentConfig;
};

export interface ChannelConfig {
  client: ClientConfig;
  agent: AgentConfig;
}

export interface AppDefaults {
  agentIdleTimeoutMs: number;
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
  bindingStore?: SessionBindingStore;
}

export interface SessionBindingStore {
  load(): Promise<Record<string, string>>;
  save(bindings: Record<string, string>): Promise<void>;
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
