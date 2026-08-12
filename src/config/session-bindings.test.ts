import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileChannelStateStore } from "./channel-state";
import {
  createFileSessionBindingStore,
  createSessionBindingStoreFacade,
  normalizeSessionBinding,
} from "./session-bindings";

describe("session bindings facade", () => {
  const tmpDirs: string[] = [];

  async function tmpFilePath(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-bindings-"));
    tmpDirs.push(dir);
    return path.join(dir, "bindings.json");
  }

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("normalizes legacy values into session bindings", () => {
    expect(normalizeSessionBinding("agent-1")).toEqual({ agentSessionId: "agent-1" });
    expect(normalizeSessionBinding("")).toBeNull();
    expect(
      normalizeSessionBinding({ agentSessionId: "agent-1", workingDirectory: "/tmp/a" }),
    ).toEqual({ agentSessionId: "agent-1", workingDirectory: "/tmp/a" });
    expect(normalizeSessionBinding(null)).toBeNull();
    expect(normalizeSessionBinding(42)).toBeNull();
    expect(normalizeSessionBinding({})).toBeNull();
    expect(normalizeSessionBinding({ agentSessionId: 42 })).toBeNull();
    expect(normalizeSessionBinding([])).toBeNull();
  });

  it("loads legacy string-format binding files without working directories", async () => {
    const file = await tmpFilePath();
    await writeFile(file, JSON.stringify({ "client-1": "agent-1" }), "utf8");

    const store = createFileSessionBindingStore(file);
    await expect(store.load()).resolves.toEqual({
      "client-1": { agentSessionId: "agent-1" },
    });
  });

  it("loads legacy object-format binding files and reconstructs working directories", async () => {
    const file = await tmpFilePath();
    await writeFile(
      file,
      JSON.stringify({
        "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
        "client-2": 42,
        "client-3": "opencode:def",
      }),
      "utf8",
    );

    const store = createFileSessionBindingStore(file);
    await expect(store.load()).resolves.toEqual({
      "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
      "client-3": { agentSessionId: "opencode:def" },
    });
  });

  it("persists pure string bindings and keeps working directories out of them", async () => {
    const file = await tmpFilePath();
    const store = createFileSessionBindingStore(file);

    await store.save({
      "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
      "client-2": { agentSessionId: "opencode:def" },
    });

    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(raw.version).toBe(2);
    expect(raw.bindings).toEqual({
      "client-1": "pi-coding-agent:abc",
      "client-2": "opencode:def",
    });
    const agentSessions = raw.agentSessions as Record<string, { state: Record<string, unknown> }>;
    expect(agentSessions["pi-coding-agent:abc"]!.state).toEqual({
      migratedFromBinding: true,
      workingDirectory: "/tmp/a",
    });
    expect(agentSessions["opencode:def"]!.state).toEqual({ migratedFromBinding: true });
  });

  it("round-trips working directories through save and load", async () => {
    const file = await tmpFilePath();
    const store = createFileSessionBindingStore(file);

    await store.save({
      "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
    });

    const fresh = createFileSessionBindingStore(file);
    await expect(fresh.load()).resolves.toEqual({
      "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
    });
  });

  it("merges saves with existing agent session records instead of overwriting them", async () => {
    const file = await tmpFilePath();
    const store = createFileSessionBindingStore(file);

    await store.save({
      "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
    });
    await store.save({
      "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
      "client-2": { agentSessionId: "opencode:def" },
    });

    const raw = JSON.parse(await readFile(file, "utf8")) as {
      bindings: Record<string, string>;
      agentSessions: Record<string, unknown>;
    };
    expect(raw.bindings).toEqual({
      "client-1": "pi-coding-agent:abc",
      "client-2": "opencode:def",
    });
    expect(Object.keys(raw.agentSessions).sort()).toEqual(["opencode:def", "pi-coding-agent:abc"]);
  });

  it("does not backfill working directories into module-owned record state", async () => {
    const file = await tmpFilePath();
    const createdAt = "2026-08-10T00:00:00.000Z";
    const channelStateStore = createFileChannelStateStore(file);
    await channelStateStore.save({
      version: 2,
      bindings: {},
      agentSessions: {
        "pi-coding-agent:abc": {
          recordVersion: 1,
          agentType: "pi-coding-agent",
          stateVersion: 2,
          createdAt,
          updatedAt: createdAt,
          state: { model: "gpt-5.6" },
        },
      },
    });

    const store = createSessionBindingStoreFacade(channelStateStore);
    await store.save({
      "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
    });

    const raw = JSON.parse(await readFile(file, "utf8")) as {
      agentSessions: Record<string, { state: Record<string, unknown> }>;
    };
    // Module-owned state is untouched: no workingDirectory backfill, no overwrite.
    expect(raw.agentSessions["pi-coding-agent:abc"]!.state).toEqual({ model: "gpt-5.6" });
  });

  it("keeps bindings with unknown agent prefixes without creating unknown-type records", async () => {
    const file = await tmpFilePath();
    const store = createFileSessionBindingStore(file);

    await store.save({
      "client-1": { agentSessionId: "agent-1" },
      "client-2": { agentSessionId: "pi-coding-agent:abc" },
    });

    const raw = JSON.parse(await readFile(file, "utf8")) as {
      bindings: Record<string, string>;
      agentSessions: Record<string, unknown>;
    };
    expect(raw.bindings).toEqual({
      "client-1": "agent-1",
      "client-2": "pi-coding-agent:abc",
    });
    // No `agentType: "unknown"` record is invented for the uninferable id.
    expect(Object.keys(raw.agentSessions)).toEqual(["pi-coding-agent:abc"]);
  });

  it("preserves existing unknown-type records across facade saves", async () => {
    const file = await tmpFilePath();
    const createdAt = "2026-08-10T00:00:00.000Z";
    const channelStateStore = createFileChannelStateStore(file);
    await channelStateStore.save({
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

    const store = createSessionBindingStoreFacade(channelStateStore);
    await store.save({
      "client-1": { agentSessionId: "agent-1", workingDirectory: "/tmp/legacy" },
      "client-2": { agentSessionId: "opencode:def" },
    });

    const raw = JSON.parse(await readFile(file, "utf8")) as {
      agentSessions: Record<string, { agentType: string; state: Record<string, unknown> }>;
    };
    // The pre-existing unknown record survives untouched.
    expect(raw.agentSessions["agent-1"]!.agentType).toBe("unknown");
    expect(raw.agentSessions["agent-1"]!.state).toEqual({
      migratedFromBinding: true,
      workingDirectory: "/tmp/legacy",
    });
    expect(raw.agentSessions["opencode:def"]!.agentType).toBe("opencode");
  });

  it("returns an empty map when the state file does not exist", async () => {
    const file = await tmpFilePath();
    const missing = path.join(path.dirname(file), "missing.json");

    const store = createFileSessionBindingStore(missing);
    await expect(store.load()).resolves.toEqual({});
  });
});
