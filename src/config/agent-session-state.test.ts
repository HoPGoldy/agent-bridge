import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentSessionStateCodec,
  ChannelPersistentState,
  ChannelStateStore,
} from "../types";
import {
  AgentSessionStateConflictError,
  AgentSessionStateDecodeError,
  AgentSessionStateNotInitializedError,
  AgentSessionStateNotFoundError,
  AgentSessionStateRevokedError,
  AgentSessionStateTypeMismatchError,
  AgentSessionStateUpdaterError,
  createAgentSessionStateRegistry,
} from "./agent-session-state";
import { createFileChannelStateStore, emptyChannelState } from "./channel-state";
import { JsonCompatibilityError } from "./json-compat";
import { createSessionBindingStoreFacade } from "./session-bindings";

interface TestState {
  model?: string;
  count?: number;
  extra?: boolean;
}

function makeCodec<TState extends object>(
  currentVersion = 1,
): AgentSessionStateCodec<TState> {
  return {
    currentVersion,
    decode(raw, stateVersion) {
      if (stateVersion !== currentVersion) {
        throw new Error(`unsupported state version ${stateVersion}`);
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("invalid state payload");
      }
      return raw as TState;
    },
    encode(state) {
      return { ...state };
    },
  };
}

const PI_TYPE = "pi-coding-agent";
const testCodec = makeCodec<TestState>(1);

/** In-memory ChannelStateStore with injectable write failures. */
class InMemoryStore implements ChannelStateStore {
  state: ChannelPersistentState = emptyChannelState();
  failNextWrite = false;
  #tail: Promise<void> = Promise.resolve();

  load(): Promise<ChannelPersistentState> {
    return Promise.resolve(this.state);
  }

  save(state: ChannelPersistentState): Promise<void> {
    return this.transaction(() => state);
  }

  transaction<T>(
    updater: (draft: ChannelPersistentState) => T | ChannelPersistentState,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = this.#tail.then(async () => {
        if (this.failNextWrite) {
          this.failNextWrite = false;
          throw new Error("injected write failure");
        }
        const draft = JSON.parse(JSON.stringify(this.state)) as ChannelPersistentState;
        const result = updater(draft);
        const isState =
          result !== null &&
          typeof result === "object" &&
          (result as { version?: unknown }).version === 2 &&
          typeof (result as { bindings?: unknown }).bindings === "object" &&
          typeof (result as { agentSessions?: unknown }).agentSessions === "object";
        this.state = isState ? (result as ChannelPersistentState) : draft;
        return result as T;
      });
      const handled = run.then(
        () => undefined,
        () => undefined,
      );
      this.#tail = handled;
      run.then(resolve, reject);
    });
  }

  flush(): Promise<void> {
    return this.#tail;
  }
}

/**
 * Store whose `load()` results are parked until explicitly released, so
 * reserve/open race windows can be interleaved deterministically (microtask
 * handshakes only, no timers or sleeps). Each parked load resolves with a
 * snapshot taken when `load()` was called, mirroring a real file read.
 */
class DeferredLoadStore implements ChannelStateStore {
  state: ChannelPersistentState = emptyChannelState();
  /** When true, the next `load()` call parks its result until explicitly released. */
  deferNextLoad = false;
  #pendingLoads: Array<(snapshot: ChannelPersistentState) => void> = [];
  #loadQueued: Array<() => void> = [];
  #tail: Promise<void> = Promise.resolve();

  load(): Promise<ChannelPersistentState> {
    const snapshot = JSON.parse(JSON.stringify(this.state)) as ChannelPersistentState;
    if (!this.deferNextLoad) {
      return Promise.resolve(snapshot);
    }
    this.deferNextLoad = false;
    return new Promise((resolve) => {
      this.#pendingLoads.push(() => resolve(snapshot));
      const queued = this.#loadQueued.splice(0);
      for (const notify of queued) {
        notify();
      }
    });
  }

