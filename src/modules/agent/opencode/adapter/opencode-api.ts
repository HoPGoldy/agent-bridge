import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  Event,
  Message,
  Part,
  PermissionRequest,
  Provider,
  QuestionRequest,
  Session,
  SessionStatus,
} from "@opencode-ai/sdk/v2/types";
import type { OpenCodeAgentConfig } from "../../../../types";

export interface OpenCodeMessage {
  info: Message;
  parts: Part[];
}

export interface OpenCodeProviderList {
  all: Provider[];
  connected: string[];
  default: Record<string, string>;
}

export interface OpenCodePromptOptions {
  text: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  system?: string;
}

export interface OpenCodeApi {
  health(): Promise<{ healthy: true; version: string }>;
  createSession(options: {
    title?: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
  }): Promise<Session>;
  getSession(sessionID: string): Promise<Session>;
  getSessionStatuses(): Promise<Record<string, SessionStatus>>;
  getMessages(sessionID: string, limit?: number): Promise<OpenCodeMessage[]>;
  promptAsync(sessionID: string, options: OpenCodePromptOptions): Promise<void>;
  abort(sessionID: string): Promise<void>;
  summarize(sessionID: string, model: { providerID: string; modelID: string }): Promise<void>;
  getProviders(): Promise<OpenCodeProviderList>;
  listPermissions(): Promise<PermissionRequest[]>;
  replyPermission(requestID: string, reply: "once" | "always" | "reject"): Promise<void>;
  listQuestions(): Promise<QuestionRequest[]>;
  rejectQuestion(requestID: string): Promise<void>;
  subscribe(args: {
    signal: AbortSignal;
    onConnected(): Promise<void> | void;
    onEvent(event: Event): Promise<void> | void;
  }): Promise<void>;
}

function buildAuthorization(config: OpenCodeAgentConfig): string | undefined {
  if (config.password === undefined || config.password === "") return undefined;
  const username = config.username?.trim() || "opencode";
  return `Basic ${Buffer.from(`${username}:${config.password}`).toString("base64")}`;
}

export function createOpenCodeApi(config: OpenCodeAgentConfig): OpenCodeApi {
  const directory = config.directory?.trim() || process.cwd();
  const authorization = buildAuthorization(config);
  const client = createOpencodeClient({
    baseUrl: config.baseUrl,
    directory,
    headers: authorization ? { Authorization: authorization } : undefined,
  });

  const data = async <T>(request: Promise<{ data: T }>): Promise<T> => (await request).data;

  return {
    health: () => data(client.global.health({ throwOnError: true })),

    createSession: ({ title, agent, model }) =>
      data(
        client.session.create(
          {
            directory,
            title,
            agent,
            model: model ? { providerID: model.providerID, id: model.modelID } : undefined,
          },
          { throwOnError: true },
        ),
      ),

    getSession: (sessionID) =>
      data(client.session.get({ directory, sessionID }, { throwOnError: true })),

    getSessionStatuses: () =>
      data(client.session.status({ directory }, { throwOnError: true })),

    getMessages: (sessionID, limit) =>
      data(client.session.messages({ directory, sessionID, limit }, { throwOnError: true })),

    async promptAsync(sessionID, options) {
      await client.session.promptAsync(
        {
          directory,
          sessionID,
          agent: options.agent,
          model: options.model,
          system: options.system,
          parts: [{ type: "text", text: options.text }],
        },
        { throwOnError: true },
      );
    },

    async abort(sessionID) {
      await client.session.abort({ directory, sessionID }, { throwOnError: true });
    },

    async summarize(sessionID, model) {
      await client.session.summarize(
        {
          directory,
          sessionID,
          providerID: model.providerID,
          modelID: model.modelID,
        },
        { throwOnError: true },
      );
    },

    getProviders: () => data(client.provider.list({ directory }, { throwOnError: true })),

    listPermissions: () => data(client.permission.list({ directory }, { throwOnError: true })),

    async replyPermission(requestID, reply) {
      await client.permission.reply({ directory, requestID, reply }, { throwOnError: true });
    },

    listQuestions: () => data(client.question.list({ directory }, { throwOnError: true })),

    async rejectQuestion(requestID) {
      await client.question.reject({ directory, requestID }, { throwOnError: true });
    },

    async subscribe({ signal, onConnected, onEvent }) {
      const subscription = await client.event.subscribe({ directory }, { signal });
      await onConnected();
      for await (const event of subscription.stream) {
        await onEvent(event);
      }
    },
  };
}

export function describeOpenCodeError(error: unknown, sensitiveValues: Array<string | undefined> = []): string {
  let detail: string;
  if (error && typeof error === "object") {
    const candidate = error as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
      message?: unknown;
    };
    const status = candidate.response?.status ?? candidate.statusCode ?? candidate.status;
    if (status === 401) return "OpenCode Server authentication failed (HTTP 401)";
    if (typeof status === "number") {
      const message = typeof candidate.message === "string" ? candidate.message : "OpenCode request failed";
      detail = `${message} (HTTP ${status})`;
    } else if (typeof candidate.message === "string" && candidate.message.trim()) {
      detail = candidate.message;
    } else {
      detail = error instanceof Error ? error.message : String(error);
    }
  } else {
    detail = error instanceof Error ? error.message : String(error);
  }

  for (const value of sensitiveValues) {
    if (value) detail = detail.replaceAll(value, "<redacted>");
  }
  return detail.replace(/(authorization\s*[:=]\s*basic\s+)[^\s,;]+/gi, "$1<redacted>");
}
