import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMigratedAgentRecord,
  ChannelStateFormatError,
  CHANNEL_STATE_VERSION,
  createFileChannelStateStore,
  emptyChannelState,
  getChannelStateStorePath,
  inferAgentType,
  normalizeChannelState,
} from "./channel-state";

describe("channel state helpers", () => {
  it("produces an empty versioned state", () => {
    expect(emptyChannelState()).toEqual({
      version: 2,
      bindings: {},
      agentSessions: {},
    });
  });

  it("infers agent module types from known id prefixes", () => {
    expect(inferAgentType("pi-coding-agent:abc")).toBe("pi-coding-agent");
    expect(inferAgentType("opencode:abc")).toBe("opencode");
    expect(inferAgentType("agent-1")).toBeNull();
    expect(inferAgentType("")).toBeNull();
  });

  it("builds migration records for known prefixes and returns null for unknown ones", () => {
    const record = buildMigratedAgentRecord("pi-coding-agent:abc", "/tmp/a");
    expect(record).toMatchObject({
      recordVersion: 1,
      agentType: "pi-coding-agent",
      stateVersion: 1,
    });
    expect(record!.state).toEqual({ migratedFromBinding: true, workingDirectory: "/tmp/a" });
    expect(record!.createdAt).toBeTruthy();
    expect(record!.updatedAt).toBeTruthy();

    const minimal = buildMigratedAgentRecord("opencode:def");
    expect(minimal!.state).toEqual({ migratedFromBinding: true });

    // Unknown prefixes never produce records; the binding is kept instead.
    expect(buildMigratedAgentRecord("agent-1")).toBeNull();
  });

  it("builds a per-channel state path with an encoded channel name", () => {
    const p = getChannelStateStorePath("my channel/1");
    expect(p.endsWith(".json")).toBe(true);
    expect(p).toContain(encodeURIComponent("my channel/1"));
  });
});