  /** Resolves once a `load()` call is parked, without releasing it. */
  async waitForPendingLoad(): Promise<void> {
    while (this.#pendingLoads.length === 0) {
      await new Promise<void>((resolve) => this.#loadQueued.push(resolve));
    }
  }

  /** Releases (resolves) the next parked load. */
  releaseNextLoad(): void {
    const resolve = this.#pendingLoads.shift();
    if (!resolve) {
      throw new Error("no parked load to release");
    }
    resolve();
  }

  save(state: ChannelPersistentState): Promise<void> {
    return this.transaction(() => state);
  }

  transaction<T>(
    updater: (draft: ChannelPersistentState) => T | ChannelPersistentState,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = this.#tail.then(async () => {
        const draft = JSON.parse(JSON.stringify(this.state)) as ChannelPersistentState;
        const result = updater(draft);
        const isState =
          result !== null &&
          typeof result === "object" &&
          (result as { version?: unknown }).version === 2 &&
          typeof (result as { bindings?: unknown }).bindings === "object" &&
          typeof (result as { agentSessions?: unknown }).agentSessions === "object";
        this.state = isState ? (result as ChannelPersistentState) : draft;
        return result as T;
      });
      const handled = run.then(
        () => undefined,
        () => undefined,
      );
      this.#tail = handled;
      run.then(resolve, reject);
    });
  }

  flush(): Promise<void> {
    return this.#tail;
  }
}

