import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRecord, AgentSessionStateCodec } from "../../../types";
import { createAgentSessionStateRegistry } from "../../../config/agent-session-state";
import { createInMemoryChannelStateStore } from "../../../config/channel-state";
import { piCodingAgentModule, type PiCodingAgentSessionStateV1 } from "./index";

const adapterOptions: Array<{ agentSessionId: string; cwd: string; sessionState?: unknown }> = [];

vi.mock("./adapter/pi-coding-agent-adapter", () => ({
  PiCodingAgentAdapter: class FakePiCodingAgentAdapter {
    constructor(options: { agentSessionId: string; cwd: string; sessionState?: unknown }) {
      adapterOptions.push(options);
    }
  },
}));

function makeHandle(id: string, codec: AgentSessionStateCodec<PiCodingAgentSessionStateV1>) {
  const store = createInMemoryChannelStateStore();
  const registry = createAgentSessionStateRegistry(store);
  return { store, registry };
}

async function reserveHandle(id: string) {
  const { registry } = makeHandle(id, piCodingAgentModule.sessionStateCodec);
  return registry.reserve({
    agentSessionId: id,
    agentType: piCodingAgentModule.type,
    codec: piCodingAgentModule.sessionStateCodec,
  });
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

  it("passes the canonicalized working directory to the adapter and persists it in state on create", async () => {
    const expected = await realpath(projectDir);
    const sessionState = await reserveHandle("pi-coding-agent:created");

    const adapter = await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:created",
      sessionState,
      workingDirectory: projectDir,
    });

    expect(adapter).toBeDefined();
    expect(adapterOptions.at(-1)).toEqual(
      expect.objectContaining({
        agentSessionId: "pi-coding-agent:created",
        cwd: expected,
        sessionState,
      }),
    );
    await expect(sessionState.read()).resolves.toEqual({
      version: 1,
      workingDirectory: expected,
    });
  });

  it("passes the canonicalized working directory to the adapter on resume from state", async () => {
    const expected = await realpath(projectDir);
    const { handle } = await openHandle("pi-coding-agent:resumed", {
      version: 1,
      workingDirectory: expected,
    });

    await piCodingAgentModule.resumeAgentSession!({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:resumed",
      sessionState: handle,
    });

    expect(adapterOptions.at(-1)).toEqual(
      expect.objectContaining({
        agentSessionId: "pi-coding-agent:resumed",
        cwd: expected,
        sessionState: handle,
      }),
    );
  });

  it("uses the same canonicalization for create and resume", async () => {
    const expected = await realpath(projectDir);

    const createHandle = await reserveHandle("pi-coding-agent:created");
    await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:created",
      sessionState: createHandle,
      workingDirectory: projectDir,
    });

    const { handle } = await openHandle("pi-coding-agent:created", {
      version: 1,
      workingDirectory: expected,
    });
    await piCodingAgentModule.resumeAgentSession!({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:created",
      sessionState: handle,
    });

    expect(adapterOptions).toHaveLength(2);
    expect(adapterOptions[0]!.cwd).toBe(expected);
    expect(adapterOptions[1]!.cwd).toBe(expected);
  });

  it("defaults to process.cwd() and omits workingDirectory from state for a bare /new", async () => {
    const sessionState = await reserveHandle("pi-coding-agent:bare");

    await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:bare",
      sessionState,
    });

    expect(adapterOptions.at(-1)?.cwd).toBe(process.cwd());
    await expect(sessionState.read()).resolves.toEqual({ version: 1 });
  });

  it("rejects an invalid working directory on create with a clear error", async () => {
    const sessionState = await reserveHandle("pi-coding-agent:bad");

    await expect(
      piCodingAgentModule.createAgentSession({
        config: {},
        common,
        agentSessionId: "pi-coding-agent:bad",
        sessionState,
        workingDirectory: path.join(base, "missing"),
      }),
    ).rejects.toThrow(/invalid working directory.*no such file or directory/);

    expect(adapterOptions).toHaveLength(0);
  });

  it("allows a working directory inside an allowed root on create and resume", async () => {
    const root = path.join(base, "projects");
    const target = path.join(root, "project-a");
    await mkdir(target, { recursive: true });
    const expected = await realpath(target);

    const createHandle = await reserveHandle("pi-coding-agent:in-root");
    await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:in-root",
      sessionState: createHandle,
      workingDirectory: target,
      allowedWorkingDirectoryRoots: [root],
    });

    const { handle } = await openHandle("pi-coding-agent:in-root", {
      version: 1,
      workingDirectory: expected,
    });
    await piCodingAgentModule.resumeAgentSession!({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:in-root",
      sessionState: handle,
      allowedWorkingDirectoryRoots: [root],
    });

    expect(adapterOptions).toHaveLength(2);
    expect(adapterOptions[0]!.cwd).toBe(expected);
    expect(adapterOptions[1]!.cwd).toBe(expected);
  });

  it("rejects a working directory outside the allowed roots on create and resume", async () => {
    const root = path.join(base, "projects");
    const outside = path.join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });

    const createHandle = await reserveHandle("pi-coding-agent:outside");
    await expect(
      piCodingAgentModule.createAgentSession({
        config: {},
        common,
        agentSessionId: "pi-coding-agent:outside",
        sessionState: createHandle,
        workingDirectory: outside,
        allowedWorkingDirectoryRoots: [root],
      }),
    ).rejects.toThrow(/not inside an allowed root/);

    const { handle } = await openHandle("pi-coding-agent:outside", {
      version: 1,
      workingDirectory: outside,
    });
    await expect(
      piCodingAgentModule.resumeAgentSession!({
        config: {},
        common,
        agentSessionId: "pi-coding-agent:outside",
        sessionState: handle,
        allowedWorkingDirectoryRoots: [root],
      }),
    ).rejects.toThrow(/not inside an allowed root/);

    expect(adapterOptions).toHaveLength(0);
  });

  it("keeps the default cwd behavior for a bare /new even when roots are configured", async () => {
    const root = path.join(base, "projects");
    await mkdir(root, { recursive: true });

    const sessionState = await reserveHandle("pi-coding-agent:bare-rooted");
    await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:bare-rooted",
      sessionState,
      allowedWorkingDirectoryRoots: [root],
    });

    expect(adapterOptions.at(-1)?.cwd).toBe(process.cwd());
  });

  it("is permissive with an empty allowlist", async () => {
    const target = path.join(base, "anywhere");
    await mkdir(target, { recursive: true });

    const sessionState = await reserveHandle("pi-coding-agent:permissive");
    await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:permissive",
      sessionState,
      workingDirectory: target,
      allowedWorkingDirectoryRoots: [],
    });

    expect(adapterOptions.at(-1)?.cwd).toBe(await realpath(target));
  });

  it("recovers a legacy migrated record on resume and upgrades it to the versioned shape", async () => {
    const expected = await realpath(projectDir);
    const { store, handle } = await openHandle("pi-coding-agent:legacy", {
      migratedFromBinding: true,
      workingDirectory: projectDir,
    });

    await piCodingAgentModule.resumeAgentSession!({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:legacy",
      sessionState: handle,
    });

    expect(adapterOptions.at(-1)?.cwd).toBe(expected);

    const document = await store.load();
    expect(document.agentSessions["pi-coding-agent:legacy"]!.state).toEqual({
      version: 1,
      workingDirectory: expected,
    });
  });
});