describe("normalizeChannelState", () => {
  it("migrates legacy string bindings into pure bindings plus minimal records", () => {
    const { state, report } = normalizeChannelState({
      "client-1": "pi-coding-agent:abc",
      "client-2": "opencode:def",
    });

    expect(report.migrated).toBe(true);
    expect(report.keptBindings).toBe(2);
    expect(report.createdAgentRecords).toBe(2);
    expect(state.bindings).toEqual({
      "client-1": "pi-coding-agent:abc",
      "client-2": "opencode:def",
    });
    expect(state.agentSessions["pi-coding-agent:abc"]).toMatchObject({
      recordVersion: 1,
      agentType: "pi-coding-agent",
      stateVersion: 1,
    });
    expect(state.agentSessions["pi-coding-agent:abc"]!.state).toEqual({ migratedFromBinding: true });
    expect(state.agentSessions["opencode:def"]!.agentType).toBe("opencode");
  });

  it("moves workingDirectory from legacy object bindings into agent session state", () => {
    const { state, report } = normalizeChannelState({
      "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
      "client-2": "opencode:def",
    });

    expect(report.keptBindings).toBe(2);
    expect(report.metadataConflicts).toEqual([]);
    expect(state.bindings).toEqual({
      "client-1": "pi-coding-agent:abc",
      "client-2": "opencode:def",
    });
    expect(state.agentSessions["pi-coding-agent:abc"]!.state).toEqual({
      migratedFromBinding: true,
      workingDirectory: "/tmp/a",
    });
  });

  it("passes a versioned document through with validated entries", () => {
    const createdAt = "2026-08-10T00:00:00.000Z";
    const { state, report } = normalizeChannelState({
      version: 2,
      bindings: { "client-1": "pi-coding-agent:abc" },
      agentSessions: {
        "pi-coding-agent:abc": {
          recordVersion: 1,
          agentType: "pi-coding-agent",
          stateVersion: 3,
          createdAt,
          updatedAt: createdAt,
          state: { model: "gpt-5.6", workingDirectory: "/tmp/a" },
        },
      },
    });

    expect(report.migrated).toBe(false);
    expect(report.droppedBindings).toEqual([]);
    expect(report.droppedAgentRecords).toEqual([]);
    expect(state).toEqual({
      version: 2,
      bindings: { "client-1": "pi-coding-agent:abc" },
      agentSessions: {
        "pi-coding-agent:abc": {
          recordVersion: 1,
          agentType: "pi-coding-agent",
          stateVersion: 3,
          createdAt,
          updatedAt: createdAt,
          state: { model: "gpt-5.6", workingDirectory: "/tmp/a" },
        },
      },
    });
  });

  it("creates one record for an agent id shared by multiple clients", () => {
    const { state, report } = normalizeChannelState({
      "client-1": "pi-coding-agent:abc",
      "client-2": "pi-coding-agent:abc",
    });

    expect(state.bindings).toEqual({
      "client-1": "pi-coding-agent:abc",
      "client-2": "pi-coding-agent:abc",
    });
    expect(Object.keys(state.agentSessions)).toEqual(["pi-coding-agent:abc"]);
    expect(report.createdAgentRecords).toBe(1);
  });

  it("enriches a shared agent record when a later binding adds a working directory", () => {
    const { state, report } = normalizeChannelState({
      "client-1": "pi-coding-agent:abc",
      "client-2": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
    });

    expect(state.agentSessions["pi-coding-agent:abc"]!.state).toEqual({
      migratedFromBinding: true,
      workingDirectory: "/tmp/a",
    });
    expect(report.metadataConflicts).toEqual([]);
  });

  it("keeps the first workingDirectory on conflict deterministically", () => {
    const first = normalizeChannelState({
      "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
      "client-2": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/b" },
    });
    const reversed = normalizeChannelState({
      "client-2": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/b" },
      "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
    });

    expect(first.state.agentSessions["pi-coding-agent:abc"]!.state).toEqual({
      migratedFromBinding: true,
      workingDirectory: "/tmp/a",
    });
    expect(first.report.metadataConflicts).toEqual([
      {
        agentSessionId: "pi-coding-agent:abc",
        field: "workingDirectory",
        kept: "/tmp/a",
        discarded: "/tmp/b",
      },
    ]);
    expect(first.report.warnings.length).toBe(1);

    // Reversing insertion order flips the winner, but the rule stays: first wins.
    expect(reversed.state.agentSessions["pi-coding-agent:abc"]!.state).toEqual({
      migratedFromBinding: true,
      workingDirectory: "/tmp/b",
    });
    expect(reversed.report.metadataConflicts[0]).toMatchObject({ kept: "/tmp/b", discarded: "/tmp/a" });
  });

  it("keeps bindings with unknown agent prefixes but skips their records", () => {
    const { state, report } = normalizeChannelState({
      "client-1": "agent-1",
      "client-2": "opencode:def",
    });

    expect(state.bindings["client-1"]).toBe("agent-1");
    expect(state.agentSessions["agent-1"]).toBeUndefined();
    expect(report.skippedAgentRecords).toEqual([
      {
        agentSessionId: "agent-1",
        clientSessionIds: ["client-1"],
        reason: expect.stringContaining("cannot infer agent module type") as unknown as string,
      },
    ]);
    expect(report.warnings.some((w) => w.includes("agent-1"))).toBe(true);
    expect(state.agentSessions["opencode:def"]).toBeDefined();
  });

  it("drops unsupported legacy binding values and reports them", () => {
    const { state, report } = normalizeChannelState({
      "client-1": 42,
      "client-2": [],
      "client-3": {},
      "client-4": { agentSessionId: "" },
      "client-5": "pi-coding-agent:abc",
    });

    expect(state.bindings).toEqual({ "client-5": "pi-coding-agent:abc" });
    expect(report.droppedBindings.map((e) => e.clientSessionId).sort()).toEqual([
      "client-1",
      "client-2",
      "client-3",
      "client-4",
    ]);
  });

  it("rejects invalid top-level shapes", () => {
    for (const raw of [null, 42, "text", []]) {
      expect(() => normalizeChannelState(raw)).toThrow(ChannelStateFormatError);
    }
  });

  it("rejects any non-supported top-level version value instead of guessing", () => {
    expect(() =>
      normalizeChannelState({ version: 3, bindings: {}, agentSessions: {} }),
    ).toThrow(/unsupported channel state version 3/);
    expect(() =>
      normalizeChannelState({ version: "2", bindings: {}, agentSessions: {} }),
    ).toThrow(ChannelStateFormatError);
    expect(() =>
      normalizeChannelState({ version: null, bindings: {}, agentSessions: {} }),
    ).toThrow(ChannelStateFormatError);
  });

  it("fails safely when a legacy binding key is literally named 'version'", () => {
    // A genuine legacy map could have a client id "version". Treating it as a
    // versioned document would produce a garbage `version -> agent` binding, so
    // the loader refuses to guess (fail-safe) and asks for manual migration.
    expect(() =>
      normalizeChannelState({ version: "pi-coding-agent:abc", "client-1": "opencode:def" }),
    ).toThrow(ChannelStateFormatError);
  });

  it("preserves existing records with unknown agent types in versioned documents", () => {
    const createdAt = "2026-08-10T00:00:00.000Z";
    const { state, report } = normalizeChannelState({
      version: 2,
      bindings: { "client-1": "agent-1" },
      agentSessions: {
        "agent-1": {
          recordVersion: 1,
          agentType: "unknown",
          stateVersion: 1,
          createdAt,
          updatedAt: createdAt,
          state: { migratedFromBinding: true, workingDirectory: "/tmp/legacy" },
        },
      },
    });

    expect(report.droppedAgentRecords).toEqual([]);
    expect(state.bindings).toEqual({ "client-1": "agent-1" });
    expect(state.agentSessions["agent-1"]).toMatchObject({ agentType: "unknown" });
  });

  it("requires a valid bindings and agentSessions object on versioned documents", () => {
    expect(() => normalizeChannelState({ version: 2, agentSessions: {} })).toThrow(
      /missing a valid 'bindings'/,
    );
    expect(() => normalizeChannelState({ version: 2, bindings: [] })).toThrow(
      /missing a valid 'bindings'/,
    );
    expect(() => normalizeChannelState({ version: 2, bindings: {} })).toThrow(
      /missing a valid 'agentSessions'/,
    );
  });

  it("drops invalid entries inside a versioned document and reports them", () => {
    const createdAt = "2026-08-10T00:00:00.000Z";
    const { state, report } = normalizeChannelState({
      version: 2,
      bindings: {
        "client-1": "pi-coding-agent:abc",
        "client-2": 42,
        "client-3": "",
      },
      agentSessions: {
        "pi-coding-agent:abc": {
          recordVersion: 1,
          agentType: "pi-coding-agent",
          stateVersion: 1,
          createdAt,
          updatedAt: createdAt,
          state: { migratedFromBinding: true },
        },
        "bad-1": { recordVersion: 9, agentType: "pi-coding-agent" },
        "bad-2": { recordVersion: 1, agentType: "", stateVersion: 1, createdAt, updatedAt: createdAt, state: {} },
        "bad-3": "not-a-record",
      },
    });

    expect(state.bindings).toEqual({ "client-1": "pi-coding-agent:abc" });
    expect(Object.keys(state.agentSessions)).toEqual(["pi-coding-agent:abc"]);
    expect(report.droppedBindings.map((e) => e.clientSessionId).sort()).toEqual(["client-2", "client-3"]);
    expect(report.droppedAgentRecords.map((e) => e.agentSessionId).sort()).toEqual(["bad-1", "bad-2", "bad-3"]);
  });
});