describe("agent session state registry", () => {
  const tmpDirs: string[] = [];

  async function tmpFilePath(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-session-state-"));
    tmpDirs.push(dir);
    return path.join(dir, "state.json");
  }

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  async function reserveAndInitialize(
    registry: ReturnType<typeof createAgentSessionStateRegistry>,
    agentSessionId: string,
    initial: TestState = {},
    agentType = PI_TYPE,
  ) {
    const api = await registry.reserve({
      agentSessionId,
      agentType,
      codec: testCodec,
    });
    await api.initialize(initial);
    return api;
  }

  /** Codec whose encode returns the caller's object untouched (risky alias pattern). */
  const passthroughCodec: AgentSessionStateCodec<TestState> = {
    currentVersion: 1,
    decode(raw, stateVersion) {
      if (stateVersion !== 1) {
        throw new Error(`unsupported state version ${stateVersion}`);
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("invalid state payload");
      }
      return raw as TestState;
    },
    encode(state) {
      return state;
    },
  };

  it("initialize creates a versioned record envelope exactly once", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);

    const api = await registry.reserve({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });
    await api.initialize({ model: "gpt-5.6" });

    const record = (await store.load()).agentSessions["pi-coding-agent:abc"]!;
    expect(record.recordVersion).toBe(1);
    expect(record.agentType).toBe(PI_TYPE);
    expect(record.stateVersion).toBe(1);
    expect(record.state).toEqual({ model: "gpt-5.6" });
    expect(typeof record.createdAt).toBe("string");
    expect(record.createdAt.length).toBeGreaterThan(0);
    expect(typeof record.updatedAt).toBe("string");

    await expect(api.initialize({ model: "other" })).rejects.toThrow(
      AgentSessionStateConflictError,
    );
    // The first value is untouched.
    await expect(api.read()).resolves.toEqual({ model: "gpt-5.6" });
  });

  it("read/replace/update fail before initialize with a clear error", async () => {
    const store = new InMemoryStore();
    const registry = createAgentSessionStateRegistry(store);

    const api = await registry.reserve({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });

    await expect(api.read()).rejects.toThrow(AgentSessionStateNotInitializedError);
    await expect(api.replace({ model: "x" })).rejects.toThrow(
      AgentSessionStateNotInitializedError,
    );
    await expect(api.update((s) => ({ ...s, count: 1 }))).rejects.toThrow(
      AgentSessionStateNotInitializedError,
    );
    // Nothing was persisted by the failed attempts.
    expect(store.state.agentSessions).toEqual({});
  });

  it("reserve rejects duplicate ids and concurrent reserves race safely", async () => {
    const store = new InMemoryStore();
    const registry = createAgentSessionStateRegistry(store);

    const results = await Promise.allSettled([
      registry.reserve({
        agentSessionId: "pi-coding-agent:abc",
        agentType: PI_TYPE,
        codec: testCodec,
      }),
      registry.reserve({
        agentSessionId: "pi-coding-agent:abc",
        agentType: PI_TYPE,
        codec: testCodec,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      AgentSessionStateConflictError,
    );

    // The winner's handle works; the loser never created a record.
    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof registry.reserve>>>).value;
    await winner.initialize({ model: "gpt-5.6" });
    expect(store.state.agentSessions["pi-coding-agent:abc"]!.state).toEqual({
      model: "gpt-5.6",
    });
  });

  it("reserve rejects ids that already have a persisted record", async () => {
    const store = new InMemoryStore();
    const registry = createAgentSessionStateRegistry(store);

    await reserveAndInitialize(registry, "pi-coding-agent:abc", { model: "x" });
    await expect(
      registry.reserve({
        agentSessionId: "pi-coding-agent:abc",
        agentType: PI_TYPE,
        codec: testCodec,
      }),
    ).rejects.toThrow(AgentSessionStateConflictError);
  });

  it("open fails for missing sessions, wrong agent types, and undecodable state", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);

    await reserveAndInitialize(registry, "pi-coding-agent:abc", { model: "x" });

    await expect(
      registry.open({
        agentSessionId: "missing",
        agentType: PI_TYPE,
        codec: testCodec,
      }),
    ).rejects.toThrow(AgentSessionStateNotFoundError);

    await expect(
      registry.open({
        agentSessionId: "pi-coding-agent:abc",
        agentType: "opencode",
        codec: testCodec,
      }),
    ).rejects.toThrow(AgentSessionStateTypeMismatchError);

    // A codec whose currentVersion differs from the stored stateVersion fails decode.
    const codecV2 = makeCodec<TestState>(2);
    await expect(
      registry.open({
        agentSessionId: "pi-coding-agent:abc",
        agentType: PI_TYPE,
        codec: codecV2,
      }),
    ).rejects.toThrow(AgentSessionStateDecodeError);
  });

  it("replace and update persist state and bump stateVersion/updatedAt", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);

    const api = await reserveAndInitialize(registry, "pi-coding-agent:abc", { model: "a" });
    const before = (await store.load()).agentSessions["pi-coding-agent:abc"]!;

    await api.replace({ model: "b", count: 1 });
    let record = (await store.load()).agentSessions["pi-coding-agent:abc"]!;
    expect(record.state).toEqual({ model: "b", count: 1 });
    expect(record.stateVersion).toBe(1);
    expect(record.updatedAt >= before.updatedAt).toBe(true);
    expect(record.createdAt).toBe(before.createdAt);

    const returned = await api.update((current) => ({ ...current, count: 2 }));
    expect(returned).toEqual({ model: "b", count: 2 });
    record = (await store.load()).agentSessions["pi-coding-agent:abc"]!;
    expect(record.state).toEqual({ model: "b", count: 2 });
  });

  it("does not lose updates across concurrent update calls", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);

    const api = await reserveAndInitialize(registry, "pi-coding-agent:abc", { count: 0 });
    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        api.update((current) => ({ ...current, count: (current.count ?? 0) + 1 })),
      ),
    );
    await expect(api.read()).resolves.toEqual({ count: 5 });
  });

  it("a throwing or asynchronous update updater writes nothing", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);

    const api = await reserveAndInitialize(registry, "pi-coding-agent:abc", { count: 0 });

    await expect(
      api.update(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(
      api.update(
        (async (current) => ({ ...current, count: 1 })) as unknown as (
          current: Readonly<TestState>,
        ) => TestState,
      ),
    ).rejects.toThrow(AgentSessionStateUpdaterError);

    await expect(api.read()).resolves.toEqual({ count: 0 });
  });

  it("revoke invalidates every live handle but allows reopening the session", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);

    const api = await reserveAndInitialize(registry, "pi-coding-agent:abc", { model: "x" });
    const second = await registry.open({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });

    await registry.revoke("pi-coding-agent:abc");

    await expect(api.read()).rejects.toThrow(AgentSessionStateRevokedError);
    await expect(api.replace({ model: "y" })).rejects.toThrow(AgentSessionStateRevokedError);
    await expect(api.update((s) => ({ ...s, count: 1 }))).rejects.toThrow(
      AgentSessionStateRevokedError,
    );
    await expect(api.flush()).rejects.toThrow(AgentSessionStateRevokedError);
    await expect(second.read()).rejects.toThrow(AgentSessionStateRevokedError);

    // The record survives revocation, so a fresh handle can resume the session.
    const reopened = await registry.open({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });
    await expect(reopened.read()).resolves.toEqual({ model: "x" });
    await reopened.update((s) => ({ ...s, count: 2 }));
  });

  it("delete revokes handles, removes the record, and is idempotent", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);

    const api = await reserveAndInitialize(registry, "pi-coding-agent:abc", { model: "x" });
    await registry.delete("pi-coding-agent:abc");

    expect((await store.load()).agentSessions["pi-coding-agent:abc"]).toBeUndefined();
    await expect(api.read()).rejects.toThrow(AgentSessionStateRevokedError);
    await expect(api.replace({ model: "y" })).rejects.toThrow(AgentSessionStateRevokedError);
    await expect(
      registry.open({
        agentSessionId: "pi-coding-agent:abc",
        agentType: PI_TYPE,
        codec: testCodec,
      }),
    ).rejects.toThrow(AgentSessionStateNotFoundError);

    // Idempotent: deleting again succeeds without touching anything else.
    await expect(registry.delete("pi-coding-agent:abc")).resolves.toBeUndefined();
  });

  it("multiple open handles share the latest state and sessions stay isolated", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);

    await reserveAndInitialize(registry, "pi-coding-agent:abc", { count: 0 });
    await reserveAndInitialize(registry, "opencode:def", { count: 0 }, "opencode");

    const handleA = await registry.open({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });
    const handleB = await registry.open({
      agentSessionId: "opencode:def",
      agentType: "opencode",
      codec: testCodec,
    });
    const handleA2 = await registry.open({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });

    await handleA.update((s) => ({ ...s, count: 5 }));
    await expect(handleA2.read()).resolves.toEqual({ count: 5 });
    // Session isolation: B is untouched by A's update.
    await expect(handleB.read()).resolves.toEqual({ count: 0 });
    expect(handleA.agentSessionId).toBe("pi-coding-agent:abc");
    expect(handleB.agentSessionId).toBe("opencode:def");
  });

  it("flush waits until pending writes are persisted", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);

    const api = await reserveAndInitialize(registry, "pi-coding-agent:abc", { model: "a" });
    await api.replace({ model: "b" });
    await api.flush();

    const raw = JSON.parse(await readFile(file, "utf8")) as {
      agentSessions: Record<string, { state: TestState }>;
    };
    expect(raw.agentSessions["pi-coding-agent:abc"]!.state).toEqual({ model: "b" });
  });

  it("rejects non-JSON-compatible state before anything is written", async () => {
    const store = new InMemoryStore();
    const registry = createAgentSessionStateRegistry(store);

    const api = await reserveAndInitialize(registry, "pi-coding-agent:abc", { model: "ok" });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(api.replace({ model: undefined })).rejects.toThrow(JsonCompatibilityError);
    await expect(api.replace({ model: 10n as unknown as string })).rejects.toThrow(
      JsonCompatibilityError,
    );
    await expect(api.replace({ model: NaN as unknown as string })).rejects.toThrow(
      JsonCompatibilityError,
    );
    await expect(api.replace({ model: (() => 1) as unknown as string })).rejects.toThrow(
      JsonCompatibilityError,
    );
    await expect(
      api.replace(cyclic as unknown as TestState),
    ).rejects.toThrow(JsonCompatibilityError);
    await expect(api.update((s) => ({ ...s, extra: undefined }))).rejects.toThrow(
      JsonCompatibilityError,
    );

    // The last valid state is untouched.
    await expect(api.read()).resolves.toEqual({ model: "ok" });
    expect(store.state.agentSessions["pi-coding-agent:abc"]!.state).toEqual({ model: "ok" });
  });

  it("an initialize that fails on write is retryable", async () => {
    const store = new InMemoryStore();
    const registry = createAgentSessionStateRegistry(store);

    const api = await registry.reserve({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });

    store.failNextWrite = true;
    await expect(api.initialize({ model: "x" })).rejects.toThrow(/injected write failure/);
    expect(store.state.agentSessions).toEqual({});

    await api.initialize({ model: "x" });
    await expect(api.read()).resolves.toEqual({ model: "x" });
  });

  it("facade saves and agent state writes share one queue and never overwrite each other", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);
    const facade = createSessionBindingStoreFacade(store);

    await reserveAndInitialize(registry, "pi-coding-agent:abc", { model: "gpt-5.6" });

    // Facade save must preserve the module-owned agent record.
    await facade.save({
      "client-1": { agentSessionId: "pi-coding-agent:abc", workingDirectory: "/tmp/a" },
    });
    await expect(
      registry.open({
        agentSessionId: "pi-coding-agent:abc",
        agentType: PI_TYPE,
        codec: testCodec,
      }).then((h) => h.read()),
    ).resolves.toEqual({ model: "gpt-5.6" });

    // A later agent-state write preserves the facade binding.
    const api = await registry.open({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });
    await api.update((s) => ({ ...s, extra: true }));
    const state = await store.load();
    expect(state.bindings).toEqual({ "client-1": "pi-coding-agent:abc" });
    expect(state.agentSessions["pi-coding-agent:abc"]!.state).toEqual({
      model: "gpt-5.6",
      extra: true,
    });

    // And the on-disk document agrees.
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      bindings: Record<string, string>;
      agentSessions: Record<string, { state: TestState }>;
    };
    expect(raw.bindings).toEqual({ "client-1": "pi-coding-agent:abc" });
    expect(raw.agentSessions["pi-coding-agent:abc"]!.state).toEqual({
      model: "gpt-5.6",
      extra: true,
    });
  });

  it("reserve rejects when the session is revoked during the reservation window", async () => {
    const store = new DeferredLoadStore();
    store.deferNextLoad = true;
    const registry = createAgentSessionStateRegistry(store);

    const reservePromise = registry.reserve({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });

    // Wait until reserve is parked on store.load(), then revoke, then release.
    await store.waitForPendingLoad();
    await registry.revoke("pi-coding-agent:abc");
    store.releaseNextLoad();

    // reserve must reject instead of returning a handle for a revoked session.
    await expect(reservePromise).rejects.toThrow(AgentSessionStateRevokedError);
    expect(store.state.agentSessions).toEqual({});

    // The registry is clean: a fresh reserve for the same id succeeds.
    const fresh = await registry.reserve({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });
    await fresh.initialize({ model: "ok" });
    await expect(fresh.read()).resolves.toEqual({ model: "ok" });
  });

  it("reserve rejects when the session is deleted during the reservation window", async () => {
    const store = new DeferredLoadStore();
    store.deferNextLoad = true;
    const registry = createAgentSessionStateRegistry(store);

    const reservePromise = registry.reserve({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });

    await store.waitForPendingLoad();
    await registry.delete("pi-coding-agent:abc");
    store.releaseNextLoad();

    await expect(reservePromise).rejects.toThrow(AgentSessionStateRevokedError);
    expect(store.state.agentSessions).toEqual({});
  });

  it("open rejects when the session is deleted during the open window", async () => {
    const store = new DeferredLoadStore();
    store.deferNextLoad = true;
    const registry = createAgentSessionStateRegistry(store);

    // Seed a persisted record directly so open's load snapshot contains it.
    const now = new Date().toISOString();
    store.state.agentSessions["pi-coding-agent:abc"] = {
      recordVersion: 1,
      agentType: PI_TYPE,
      stateVersion: 1,
      createdAt: now,
      updatedAt: now,
      state: { model: "x" },
    };

    const openPromise = registry.open({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });

    await store.waitForPendingLoad();
    await registry.delete("pi-coding-agent:abc");
    store.releaseNextLoad();

    // The open must reject even though its load snapshot still had the record:
    // the concurrent delete invalidated the session while open was parked.
    await expect(openPromise).rejects.toThrow(AgentSessionStateRevokedError);
    expect(store.state.agentSessions).toEqual({});
  });

  it("read results are defensive copies: mutating them never reaches the store", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);

    const api = await reserveAndInitialize(registry, "pi-coding-agent:abc", {
      model: "a",
      count: 1,
    });

    const first = await api.read();
    (first as TestState).model = "HACKED";
    (first as TestState).count = 999;

    await expect(api.read()).resolves.toEqual({ model: "a", count: 1 });
    expect((await store.load()).agentSessions["pi-coding-agent:abc"]!.state).toEqual({
      model: "a",
      count: 1,
    });

    // The object passed to replace is not aliased either.
    const replacement: TestState = { model: "b" };
    await api.replace(replacement);
    replacement.model = "HACKED-AGAIN";
    await expect(api.read()).resolves.toEqual({ model: "b" });
  });

  it("update return values are defensive copies even with a pass-through codec", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);

    const api = await registry.reserve({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: passthroughCodec,
    });
    const initial: TestState = { model: "a", count: 1 };
    await api.initialize(initial);
    // The object passed to initialize is not aliased either.
    initial.model = "MUTATED";
    await expect(api.read()).resolves.toEqual({ model: "a", count: 1 });

    const returned = await api.update((current) => ({ ...current, count: 2 }));
    (returned as TestState).model = "HACKED";
    (returned as TestState).count = 999;

    await expect(api.read()).resolves.toEqual({ model: "a", count: 2 });
    expect((await store.load()).agentSessions["pi-coding-agent:abc"]!.state).toEqual({
      model: "a",
      count: 2,
    });
  });

  it("a codec that mutates its decode input cannot corrupt the persisted state", async () => {
    const store = new InMemoryStore();
    const registry = createAgentSessionStateRegistry(store);

    const mutatingCodec: AgentSessionStateCodec<TestState> = {
      currentVersion: 1,
      decode(raw, stateVersion) {
        if (stateVersion !== 1) {
          throw new Error(`unsupported state version ${stateVersion}`);
        }
        if (raw !== null && typeof raw === "object") {
          (raw as TestState).model = "MUTATED";
          (raw as TestState).count = 999;
        }
        return raw as TestState;
      },
      encode(state) {
        return { ...state };
      },
    };

    await reserveAndInitialize(registry, "pi-coding-agent:abc", { model: "orig", count: 1 });

    // Opening and reading with the mutating codec must not corrupt the document.
    const handle = await registry.open({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: mutatingCodec,
    });
    await handle.read();

    expect(store.state.agentSessions["pi-coding-agent:abc"]!.state).toEqual({
      model: "orig",
      count: 1,
    });

    // A clean handle still reads the original state.
    const clean = await registry.open({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: testCodec,
    });
    await expect(clean.read()).resolves.toEqual({ model: "orig", count: 1 });
  });

  it("defensive copies keep explicit JSON semantics for shared references and null prototypes", async () => {
    const file = await tmpFilePath();
    const store = createFileChannelStateStore(file);
    const registry = createAgentSessionStateRegistry(store);

    const api = await registry.reserve({
      agentSessionId: "pi-coding-agent:abc",
      agentType: PI_TYPE,
      codec: passthroughCodec,
    });

    const shared = { inner: 1 };
    await api.initialize({
      model: "a",
      first: shared,
      second: shared,
      nullProto: Object.assign(Object.create(null), { x: 1 }),
    } as unknown as TestState);

    const copy = (await api.read()) as unknown as {
      model: string;
      first: { inner: number };
      second: { inner: number };
      nullProto: { x: number };
    };

    // JSON cannot preserve object identity: the two aliases are now distinct.
    expect(copy.first).not.toBe(copy.second);
    expect(copy.first).toEqual({ inner: 1 });
    expect(copy.second).toEqual({ inner: 1 });

    // Mutating one copy cannot affect the other or the store.
    copy.first.inner = 99;
    await expect(api.read()).resolves.toMatchObject({ model: "a" });
    const persisted = (await store.load()).agentSessions["pi-coding-agent:abc"]!.state as {
      first: { inner: number };
      second: { inner: number };
    };
    expect(persisted.first).toEqual({ inner: 1 });
    expect(persisted.second).toEqual({ inner: 1 });

    // Empty-prototype objects are JSON-safe and normalize to plain objects.
    expect(Object.getPrototypeOf(copy.nullProto)).toBe(Object.prototype);
    expect(copy.nullProto).toEqual({ x: 1 });
  });
});
