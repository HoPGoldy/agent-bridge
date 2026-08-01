import { fileURLToPath } from "node:url";
import type { Event, FilePart, Message, Part, ToolPart } from "@opencode-ai/sdk/v2/types";
import { createLogger, type Logger } from "../../../../core/logger";
import type {
  AgentAdapter,
  AgentAvailableModel,
  AgentInputEvent,
  AgentOutputEvent,
  AgentSessionStatus,
  OpenCodeAgentConfig,
  OutboundAttachment,
} from "../../../../types";
import { describeOpenCodeError, type OpenCodeApi, type OpenCodeMessage } from "./opencode-api";
import { OpenCodeRuntime, type OpenCodeRuntimeAdapter } from "./opencode-runtime";

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

export class OpenCodeAgentAdapter implements AgentAdapter, OpenCodeRuntimeAdapter {
  readonly #agentSessionId: string;
  readonly #openCodeSessionId: string;
  readonly #config: OpenCodeAgentConfig;
  readonly #runtime: OpenCodeRuntime;
  readonly #api: OpenCodeApi;
  readonly #logger: Logger;
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

  constructor({
    agentSessionId,
    openCodeSessionId,
    config,
    runtime,
    initialModel,
    logger,
  }: {
    agentSessionId: string;
    openCodeSessionId: string;
    config: OpenCodeAgentConfig;
    runtime: OpenCodeRuntime;
    initialModel?: SelectedModel;
    logger?: Logger;
  }) {
    this.#agentSessionId = agentSessionId;
    this.#openCodeSessionId = openCodeSessionId;
    this.#config = config;
    this.#runtime = runtime;
    this.#api = runtime.api;
    this.#model = initialModel;
    this.#logger = logger ?? createLogger("opencode-agent");
  }

  get openCodeSessionId(): string {
    return this.#openCodeSessionId;
  }

  async start(onOutput: (event: AgentOutputEvent) => Promise<void> | void): Promise<void> {
    if (this.#started) return;
    this.#onOutput = onOutput;
    try {
      await this.#runtime.register(this);
      this.#started = true;
    } catch (error) {
      this.#onOutput = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#settleCompact(false);
    if (this.#started) await this.#runtime.unregister(this);
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
      await this.#api.abort(this.#openCodeSessionId);
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
        await this.#api.promptAsync(this.#openCodeSessionId, {
          text: event.text,
          agent: this.#config.agent,
          model: this.#model,
        });
        return;
      }

      const model = await this.#resolveCurrentModel();
      const compactCompletion = this.#beginCompact();
      this.#busy = true;
      this.#statusKnown = true;
      this.#compacting = true;
      await this.#emit({ type: "session.compacting", text: "Compacting context" });
      await this.#api.summarize(this.#openCodeSessionId, model);
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
      this.#api.getMessages(this.#openCodeSessionId, 50),
      this.#api.getProviders(),
    ]);
    const latestUser = this.#latestMessage(messages, "user");
    const latestAssistant = this.#latestMessage(messages, "assistant") ?? this.#latestAssistantMessage;
    const model = this.#model ?? latestUser?.model;
    const provider = model ? providers.all.find((item) => item.id === model.providerID) : undefined;
    const providerModel = model ? provider?.models[model.modelID] : undefined;
    const tokens = latestAssistant ? this.#assistantTokens(latestAssistant) : null;
    const contextWindow = providerModel?.limit.context ?? null;

    const currentStatus = statuses[this.#openCodeSessionId];
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
    const status = statuses[this.#openCodeSessionId];
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
      const text = [...buffer.parts.values()].join("");
      const attachments = [...buffer.attachments.values()];
      if (text.trim() || attachments.length > 0) {
        await this.#emitAssistant(text, attachments.length > 0 ? attachments : undefined);
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
    const messages = await this.#api.getMessages(this.#openCodeSessionId, 50);
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
