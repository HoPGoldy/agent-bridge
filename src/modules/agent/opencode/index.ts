import { createHash } from "node:crypto";
import { createLogger } from "../../../core/logger";
import type {
  AgentAdapter,
  AgentModule,
  ConfigAdapter,
  ConfigCollectContext,
  OpenCodeAgentConfig,
} from "../../../types";
import {
  currentModelFromSessionData,
  OpenCodeAgentAdapter,
} from "./adapter/opencode-agent-adapter";
import {
  createOpenCodeApi,
  describeOpenCodeError,
  type OpenCodeApi,
  type OpenCodeProviderList,
} from "./adapter/opencode-api";
import { OpenCodeRuntime } from "./adapter/opencode-runtime";

const logger = createLogger("opencode");
const PERMISSION_CONFIG = `{"permission":{"*":"allow","question":"deny"}}`;

export interface OpenCodeModuleDependencies {
  apiFactory?: (config: OpenCodeAgentConfig) => OpenCodeApi;
  writeLine?: (line: string) => void;
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("OpenCode Server URL must be a valid HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenCode Server URL must use http:// or https://");
  }
  if (url.username || url.password) {
    throw new Error("Do not include credentials in the OpenCode Server URL; use the Basic Auth fields instead");
  }
  return url.toString().replace(/\/$/, "");
}

