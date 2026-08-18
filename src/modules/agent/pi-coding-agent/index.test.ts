import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRecord, AgentSessionStateCodec } from "../../../types";
import { createAgentSessionStateRegistry } from "../../../config/agent-session-state";
import { createInMemoryChannelStateStore } from "../../../config/channel-state";
import { piCodingAgentModule, type PiCodingAgentSessionStateV1 } from "./index";

const adapterOptions: Array<{
  agentSessionId: string;
  mode?: "create" | "resume";
  sessionState?: unknown;
  workingDirectory?: string;
  allowedWorkingDirectoryRoots?: string[];
  model?: string;
}> = [];

// The module falls back to process.env.PI_MODEL when no model is configured
// (index.ts: `config.model ?? process.env.PI_MODEL`). pi itself exports
// PI_MODEL into the environment of its bash-tool subprocesses, so running
// this suite from inside a pi session would leak the outer session's model
// into every assertion. Isolate it for the whole file.
const previousPiModel = process.env.PI_MODEL;
beforeEach(() => {
  delete process.env.PI_MODEL;
});
afterEach(() => {
  if (previousPiModel === undefined) {
    delete process.env.PI_MODEL;
  } else {
    process.env.PI_MODEL = previousPiModel;
  }
});

vi.mock("./adapter/pi-coding-agent-adapter", () => ({
  PiCodingAgentAdapter: class FakePiCodingAgentAdapter {
    constructor(options: {
      agentSessionId: string;
      mode?: "create" | "resume";
      sessionState?: unknown;
      workingDirectory?: string;
      allowedWorkingDirectoryRoots?: string[];
      model?: string;
    }) {
      adapterOptions.push(options);
    }
  },
}));

async function reserveHandle(id: string) {
  const store = createInMemoryChannelStateStore();
  const registry = createAgentSessionStateRegistry(store);
  const handle = await registry.reserve({
    agentSessionId: id,
    agentType: piCodingAgentModule.type,
    codec: piCodingAgentModule.sessionStateCodec,
  });
  return { store, handle };
}

async function openHandle(id: string, initialState: unknown) {
  const store = createInMemoryChannelStateStore();
  const registry = createAgentSessionStateRegistry(store);
  const record: AgentSessionRecord = {
    recordVersion: 1,
    agentType: piCodingAgentModule.type,
    stateVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: initialState,
  };
  await store.transaction((draft) => {
    draft.agentSessions[id] = record;
  });
  const handle = await registry.open({
    agentSessionId: id,
    agentType: piCodingAgentModule.type,
    codec: piCodingAgentModule.sessionStateCodec,
  });
  return { store, handle };
}

describe("Pi coding agent config collector", () => {
  it("shows a provider-qualified model example without making it the default value", async () => {
    const input = vi.fn(async () => "");
    const collector = piCodingAgentModule.createConfigCollector?.();

    const config = await collector?.collect({
      input,
      select: vi.fn(),
      confirm: vi.fn(),
      close: vi.fn(),
    });

    expect(input).toHaveBeenCalledWith("Pi model (leave empty for pi default)", {
      placeholder: "Example: azure-openai-responses/gpt-5.6-terra",
    });
    expect(config).toEqual({});
  });
});

