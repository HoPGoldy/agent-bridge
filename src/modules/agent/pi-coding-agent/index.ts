import os from "node:os";
import path from "node:path";
import { PiCodingAgentAdapter, type PiCodingAgentAdapterOptions } from "./adapter/pi-coding-agent-adapter";
import { createLogger } from "../../../core/logger";
import type {
  AgentModule,
  AgentSessionStateCodec,
  ConfigAdapter,
  PiCodingAgentConfig,
} from "../../../types";

const logger = createLogger("pi-coding-agent");

/**
 * Versioned per-session state owned by the Pi module. The adapter resolves and
 * persists the canonical working directory (including the default cwd for a
 * bare `/new`) before spawning the Pi process, so a resumed session always
 * restarts in the same directory even when the bridge process cwd changed.
 */
export interface PiCodingAgentSessionStateV1 {
  version: 1;
  /** Canonical (realpath-resolved) directory the Pi process is spawned in. */
  workingDirectory: string;
  /**
   * Where the directory came from: `user` for user-originated `/new` paths
   * (an explicit argument or a remembered chat default), `default` for the
   * client-side cwd fallback or implicitly created sessions.
   */
  workingDirectorySource: "default" | "user";
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

/**
 * Validates and encodes the Pi session state.
 *
 * Legacy binding-migrated records (`{ migratedFromBinding: true }`) decode to
 * the versioned shape: a migrated `workingDirectory` is treated as user
 * supplied, while a record without one is migrated to the current process cwd
 * as a default. Both are marked `migratedFromBinding: true` so the adapter
 * rewrites them into the canonical persisted form on the first resume.
 *
 * `stateVersion` is strictly validated: any version other than the current one
 * fails decode (fail-safe) instead of being silently coerced.
 */
export const piCodingAgentSessionStateCodec: AgentSessionStateCodec<PiCodingAgentSessionStateV1> = {
  currentVersion: 1,

  decode(raw, stateVersion, _context) {
    if (!isRecord(raw)) {
      throw new Error("invalid Pi agent session state: expected a state document");
    }

    if (raw.migratedFromBinding === true) {
      if (stateVersion !== 1) {
        throw new Error(`unsupported Pi agent session state version ${stateVersion}`);
      }
      const workingDirectory = workingDirectoryOf(raw);
      return {
        version: 1,
        workingDirectory: workingDirectory ?? process.cwd(),
        workingDirectorySource: workingDirectory !== undefined ? "user" : "default",
        migratedFromBinding: true,
      };
    }

    if (raw.version !== 1) {
      throw new Error("invalid Pi agent session state: expected a versioned state document");
    }
    if (stateVersion !== 1) {
      throw new Error(`unsupported Pi agent session state version ${stateVersion}`);
    }
    const workingDirectory = workingDirectoryOf(raw);
    if (workingDirectory === undefined) {
      throw new Error("invalid Pi agent session state: workingDirectory must be a non-empty string");
    }
    const source = raw.workingDirectorySource;
    if (source !== "default" && source !== "user") {
      throw new Error(
        'invalid Pi agent session state: workingDirectorySource must be "default" or "user"',
      );
    }
    return { version: 1, workingDirectory, workingDirectorySource: source };
  },

  encode(state) {
    // Validate before persisting: a forged or partially-migrated state must
    // fail here, while the writer still owns the failure, never on the next
    // decode. The canonical persisted form never includes the decode-only
    // migration marker.
    if (state.version !== 1) {
      throw new Error("invalid Pi agent session state: version must be 1");
    }
    if (typeof state.workingDirectory !== "string" || state.workingDirectory.length === 0) {
      throw new Error("invalid Pi agent session state: workingDirectory must be a non-empty string");
    }
    if (state.workingDirectorySource !== "default" && state.workingDirectorySource !== "user") {
      throw new Error(
        'invalid Pi agent session state: workingDirectorySource must be "default" or "user"',
      );
    }
    return {
      version: 1,
      workingDirectory: state.workingDirectory,
      workingDirectorySource: state.workingDirectorySource,
    };
  },
};

function parseExtraArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildAdapterOptions(
  config: PiCodingAgentConfig,
  agentSessionId: string,
  sessionState: PiCodingAgentAdapterOptions["sessionState"],
  options: {
    mode: "create" | "resume";
    workingDirectory?: string;
    workingDirectorySource?: "user" | "default";
    allowedWorkingDirectoryRoots?: string[];
  },
): PiCodingAgentAdapterOptions {
  return {
    agentSessionId,
    mode: options.mode,
    sessionState,
    ...(options.workingDirectory !== undefined ? { workingDirectory: options.workingDirectory } : {}),
    ...(options.workingDirectorySource !== undefined
      ? { workingDirectorySource: options.workingDirectorySource }
      : {}),
    ...(options.allowedWorkingDirectoryRoots !== undefined
      ? { allowedWorkingDirectoryRoots: options.allowedWorkingDirectoryRoots }
      : {}),
    sessionDir:
      config.sessionDir ??
      process.env.PI_SESSION_DIR ??
      path.join(os.homedir(), ".config", "agent-bridge", "pi-sessions"),
    bin: config.bin ?? process.env.PI_BIN ?? "pi",
    model: config.model ?? process.env.PI_MODEL,
    extraArgs: config.extraArgs ?? parseExtraArgs(process.env.PI_RPC_EXTRA_ARGS),
  };
}

function createPiCodingAgentConfigCollector(): ConfigAdapter<PiCodingAgentConfig> {
  return {
    async collect(ctx) {
      const model = await ctx.input("Pi model (leave empty for pi default)", {
        placeholder: "Example: azure-openai-responses/gpt-5.6-terra",
      });
      return model ? { model } : {};
    },

    validate(config) {
      if (config.model !== undefined && !config.model.trim()) {
        throw new Error("Pi model must be non-empty when provided");
      }
    },

    summarize(config) {
      return `type=pi-coding-agent model=${config.model ?? "default"}`;
    },
  };
}

/**
 * Pi module. The module only assembles adapter dependencies: the adapter owns
 * the working-directory resolution and its session state (initialize on
 * create, read/rewrite on resume) inside `start()`, before the Pi process is
 * spawned.
 */
export const piCodingAgentModule: AgentModule<PiCodingAgentConfig, PiCodingAgentSessionStateV1> = {
  type: "pi-coding-agent",
  sessionStateCodec: piCodingAgentSessionStateCodec,
  createConfigCollector: createPiCodingAgentConfigCollector,

  async createAgentSession({ config, common, agentSessionId, sessionState, workingDirectory, workingDirectorySource, allowedWorkingDirectoryRoots }) {
    logger.info(`creating agent session ${agentSessionId} for channel ${common.channelName}`);
    return new PiCodingAgentAdapter(
      buildAdapterOptions(config, agentSessionId, sessionState, {
        mode: "create",
        workingDirectory,
        workingDirectorySource,
        allowedWorkingDirectoryRoots,
      }),
    );
  },

  async resumeAgentSession({ config, common, agentSessionId, sessionState, allowedWorkingDirectoryRoots }) {
    logger.info(`resuming agent session ${agentSessionId} for channel ${common.channelName}`);
    return new PiCodingAgentAdapter(
      buildAdapterOptions(config, agentSessionId, sessionState, {
        mode: "resume",
        allowedWorkingDirectoryRoots,
      }),
    );
  },
};
