import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientSessionStateCodec } from "../types";
import { createFileChannelStateStore, createInMemoryChannelStateStore } from "./channel-state";
import {
  ClientSessionStateDecodeError,
  ClientSessionStateTypeMismatchError,
  ClientSessionStateUpdaterError,
  createClientSessionStateStore,
} from "./client-session-state";

interface FakeClientState {
  version: 1;
  defaultWorkingDirectory?: string;
}

const fakeClientStateCodec: ClientSessionStateCodec<FakeClientState> = {
  currentVersion: 1,
  decode(raw, stateVersion, _context) {
    if (stateVersion !== 1) {
      throw new Error(`unsupported state version ${stateVersion}`);
    }
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      if (record.version === 1) {
        return {
          version: 1,
          ...(typeof record.defaultWorkingDirectory === "string"
            ? { defaultWorkingDirectory: record.defaultWorkingDirectory }
            : {}),
        };
      }
    }
    throw new Error("invalid fake client session state");
  },
  encode(state) {
    return { ...state };
  },
};

function createStore(channelStateStore = createInMemoryChannelStateStore()) {
  return createClientSessionStateStore({
    channelStateStore,
    clientType: "feishu",
    codec: fakeClientStateCodec,
  });
}

describe("createClientSessionStateStore", () => {
  it("returns undefined from read when nothing was stored yet", async () => {
    const store = createStore();
    await expect(store.session("client-1").read()).resolves.toBeUndefined();
  });

  it("creates the record on the first update with the envelope fields", async () => {
    const channelStateStore = createInMemoryChannelStateStore();
    const store = createStore(channelStateStore);

    const next = await store
      .session("client-1")
      .update(() => ({ version: 1, defaultWorkingDirectory: "/tmp/project-a" }));

    expect(next).toEqual({ version: 1, defaultWorkingDirectory: "/tmp/project-a" });

    const document = await channelStateStore.load();
    const record = document.clientSessions["client-1"];
    expect(record).toMatchObject({
      recordVersion: 1,
      clientType: "feishu",
      stateVersion: 1,
    });
    expect(record!.createdAt).toBeTruthy();
    expect(record!.updatedAt).toBeTruthy();
    expect(record!.state).toEqual({ version: 1, defaultWorkingDirectory: "/tmp/project-a" });
  });

  it("round-trips state through update and read", async () => {
    const store = createStore();
    const handle = store.session("client-1");

    await handle.update(() => ({ version: 1, defaultWorkingDirectory: "/tmp/project-a" }));
    await expect(handle.read()).resolves.toEqual({
      version: 1,
      defaultWorkingDirectory: "/tmp/project-a",
    });
  });

  it("passes the current state to the updater and preserves createdAt", async () => {
    const channelStateStore = createInMemoryChannelStateStore();
    const store = createStore(channelStateStore);
    const handle = store.session("client-1");

    await handle.update(() => ({ version: 1, defaultWorkingDirectory: "/tmp/a" }));
    const createdAt = (await channelStateStore.load()).clientSessions["client-1"]!.createdAt;

    const seen: Array<FakeClientState | undefined> = [];
    await handle.update((current) => {
      seen.push(current === undefined ? undefined : { ...current });
      return { version: 1, defaultWorkingDirectory: "/tmp/b" };
    });

    expect(seen).toEqual([{ version: 1, defaultWorkingDirectory: "/tmp/a" }]);
    const record = (await channelStateStore.load()).clientSessions["client-1"]!;
    expect(record.createdAt).toBe(createdAt);
    expect(record.state).toEqual({ version: 1, defaultWorkingDirectory: "/tmp/b" });
  });

  it("keeps sessions isolated from each other", async () => {
    const store = createStore();
    await store.session("client-1").update(() => ({ version: 1, defaultWorkingDirectory: "/tmp/a" }));

    await expect(store.session("client-2").read()).resolves.toBeUndefined();
  });

  it("serializes concurrent updates so no change is lost", async () => {
    const channelStateStore = createInMemoryChannelStateStore();
    let release: () => void = () => undefined;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = createClientSessionStateStore({
      channelStateStore: {
        ...channelStateStore,
        async transaction(updater) {
          await gate;
          return channelStateStore.transaction(updater);
        },
      },
      clientType: "feishu",
      codec: fakeClientStateCodec,
    });
    const handle = store.session("client-1");

    const first = handle.update((current) => ({
      version: 1,
      defaultWorkingDirectory: current?.defaultWorkingDirectory ?? "/tmp/a",
    }));
    const second = handle.update((current) => ({
      version: 1,
      defaultWorkingDirectory: `${current?.defaultWorkingDirectory ?? "none"}->b`,
    }));
    release();
    gate = Promise.resolve();
    await Promise.all([first, second]);

    await expect(handle.read()).resolves.toEqual({
      version: 1,
      defaultWorkingDirectory: "/tmp/a->b",
    });
  });

  it("rejects a record owned by a different client type", async () => {
    const channelStateStore = createInMemoryChannelStateStore();
    await createClientSessionStateStore({
      channelStateStore,
      clientType: "wecom",
      codec: fakeClientStateCodec,
    })
      .session("client-1")
      .update(() => ({ version: 1 }));

    const store = createStore(channelStateStore);
    await expect(store.session("client-1").read()).rejects.toThrow(ClientSessionStateTypeMismatchError);
    await expect(
      store.session("client-1").update(() => ({ version: 1 })),
    ).rejects.toThrow(ClientSessionStateTypeMismatchError);
  });

  it("surfaces codec decode failures as decode errors", async () => {
    const channelStateStore = createInMemoryChannelStateStore();
    await channelStateStore.transaction((draft) => {
      const now = new Date().toISOString();
      draft.clientSessions["client-1"] = {
        recordVersion: 1,
        clientType: "feishu",
        stateVersion: 9,
        createdAt: now,
        updatedAt: now,
        state: { version: 9 },
      };
    });

    const store = createStore(channelStateStore);
    await expect(store.session("client-1").read()).rejects.toThrow(ClientSessionStateDecodeError);
  });

  it("rejects asynchronous updaters", async () => {
    const store = createStore();
    await expect(
      store.session("client-1").update((async () => ({ version: 1 })) as never),
    ).rejects.toThrow(ClientSessionStateUpdaterError);
  });

  it("rejects non-JSON-compatible encoded state before persisting", async () => {
    const badCodec: ClientSessionStateCodec<{ version: 1; bad?: unknown }> = {
      currentVersion: 1,
      decode: () => ({ version: 1 }),
      encode: (state) => state,
    };
    const channelStateStore = createInMemoryChannelStateStore();
    const store = createClientSessionStateStore({
      channelStateStore,
      clientType: "feishu",
      codec: badCodec,
    });

    await expect(
      store.session("client-1").update(() => ({ version: 1, bad: undefined })),
    ).rejects.toThrow(/undefined/);
    expect((await channelStateStore.load()).clientSessions["client-1"]).toBeUndefined();
  });

  it("does not let a mutating updater reach the stored document", async () => {
    const channelStateStore = createInMemoryChannelStateStore();
    const store = createStore(channelStateStore);
    const handle = store.session("client-1");

    await handle.update(() => ({ version: 1, defaultWorkingDirectory: "/tmp/a" }));
    await handle.update((current) => {
      (current as { defaultWorkingDirectory?: string }).defaultWorkingDirectory = "/tmp/mutated";
      return { version: 1, defaultWorkingDirectory: "/tmp/b" };
    });

    expect(
      (await channelStateStore.load()).clientSessions["client-1"]!.state,
    ).toEqual({ version: 1, defaultWorkingDirectory: "/tmp/b" });
  });

  it("persists records in the channel state file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-client-state-"));
    try {
      const file = path.join(dir, "state.json");
      const store = createStore(createFileChannelStateStore(file));

      await store
        .session("client-1")
        .update(() => ({ version: 1, defaultWorkingDirectory: "/tmp/project-a" }));

      const raw = JSON.parse(await readFile(file, "utf8")) as {
        version: number;
        clientSessions: Record<string, { clientType: string; state: unknown }>;
      };
      expect(raw.version).toBe(3);
      expect(raw.clientSessions["client-1"]!.clientType).toBe("feishu");
      expect(raw.clientSessions["client-1"]!.state).toEqual({
        version: 1,
        defaultWorkingDirectory: "/tmp/project-a",
      });

      // A fresh store instance over the same file sees the persisted state.
      const reloaded = createStore(createFileChannelStateStore(file));
      await expect(reloaded.session("client-1").read()).resolves.toEqual({
        version: 1,
        defaultWorkingDirectory: "/tmp/project-a",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("upgrades a v2 channel state file to v3 when a client session record is committed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-client-state-v2-"));
    try {
      const file = path.join(dir, "state.json");
      const createdAt = "2026-08-10T00:00:00.000Z";
      await writeFile(
        file,
        JSON.stringify({
          version: 2,
          bindings: { "client-1": "pi-coding-agent:abc" },
          agentSessions: {
            "pi-coding-agent:abc": {
              recordVersion: 1,
              agentType: "pi-coding-agent",
              stateVersion: 1,
              createdAt,
              updatedAt: createdAt,
              state: { migratedFromBinding: true },
            },
          },
        }),
        "utf8",
      );

      const store = createStore(createFileChannelStateStore(file));
      // Load-only keeps the file untouched (in-memory upgrade, no write-through).
      await store.session("client-1").read();
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 2 });

      await store
        .session("client-1")
        .update(() => ({ version: 1, defaultWorkingDirectory: "/tmp/project-a" }));

      const raw = JSON.parse(await readFile(file, "utf8")) as {
        version: number;
        bindings: Record<string, string>;
        clientSessions: Record<string, { clientType: string }>;
      };
      expect(raw.version).toBe(3);
      // Pre-existing v2 content survives the upgrade.
      expect(raw.bindings).toEqual({ "client-1": "pi-coding-agent:abc" });
      expect(raw.clientSessions["client-1"]!.clientType).toBe("feishu");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