describe("Pi coding agent module working directory", () => {
  let base: string;
  let projectDir: string;

  beforeEach(async () => {
    adapterOptions.length = 0;
    base = await mkdtemp(path.join(os.tmpdir(), "pi-module-wd-"));
    projectDir = path.join(base, "project a 中文");
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const common = { channelName: "test-channel", language: "en-US" as const };

  it("passes the raw requested working directory, roots and state handle to the adapter on create", async () => {
    const { handle } = await reserveHandle("pi-coding-agent:created");

    const adapter = await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:created",
      sessionState: handle,
      workingDirectory: projectDir,
      allowedWorkingDirectoryRoots: [base],
    });

    expect(adapter).toBeDefined();
    expect(adapterOptions.at(-1)).toEqual({
      agentSessionId: "pi-coding-agent:created",
      mode: "create",
      sessionState: handle,
      workingDirectory: projectDir,
      allowedWorkingDirectoryRoots: [base],
      sessionDir: expect.any(String),
      bin: expect.any(String),
      extraArgs: [],
    });
  });

  it("does not initialize or otherwise touch the session state on create", async () => {
    const { handle } = await reserveHandle("pi-coding-agent:created");

    await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:created",
      sessionState: handle,
      workingDirectory: projectDir,
    });

    // The module must leave state management to the adapter: the record is
    // only created when the adapter's start() initializes it.
    await expect(handle.read()).rejects.toThrow(/has not been initialized/);
  });

  it("omits workingDirectory for a bare /new and still passes the state handle", async () => {
    const { handle } = await reserveHandle("pi-coding-agent:bare");

    await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:bare",
      sessionState: handle,
    });

    expect(adapterOptions.at(-1)).toEqual(
      expect.objectContaining({
        agentSessionId: "pi-coding-agent:bare",
        sessionState: handle,
      }),
    );
    expect(adapterOptions.at(-1)?.workingDirectory).toBeUndefined();
  });

  it("passes the state handle and roots to the adapter on resume without reading state", async () => {
    const { handle } = await openHandle("pi-coding-agent:resumed", {
      version: 1,
      workingDirectory: projectDir,
      workingDirectorySource: "user",
    });

    const adapter = await piCodingAgentModule.resumeAgentSession!({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:resumed",
      sessionState: handle,
      allowedWorkingDirectoryRoots: [base],
    });

    expect(adapter).toBeDefined();
    expect(adapterOptions.at(-1)).toEqual(
      expect.objectContaining({
        agentSessionId: "pi-coding-agent:resumed",
        mode: "resume",
        sessionState: handle,
        allowedWorkingDirectoryRoots: [base],
      }),
    );
    expect(adapterOptions.at(-1)?.workingDirectory).toBeUndefined();
  });

  it("does not validate or canonicalize paths at the module level", async () => {
    // The module must pass the raw intent through: validation and
    // canonicalization are the adapter's job inside start().
    const missing = path.join(base, "does-not-exist");
    const { handle } = await reserveHandle("pi-coding-agent:raw");

    const adapter = await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:raw",
      sessionState: handle,
      workingDirectory: missing,
    });

    expect(adapter).toBeDefined();
    expect(adapterOptions.at(-1)?.workingDirectory).toBe(missing);
  });

  it("forwards channel config defaults into the adapter options", async () => {
    const { handle } = await reserveHandle("pi-coding-agent:config");

    await piCodingAgentModule.createAgentSession({
      config: {
        bin: "/custom/pi",
        sessionDir: "/custom/sessions",
        model: "anthropic/claude-sonnet-4-5",
        extraArgs: ["--thinking", "high"],
      },
      common,
      agentSessionId: "pi-coding-agent:config",
      sessionState: handle,
    });

    expect(adapterOptions.at(-1)).toEqual(
      expect.objectContaining({
        bin: "/custom/pi",
        sessionDir: "/custom/sessions",
        model: "anthropic/claude-sonnet-4-5",
        extraArgs: ["--thinking", "high"],
      }),
    );
  });

  it("applies the task model override with precedence override > config.model > PI_MODEL", async () => {
    const { handle: taskHandle } = await reserveHandle("pi-coding-agent:task-override");
    const { handle: configHandle } = await reserveHandle("pi-coding-agent:config-model");
    const { handle: envHandle } = await reserveHandle("pi-coding-agent:env-model");
    const previous = process.env.PI_MODEL;
    process.env.PI_MODEL = "env/model";

    try {
      // Task override beats config.model.
      await piCodingAgentModule.createAgentSession({
        config: { model: "config/model" },
        common,
        agentSessionId: "pi-coding-agent:task-override",
        sessionState: taskHandle,
        model: "task/model",
      });
      expect(adapterOptions.at(-1)?.model).toBe("task/model");

      // config.model beats the env fallback when no override is given.
      await piCodingAgentModule.createAgentSession({
        config: { model: "config/model" },
        common,
        agentSessionId: "pi-coding-agent:config-model",
        sessionState: configHandle,
      });
      expect(adapterOptions.at(-1)?.model).toBe("config/model");

      // PI_MODEL applies only when neither override nor config sets a model.
      await piCodingAgentModule.createAgentSession({
        config: {},
        common,
        agentSessionId: "pi-coding-agent:env-model",
        sessionState: envHandle,
      });
      expect(adapterOptions.at(-1)?.model).toBe("env/model");
    } finally {
      if (previous === undefined) delete process.env.PI_MODEL;
      else process.env.PI_MODEL = previous;
    }
  });

  it("applies env fallbacks for bin, sessionDir and extraArgs", async () => {
    const { handle } = await reserveHandle("pi-coding-agent:env");
    const previous = {
      bin: process.env.PI_BIN,
      sessionDir: process.env.PI_SESSION_DIR,
      extraArgs: process.env.PI_RPC_EXTRA_ARGS,
    };
    process.env.PI_BIN = "/env/pi";
    process.env.PI_SESSION_DIR = "/env/sessions";
    process.env.PI_RPC_EXTRA_ARGS = "--foo --bar";

    try {
      await piCodingAgentModule.createAgentSession({
        config: {},
        common,
        agentSessionId: "pi-coding-agent:env",
        sessionState: handle,
      });
    } finally {
      if (previous.bin === undefined) delete process.env.PI_BIN;
      else process.env.PI_BIN = previous.bin;
      if (previous.sessionDir === undefined) delete process.env.PI_SESSION_DIR;
      else process.env.PI_SESSION_DIR = previous.sessionDir;
      if (previous.extraArgs === undefined) delete process.env.PI_RPC_EXTRA_ARGS;
      else process.env.PI_RPC_EXTRA_ARGS = previous.extraArgs;
    }

    expect(adapterOptions.at(-1)).toEqual(
      expect.objectContaining({
        bin: "/env/pi",
        sessionDir: "/env/sessions",
        extraArgs: ["--foo", "--bar"],
      }),
    );
  });

  it("resolves extraArgs from config before falling back to the environment", async () => {
    const { handle } = await reserveHandle("pi-coding-agent:extra");
    const previous = process.env.PI_RPC_EXTRA_ARGS;
    process.env.PI_RPC_EXTRA_ARGS = "--env-only";

    try {
      await piCodingAgentModule.createAgentSession({
        config: { extraArgs: ["--config", "with space"] },
        common,
        agentSessionId: "pi-coding-agent:extra",
        sessionState: handle,
      });
    } finally {
      if (previous === undefined) delete process.env.PI_RPC_EXTRA_ARGS;
      else process.env.PI_RPC_EXTRA_ARGS = previous;
    }

    expect(adapterOptions.at(-1)?.extraArgs).toEqual(["--config", "with space"]);
  });
});