function isLoopbackUrl(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function parseConfiguredModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error("OpenCode model must use provider/modelID format");
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function assertModelAvailable(model: string | undefined, providers: OpenCodeProviderList): void {
  const parsed = parseConfiguredModel(model);
  if (!parsed) return;
  const provider = providers.all.find((item) => item.id === parsed.providerID);
  if (!providers.connected.includes(parsed.providerID) || !provider?.models[parsed.modelID]) {
    throw new Error(`OpenCode model is not available from a connected provider: ${model}`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function redactedBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function startupCommand(config: OpenCodeAgentConfig): string {
  const url = new URL(config.baseUrl);
  const port = url.port || (url.protocol === "https:" ? "443" : "4096");
  const hostname = isLoopbackUrl(config.baseUrl) ? "127.0.0.1" : "0.0.0.0";
  const auth = config.password
    ? `OPENCODE_SERVER_USERNAME=${shellQuote(config.username || "opencode")} \\\nOPENCODE_SERVER_PASSWORD='<password>' \\\n`
    : "";
  return `${auth}OPENCODE_CONFIG_CONTENT='${PERMISSION_CONFIG}' \\\nopencode serve --hostname ${hostname} --port ${port}`;
}

/**
 * Returns a config whose `directory` reflects the per-session working directory
 * override for this lifecycle call, without mutating the shared channel config.
 *
 * The OpenCode Server may run remotely or inside a container, so the override is
 * only trimmed here: no local filesystem checks and no shell/env/`~` expansion
 * happen in agent-bridge. The OpenCode Server itself validates the directory
 * when the session is created or resumed, and errors propagate back through the
 * Gateway's session-new transaction.
 *
 * An empty/whitespace override is treated as "no override", falling back to the
 * channel-level `directory` (or the agent-bridge process cwd).
 */
function withWorkingDirectory(
  config: OpenCodeAgentConfig,
  workingDirectory: string | undefined,
): OpenCodeAgentConfig {
  const trimmed = workingDirectory?.trim();
  if (!trimmed) return config;
  return { ...config, directory: trimmed };
}

function runtimeKey(channelName: string, config: OpenCodeAgentConfig): string {
  const digest = createHash("sha256")
    .update(config.password ?? "")
    .digest("hex")
    .slice(0, 16);
  return [
    channelName,
    config.baseUrl,
    config.directory?.trim() || process.cwd(),
    config.username?.trim() || "",
    digest,
  ].join("\0");
}

function bridgeSessionId(openCodeSessionId: string): string {
  return `opencode:${openCodeSessionId}`;
}

function openCodeSessionId(agentSessionId: string): string {
  if (!agentSessionId.startsWith("opencode:") || agentSessionId.length === "opencode:".length) {
    throw new Error(`Invalid OpenCode agent session ID: ${agentSessionId}`);
  }
  return agentSessionId.slice("opencode:".length);
}

async function verifyServer(api: OpenCodeApi, config: OpenCodeAgentConfig): Promise<void> {
  const health = await api.health();
  if (!health.healthy || !health.version) throw new Error("OpenCode Server returned an invalid health response");
  if (config.model) assertModelAvailable(config.model, await api.getProviders());
}

function createOpenCodeConfigCollector(
  apiFactory: (config: OpenCodeAgentConfig) => OpenCodeApi,
  writeLine: (line: string) => void,
): ConfigAdapter<OpenCodeAgentConfig> {
  const verified = new WeakSet<OpenCodeAgentConfig>();

  return {
    async collect(ctx: ConfigCollectContext) {
      const baseUrl = normalizeBaseUrl(
        await ctx.input("OpenCode Server URL", {
          required: true,
          defaultValue: "http://127.0.0.1:4096",
          validate(value) {
            try {
              normalizeBaseUrl(value);
              return null;
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          },
        }),
      );
      const useAuth = await ctx.confirm("Use HTTP Basic Auth?", false);
      const username = useAuth
        ? await ctx.input("OpenCode Server username", { required: true, defaultValue: "opencode" })
        : undefined;
      const password = useAuth
        ? await ctx.input("OpenCode Server password", { required: true, secret: true })
        : undefined;
      const directory = await ctx.input("OpenCode working directory (leave empty for current directory)");
      const agent = await ctx.input("OpenCode agent (leave empty for server default)");
      const model = await ctx.input("OpenCode model (leave empty for server default)", {
        placeholder: "provider/modelID",
        validate(value) {
          try {
            parseConfiguredModel(value || undefined);
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
      });

      const config: OpenCodeAgentConfig = {
        baseUrl,
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
        ...(directory ? { directory } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
      };

      if (new URL(baseUrl).protocol === "http:" && !isLoopbackUrl(baseUrl)) {
        const accepted = await ctx.confirm(
          "This remote OpenCode Server uses unencrypted HTTP. Continue only if the network is trusted or otherwise protected?",
          false,
        );
        if (!accepted) throw new Error("Remote HTTP OpenCode Server was not accepted");
      }

      while (true) {
        try {
          await verifyServer(apiFactory(config), config);
          verified.add(config);
          return config;
        } catch (error) {
          writeLine(
            `Unable to connect to ${redactedBaseUrl(config.baseUrl)}: ${describeOpenCodeError(error, [config.password])}`,
          );
          writeLine("Start a compatible OpenCode Server with:");
          writeLine(startupCommand(config));
          if (!(await ctx.confirm("Retry the OpenCode Server connection?", true))) throw error;
        }
      }
    },

    async validate(config) {
      config.baseUrl = normalizeBaseUrl(config.baseUrl);
      if (config.password === "") config.password = undefined;
      parseConfiguredModel(config.model);
      if (!verified.has(config)) await verifyServer(apiFactory(config), config);
    },

    summarize(config) {
      return `type=opencode baseUrl=${config.baseUrl} auth=${config.password ? "basic" : "none"}${
        config.username ? ` username=${config.username}` : ""
      } model=${config.model ?? "default"}`;
    },
  };
}

export function createOpenCodeAgentModule(dependencies: OpenCodeModuleDependencies = {}): AgentModule<OpenCodeAgentConfig> {
  const apiFactory = dependencies.apiFactory ?? createOpenCodeApi;
  const writeLine = dependencies.writeLine ?? ((line: string) => console.error(line));
  const runtimes = new Map<string, OpenCodeRuntime>();

  const getRuntime = (channelName: string, config: OpenCodeAgentConfig): OpenCodeRuntime => {
    const key = runtimeKey(channelName, config);
    const existing = runtimes.get(key);
    if (existing) return existing;
    let runtime: OpenCodeRuntime;
    runtime = new OpenCodeRuntime({
      api: apiFactory(config),
      describeError: (error) => describeOpenCodeError(error, [config.password]),
      onEmpty: () => {
        if (runtimes.get(key) === runtime) runtimes.delete(key);
      },
    });
    runtimes.set(key, runtime);
    return runtime;
  };

  const buildAdapter = (
    config: OpenCodeAgentConfig,
    channelName: string,
    sessionID: string,
    initialModel?: { providerID: string; modelID: string },
  ): AgentAdapter =>
    new OpenCodeAgentAdapter({
      agentSessionId: bridgeSessionId(sessionID),
      openCodeSessionId: sessionID,
      config,
      runtime: getRuntime(channelName, config),
      initialModel,
    });

  return {
    type: "opencode",
    createConfigCollector: () => createOpenCodeConfigCollector(apiFactory, writeLine),

    async createAgentSession({ config, common, workingDirectory }) {
      const effective = withWorkingDirectory(config, workingDirectory);
      const runtime = getRuntime(common.channelName, effective);
      const configuredModel = parseConfiguredModel(effective.model);
      const session = await runtime.api.createSession({
        title: `agent-bridge:${common.channelName}`,
        agent: effective.agent,
        model: configuredModel,
      });
      const agentSessionId = bridgeSessionId(session.id);
      logger.info(`created OpenCode session ${agentSessionId} for channel ${common.channelName}`);
      return {
        agentSessionId,
        agentAdapter: buildAdapter(effective, common.channelName, session.id, currentModelFromSessionData(session, [], effective.model)),
      };
    },

    async resumeAgentSession({ config, common, agentSessionId, workingDirectory }) {
      const sessionID = openCodeSessionId(agentSessionId);
      const effective = withWorkingDirectory(config, workingDirectory);
      const runtime = getRuntime(common.channelName, effective);
      const [session, messages] = await Promise.all([
        runtime.api.getSession(sessionID),
        runtime.api.getMessages(sessionID, 50),
      ]);
      logger.info(`resumed OpenCode session ${agentSessionId} for channel ${common.channelName}`);
      return buildAdapter(
        effective,
        common.channelName,
        sessionID,
        currentModelFromSessionData(session, messages, effective.model),
      );
    },
  };
}

export const openCodeAgentModule = createOpenCodeAgentModule();
