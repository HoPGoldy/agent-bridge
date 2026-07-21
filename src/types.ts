export type AgentIngressEvent = {
  type: "user.message";
  sessionId: string;
  text: string;
};

export type AgentEgressEvent = {
  type: "assistant.message";
  sessionId: string;
  text: string;
};

export interface IMAdapter {
  start(onOutput: (event: AgentIngressEvent) => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
  input(event: AgentEgressEvent): Promise<void>;
  isBusy(): Promise<boolean>;
}

export interface AgentAdapter {
  start(onOutput: (event: AgentEgressEvent) => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
  input(event: AgentIngressEvent): Promise<void>;
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
  createAgentAdapter(config: TConfig): AgentAdapter;
}

export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
  encryptKey?: string;
  verificationToken?: string;
}

export interface PiRpcAgentConfig {
  bin?: string;
  sessionDir?: string;
  extraArgs?: string[];
}

export type ClientConfig = {
  type: "feishu";
  config: FeishuClientConfig;
};

export type AgentConfig = {
  type: "pi-rpc";
  config: PiRpcAgentConfig;
};

export interface ChannelConfig {
  client: ClientConfig;
  agent: AgentConfig;
}

export interface AppDefaults {
  pollIntervalMs: number;
  maxQueueSize: number;
  agentIdleTimeoutMs: number;
}

export interface AppConfig {
  channels: Record<string, ChannelConfig>;
  defaults: AppDefaults;
}

export interface ChannelRunner {
  stop(): Promise<void>;
}

export interface AgentFactory {
  create(
    sessionId: string,
    onOutput: (event: AgentEgressEvent) => Promise<void>,
  ): Promise<AgentAdapter>;
}

export interface GatewayCoreOptions {
  imAdapter: IMAdapter;
  agentFactory: AgentFactory;
  pollIntervalMs: number;
  maxQueueSize: number;
  agentIdleTimeoutMs: number;
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
  raw?: unknown;
}