describe("Pi coding agent session state codec", () => {
  const codec = piCodingAgentModule.sessionStateCodec;

  it("round-trips a canonical V1 state", () => {
    const state: PiCodingAgentSessionStateV1 = {
      version: 1,
      workingDirectory: "/workspace/project",
      workingDirectorySource: "user",
    };
    expect(codec.decode(codec.encode(state), 1, { agentSessionId: "pi-coding-agent:x" })).toEqual(state);
  });

  it("rejects an invalid state document", () => {
    expect(() => codec.decode(null, 1, { agentSessionId: "x" })).toThrow(/expected a state document/);
    expect(() => codec.decode([], 1, { agentSessionId: "x" })).toThrow(/expected a state document/);
  });

  it("rejects an unsupported state version", () => {
    expect(() =>
      codec.decode({ version: 1, workingDirectory: "/a", workingDirectorySource: "user" }, 2, { agentSessionId: "x" }),
    ).toThrow(/unsupported Pi agent session state version 2/);
    expect(() =>
      codec.decode({ migratedFromBinding: true }, 0, { agentSessionId: "x" }),
    ).toThrow(/unsupported Pi agent session state version 0/);
  });

  it("rejects missing or malformed workingDirectory and source fields", () => {
    expect(() =>
      codec.decode({ version: 1, workingDirectorySource: "user" }, 1, { agentSessionId: "x" }),
    ).toThrow(/workingDirectory must be a non-empty string/);
    expect(() =>
      codec.decode({ version: 1, workingDirectory: "", workingDirectorySource: "user" }, 1, { agentSessionId: "x" }),
    ).toThrow(/workingDirectory must be a non-empty string/);
    expect(() =>
      codec.decode({ version: 1, workingDirectory: "/a", workingDirectorySource: "root" }, 1, { agentSessionId: "x" }),
    ).toThrow(/workingDirectorySource must be "default" or "user"/);
    expect(() =>
      codec.decode({ version: 1, workingDirectory: "/a" }, 1, { agentSessionId: "x" }),
    ).toThrow(/workingDirectorySource must be "default" or "user"/);
  });

  it("decodes a legacy migrated record with a working directory as user-sourced and marks it for rewrite", () => {
    const decoded = codec.decode(
      { migratedFromBinding: true, workingDirectory: "/workspace/legacy" },
      1,
      { agentSessionId: "pi-coding-agent:x" },
    );
    expect(decoded).toEqual({
      version: 1,
      workingDirectory: "/workspace/legacy",
      workingDirectorySource: "user",
      migratedFromBinding: true,
    });
  });

  it("decodes a legacy migrated record without a working directory to the current cwd as default", () => {
    const decoded = codec.decode({ migratedFromBinding: true }, 1, { agentSessionId: "pi-coding-agent:x" });
    expect(decoded).toEqual({
      version: 1,
      workingDirectory: process.cwd(),
      workingDirectorySource: "default",
      migratedFromBinding: true,
    });
  });

  it("encode never persists the decode-only migration marker", () => {
    const encoded = codec.encode({
      version: 1,
      workingDirectory: "/a",
      workingDirectorySource: "default",
      migratedFromBinding: true,
    });
    expect(encoded).toEqual({ version: 1, workingDirectory: "/a", workingDirectorySource: "default" });
  });

  it("encode rejects non-version-1 states before they can be persisted", () => {
    expect(() =>
      codec.encode({ version: 2, workingDirectory: "/a", workingDirectorySource: "user" } as never),
    ).toThrow(/version must be 1/);
  });

  it("encode rejects missing or empty workingDirectory", () => {
    expect(() =>
      codec.encode({ version: 1, workingDirectory: "", workingDirectorySource: "user" } as never),
    ).toThrow(/workingDirectory must be a non-empty string/);
    expect(() =>
      codec.encode({ version: 1, workingDirectory: undefined, workingDirectorySource: "user" } as never),
    ).toThrow(/workingDirectory must be a non-empty string/);
  });

  it("encode rejects an invalid workingDirectorySource", () => {
    expect(() =>
      codec.encode({ version: 1, workingDirectory: "/a", workingDirectorySource: "root" } as never),
    ).toThrow(/workingDirectorySource must be "default" or "user"/);
  });
});

