import os from "node:os";
import path from "node:path";
import { PiCodingAgentAdapter } from "./adapter/pi-coding-agent-adapter";
import { resolveWorkingDirectory } from "./working-directory";
import { createLogger } from "../../../core/logger";
import type {
  AgentAdapter,
  AgentModule,
  AgentSessionStateApi,
  AgentSessionStateCodec,
  ConfigAdapter,
  PiCodingAgentConfig,
} from "../../../types";

const logger = createLogger("pi-coding-agent");

/** Versioned per-session state owned by the Pi module. */
export interface PiCodingAgentSessionStateV1 {
  version: 1;
  /**
   * Canonicalized working directory. Absent when the session was started with
   * a bare `/new` (the adapter falls back to the bridge process cwd).
   */
  workingDirectory?: string;
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
 * Validates and encodes the Pi session state. Legacy binding-migrated records
 * (`{ migratedFromBinding: true, workingDirectory? }`) decode to the versioned
 * shape; the module rewrites them with `update` on resume so the persisted
 * record converges to the canonical form.
 */
export const piCodingAgentSessionStateCodec: AgentSessionStateCodec<PiCodingAgentSessionStateV1> = {
  currentVersion: 1,

  decode(raw, _stateVersion, _context) {
    if (isRecord(raw) && raw.migratedFromBinding === true) {
      const workingDirectory = workingDirectoryOf(raw);
      return {
        version: 1,
        ...(workingDirectory !== undefined ? { workingDirectory } : {}),
      };
    }
    if (!isRecord(raw) || raw.version !== 1) {
      throw new Error("invalid Pi agent session state: expected a versioned state document");
    }
    if (
      raw.workingDirectory !== undefined &&
      (typeof raw.workingDirectory !== "string" || raw.workingDirectory.length === 0)
    ) {
      throw new Error("invalid Pi agent session state: workingDirectory must be a non-empty string when present");
    }
    return {
      version: 1,
      ...(workingDirectoryOf(raw) !== undefined ? { workingDirectory: workingDirectoryOf(raw) } : {}),
    };
  },

  encode(state) {
    return { ...state };
  },
};

function parseExtraArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function buildAdapter(
  config: PiCodingAgentConfig,
  agentSessionId: string,
  workingDirectory: string | undefined,
  allowedWorkingDirectoryRoots: string[] | undefined,
  sessionState: AgentSessionStateApi<PiCodingAgentSessionStateV1>,
): Promise<AgentAdapter> {
  const cwd = await resolveWorkingDirectory(workingDirectory, { allowedWorkingDirectoryRoots });
  return buildAdapterWithCwd(config, agentSessionId, cwd, sessionState);
}

function buildAdapterWithCwd(
  config: PiCodingAgentConfig,
  agentSessionId: string,
  cwd: string,
  sessionState: AgentSessionStateApi<PiCodingAgentSessionStateV1>,
): AgentAdapter {
  return new PiCodingAgentAdapter({
    agentSessionId,
    cwd,
    sessionDir:
      config.sessionDir ??
      process.env.PI_SESSION_DIR ??
      path.join(os.homedir(), ".config", "agent-bridge", "pi-sessions"),
    bin: config.bin ?? process.env.PI_BIN ?? "pi",
    model: config.model ?? process.env.PI_MODEL,
    extraArgs: config.extraArgs ?? parseExtraArgs(process.env.PI_RPC_EXTRA_ARGS),
    sessionState,
  });
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

export const piCodingAgentModule: AgentModule<PiCodingAgentConfig, PiCodingAgentSessionStateV1> = {
  type: "pi-coding-agent",
  sessionStateCodec: piCodingAgentSessionStateCodec,
  createConfigCollector: createPiCodingAgentConfigCollector,
  async createAgentSession({ config, common, agentSessionId, sessionState, workingDirectory, allowedWorkingDirectoryRoots }) {
    logger.info(`creating agent session ${agentSessionId} for channel ${common.channelName}`);
    const cwd = await resolveWorkingDirectory(workingDirectory, { allowedWorkingDirectoryRoots });
    const adapter = await buildAdapter(
      config,
      agentSessionId,
      workingDirectory,
      allowedWorkingDirectoryRoots,
      sessionState,
    );
    await sessionState.initialize({
      version: 1,
      ...(workingDirectory !== undefined && workingDirectory.trim() !== "" ? { workingDirectory: cwd } : {}),
    });
    return adapter;
  },
  async resumeAgentSession({ config, common, agentSessionId, sessionState, allowedWorkingDirectoryRoots }) {
    logger.info(`resuming agent session ${agentSessionId} for channel ${common.channelName}`);
    const state = await sessionState.read();
    const cwd = await resolveWorkingDirectory(state.workingDirectory, { allowedWorkingDirectoryRoots });
    const adapter = buildAdapterWithCwd(config, agentSessionId, cwd, sessionState);
    // Normalize legacy binding-migrated records into the canonical versioned
    // shape, storing the canonicalized working directory exactly like create
    // does (a no-op rewrite for already-versioned records; a bare `/new` with
    // no stored directory is left untouched).
    await sessionState.update((current) =>
      state.workingDirectory === undefined ? current : { ...current, workingDirectory: cwd },
    );
    return adapter;
  },
};