describe("createFileChannelStateStore", () => {
  const tmpDirs: string[] = [];

  async function tmpFilePath(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-channel-state-"));
    tmpDirs.push(dir);
    return path.join(dir, "state.json");
  }

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("returns an empty state when the file does not exist", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    await expect(store.load()).resolves.toEqual(emptyChannelState());
  });

  it("round-trips a state document", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const state = {
      version: CHANNEL_STATE_VERSION as 2,
      bindings: { "client-1": "pi-coding-agent:abc" },
      agentSessions: {
        "pi-coding-agent:abc": buildMigratedAgentRecord("pi-coding-agent:abc", "/tmp/a"),
      },
    };

    await store.save(state);
    await expect(store.load()).resolves.toEqual(state);
  });

  it("migrates a legacy binding file on load without writing it back", async () => {
    const file = await tmpFilePath();
    await writeFile(
      file,
      JSON.stringify({ "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" } }),
      "utf8",
    );

    const store = createFileChannelStateStore(file);
    const state = await store.load();
    expect(state.bindings).toEqual({ "client-1": "pi-coding-agent:abc" });
    expect(state.agentSessions["pi-coding-agent:abc"]!.state).toEqual({
      migratedFromBinding: true,
      workingDirectory: "/tmp/a",
    });

    // The on-disk document stays untouched until a save happens.
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
    });
  });

  it("writes atomically and leaves no temp files behind", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const state = {
      version: CHANNEL_STATE_VERSION as 2,
      bindings: {},
      agentSessions: {},
    };

    await store.save(state);

    const dir = path.dirname(file);
    const entries = await readdir(dir);
    expect(entries).toEqual(["state.json"]);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(state);
  });

  it("cleans up the temp file when the atomic rename fails", async () => {
    const file = await tmpFilePath();
    // Make the destination an existing directory so rename fails (EISDIR).
    await mkdir(file);
    const store = createFileChannelStateStore(file);

    await expect(
      store.save({ version: CHANNEL_STATE_VERSION as 2, bindings: {}, agentSessions: {} }),
    ).rejects.toThrow();

    const entries = await readdir(path.dirname(file));
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });
});