describe("Pi agent session state handle validation", () => {
  it("initialize rejects a forged state and leaves the store empty", async () => {
    const { store, handle } = await reserveHandle("pi-coding-agent:forged-init");

    await expect(
      handle.initialize({ version: 2, workingDirectory: "/a", workingDirectorySource: "user" } as never),
    ).rejects.toThrow(/version must be 1/);

    const document = await store.load();
    expect(document.agentSessions["pi-coding-agent:forged-init"]).toBeUndefined();
  });

  it("replace rejects a forged state without changing the persisted record", async () => {
    const { store, handle } = await reserveHandle("pi-coding-agent:forged-replace");
    await handle.initialize({ version: 1, workingDirectory: "/a", workingDirectorySource: "user" });

    await expect(
      handle.replace({ version: 1, workingDirectory: "", workingDirectorySource: "user" } as never),
    ).rejects.toThrow(/workingDirectory must be a non-empty string/);

    const document = await store.load();
    expect(document.agentSessions["pi-coding-agent:forged-replace"]!.state).toEqual({
      version: 1,
      workingDirectory: "/a",
      workingDirectorySource: "user",
    });
  });

  it("update rejects a forged state produced by the updater without persisting it", async () => {
    const { store, handle } = await reserveHandle("pi-coding-agent:forged-update");
    await handle.initialize({ version: 1, workingDirectory: "/a", workingDirectorySource: "user" });

    await expect(
      handle.update(() => ({ version: 1, workingDirectory: "/a", workingDirectorySource: "root" } as never)),
    ).rejects.toThrow(/workingDirectorySource must be "default" or "user"/);

    const document = await store.load();
    expect(document.agentSessions["pi-coding-agent:forged-update"]!.state).toEqual({
      version: 1,
      workingDirectory: "/a",
      workingDirectorySource: "user",
    });
  });
});
