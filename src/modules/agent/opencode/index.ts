import { createHash } from "node:crypto";
import { createLogger } from "../../../core/logger";
import type {
  AgentModule,
  AgentSessionStateCodec,
  ConfigAdapter,
  ConfigCollectContext,
  OpenCodeAgentConfig,
} from "../../../types";
import {
  OpenCodeAgentAdapter,
  parseConfiguredModel,
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

/** Where the persisted working directory came from. */
export type OpenCodeWorkingDirectorySource = "user" | "configured" | "bridge-default";

/**
 * Versioned per-session state owned by the OpenCode module. The adapter
 * resolves the working-directory policy and persists it (including the
 * bridge-default cwd for a bare `/new`), so a resumed session always restarts
 * in the same directory even when the bridge process cwd changed.
 */
export interface OpenCodeAgentSessionStateV1 {
  version: 1;
  /** Provider session id on the OpenCode Server. */
  openCodeSessionId: string;
  /**
   * Directory sent to the OpenCode Server (trimmed; never locally resolved or
   * realpath-ed, never shell/env/`~` expanded). The server may be remote or
   * inside a container, so agent-bridge only trims and validates lexically.
   */
  workingDirectory: string;
  /** Where the directory came from. */
  workingDirectorySource: OpenCodeWorkingDirectorySource;
  /**
   * Decode-only marker set while the persisted record is still the legacy
   * binding-migrated form (`{ migratedFromBinding: true }`). The adapter
   * rewrites the record to the canonical V1 shape on the first resume; encode
   * never persists it.
   */
  migratedFromBinding?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function workingDirectoryOf(raw: Record<string, unknown>): string | undefined {
  return typeof raw.workingDirectory === "string" && raw.workingDirectory.length > 0
    ? raw.workingDirectory
    : undefined;
}

function isWorkingDirectorySource(value: unknown): value is OpenCodeWorkingDirectorySource {
  return value === "user" || value === "configured" || value === "bridge-default";
}

/**
 * Validates and encodes the OpenCode session state.
 *
 * Legacy binding-migrated records (`{ migratedFromBinding: true }`) decode to
 * the versioned shape: the provider session id is derived from the old bridge
 * id (`opencode:<providerId>`) via the decode context, a migrated working
 * directory is treated as user supplied, and a record without one is migrated
 * to the current process cwd as a provisional bridge-default (the adapter
 * prefers the channel-configured directory on the first resume). Both are
 * marked `migratedFromBinding: true` so the adapter rewrites them into the
 * canonical persisted form on the first resume.
 *
 * New core-owned bridge ids (`opencode:<uuid>`) belong to versioned records
 * and never take the migrated branch, so a provider id is never sliced out of
 * a new bridge id: the codec strictly validates `stateVersion`, every field
 * and the source, and `encode` produces only the canonical plain object
 * (stripping the decode-only marker) so forged state fails at the writer.
 */
export const openCodeAgentSessionStateCodec: AgentSessionStateCodec<OpenCodeAgentSessionStateV1> = {
  currentVersion: 1,

  decode(raw, stateVersion, context) {
    if (!isRecord(raw)) {
      throw new Error("invalid OpenCode agent session state: expected a state document");
    }

    if (raw.migratedFromBinding === true) {
      if (stateVersion !== 1) {
        throw new Error(`unsupported OpenCode agent session state version ${stateVersion}`);
      }
      if (
        !context.agentSessionId.startsWith("opencode:") ||
        context.agentSessionId.length === "opencode:".length
      ) {
        throw new Error(
          `cannot derive the OpenCode session id from migrated agent session ${context.agentSessionId}`,
        );
      }
      const workingDirectory = workingDirectoryOf(raw);
      return {
        version: 1,
        openCodeSessionId: context.agentSessionId.slice("opencode:".length),
        workingDirectory: workingDirectory ?? process.cwd(),
        workingDirectorySource: workingDirectory !== undefined ? "user" : "bridge-default",
        migratedFromBinding: true,
      };
    }

    if (raw.version !== 1) {
      throw new Error("invalid OpenCode agent session state: expected a versioned state document");
    }
    if (stateVersion !== 1) {
      throw new Error(`unsupported OpenCode agent session state version ${stateVersion}`);
    }
    if (typeof raw.openCodeSessionId !== "string" || raw.openCodeSessionId.length === 0) {
      throw new Error(
        "invalid OpenCode agent session state: openCodeSessionId must be a non-empty string",
      );
    }
    const workingDirectory = workingDirectoryOf(raw);
    if (workingDirectory === undefined) {
      throw new Error(
        "invalid OpenCode agent session state: workingDirectory must be a non-empty string",
      );
    }
    if (!isWorkingDirectorySource(raw.workingDirectorySource)) {
      throw new Error(
        'invalid OpenCode agent session state: workingDirectorySource must be "user", "configured" or "bridge-default"',
      );
    }
    return {
      version: 1,
      openCodeSessionId: raw.openCodeSessionId,
      workingDirectory,
      workingDirectorySource: raw.workingDirectorySource,
    };
  },

  encode(state) {
    // Validate before persisting: a forged or partially-migrated state must
    // fail here, while the writer still owns the failure, never on the next
    // decode. The canonical persisted form never includes the decode-only
    // migration marker.
    if (state.version !== 1) {
      throw new Error("invalid OpenCode agent session state: version must be 1");
    }
    if (typeof state.openCodeSessionId !== "string" || state.openCodeSessionId.length === 0) {
      throw new Error(
        "invalid OpenCode agent session state: openCodeSessionId must be a non-empty string",
      );
    }
    if (typeof state.workingDirectory !== "string" || state.workingDirectory.length === 0) {
      throw new Error(
        "invalid OpenCode agent session state: workingDirectory must be a non-empty string",
      );
    }
    if (!isWorkingDirectorySource(state.workingDirectorySource)) {
      throw new Error(
        'invalid OpenCode agent session state: workingDirectorySource must be "user", "configured" or "bridge-default"',
      );
    }
    return {
      version: 1,
      openCodeSessionId: state.openCodeSessionId,
      workingDirectory: state.workingDirectory,
      workingDirectorySource: state.workingDirectorySource,
    };
  },
};

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

export function createOpenCodeAgentModule(
  dependencies: OpenCodeModuleDependencies = {},
): AgentModule<OpenCodeAgentConfig, OpenCodeAgentSessionStateV1> {
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

  return {
    type: "opencode",
    sessionStateCodec: openCodeAgentSessionStateCodec,
    createConfigCollector: () => createOpenCodeConfigCollector(apiFactory, writeLine),

    /**
     * The module only assembles adapter dependencies. The adapter owns the
     * working-directory policy, provider session creation, state
     * initialization and runtime registration inside `start()`.
     */
    async createAgentSession({ config, common, agentSessionId, sessionState, workingDirectory, allowedWorkingDirectoryRoots }) {
      logger.info(`creating agent session ${agentSessionId} for channel ${common.channelName}`);
      return new OpenCodeAgentAdapter({
        agentSessionId,
        mode: "create",
        sessionState,
        config,
        channelName: common.channelName,
        ...(workingDirectory !== undefined ? { workingDirectory } : {}),
        ...(allowedWorkingDirectoryRoots !== undefined ? { allowedWorkingDirectoryRoots } : {}),
        getRuntime,
      });
    },

    async resumeAgentSession({ config, common, agentSessionId, sessionState, allowedWorkingDirectoryRoots }) {
      logger.info(`resuming agent session ${agentSessionId} for channel ${common.channelName}`);
      return new OpenCodeAgentAdapter({
        agentSessionId,
        mode: "resume",
        sessionState,
        config,
        channelName: common.channelName,
        ...(allowedWorkingDirectoryRoots !== undefined ? { allowedWorkingDirectoryRoots } : {}),
        getRuntime,
      });
    },
  };
}

export const openCodeAgentModule = createOpenCodeAgentModule();
