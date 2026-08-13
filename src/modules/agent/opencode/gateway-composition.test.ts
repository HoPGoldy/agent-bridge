import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@opencode-ai/sdk/v2/types";
import { GatewayCore } from "../../../core/gateway-core";
import { createAgentSessionStateRegistry } from "../../../config/agent-session-state";
import { createInMemoryChannelStateStore } from "../../../config/channel-state";
import type {
  ChannelPersistentState,
  ClientInputEvent,
  ClientOutputEvent,
  IMAdapter,
  OpenCodeAgentConfig,
} from "../../../types";
import { createOpenCodeAgentModule } from "./index";
import type { OpenCodeApi } from "./adapter/opencode-api";

/**
 * The store the fake OpenCode Server probes when the SSE subscription starts.
 * The adapter must initialize and commit the agent session record before the
 * runtime register step, so this is the observable ordering proof for the
 * composition.
 */
let storeProbe: { load(): Promise<ChannelPersistentState> } | null = null;

function createFakeApi(): OpenCodeApi {
  return {
    health: vi.fn(async () => ({ healthy: true as const, version: "1.18.10" })),
    createSession: vi.fn(async () => ({ id: "session-1" }) as Session),
    getSession: vi.fn(async () => ({ id: "session-1" }) as Session),
    getSessionStatuses: vi.fn(async () => ({})),
    getMessages: vi.fn(async () => []),
    promptAsync: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    summarize: vi.fn(async () => undefined),
    getProviders: vi.fn(async () => ({ all: [], connected: [], default: {} })),
    listPermissions: vi.fn(async () => []),
    replyPermission: vi.fn(async () => undefined),
    listQuestions: vi.fn(async () => []),
    rejectQuestion: vi.fn(async () => undefined),
    subscribe: vi.fn(async ({ signal, onConnected }) => {
      // Ordering proof: if a future refactor moved initialize() after the
      // register step, the record would not be visible here yet.
      const state = storeProbe ? await storeProbe.load() : { agentSessions: {} };
      if (Object.keys(state.agentSessions).length === 0) {
        throw new Error("agent session record was not committed before the OpenCode SSE subscription started");
      }
      await onConnected();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }),
  };
}

class FakeIMAdapter implements IMAdapter {
  outputs: ClientInputEvent[] = [];
  #onOutput: ((event: ClientOutputEvent) => Promise<void> | void) | null = null;

  async start(onOutput: (event: ClientOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
  }

  async stop(): Promise<void> {}

  async input(event: ClientInputEvent): Promise<void> {
    this.outputs.push(event);
  }

  async isBusy(): Promise<boolean> {
    return false;
  }

  async emit(event: ClientOutputEvent): Promise<void> {
    await this.#onOutput?.(event);
  }
}

function makeCore(imAdapter: IMAdapter, store: ReturnType<typeof createInMemoryChannelStateStore>) {
  const apiFactoryConfigs: OpenCodeAgentConfig[] = [];
  let fakeApi: OpenCodeApi | null = null;
  const module = createOpenCodeAgentModule({
    apiFactory: (config) => {
      apiFactoryConfigs.push(config);
      fakeApi = createFakeApi();
      return fakeApi;
    },
  });
  const core = new GatewayCore({
    imAdapter,
    agentModule: module,
    agentConfig: { baseUrl: "http://127.0.0.1:4096" },
    agentIdleTimeoutMs: 60_000,
    channelStateStore: store,
    agentSessionStateRegistry: createAgentSessionStateRegistry(store),
    common: { channelName: "test-channel", language: "en-US" },
  });
  return { core, apiFactoryConfigs, getApi: () => fakeApi };
}

afterEach(() => {
  storeProbe = null;
});

describe("Gateway + OpenCode module composition", () => {
  it("commits the record before the SSE subscription starts and commits binding + record on /new", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-gateway-compose-"));
    const store = createInMemoryChannelStateStore();
    const imAdapter = new FakeIMAdapter();
    const { core, apiFactoryConfigs, getApi } = makeCore(imAdapter, store);

    storeProbe = store;
    try {
      await core.start();
      await imAdapter.emit({
        type: "command.session.new",
        clientSessionId: "client-1",
        workingDirectory: dir,
      });

      await vi.waitFor(() => {
        expect(getApi()).not.toBeNull();
        expect(getApi()!.createSession).toHaveBeenCalledWith(
          expect.objectContaining({ title: "agent-bridge:test-channel" }),
        );
      });

      const document = await store.load();
      const agentSessionId = document.bindings["client-1"];
      expect(agentSessionId).toMatch(/^opencode:/);
      // OpenCode never canonicalizes the directory (the server may be remote):
      // the persisted value is exactly what was sent to the server.
      expect(document.agentSessions[agentSessionId!]!.state).toEqual({
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: dir,
        workingDirectorySource: "user",
      });
      expect(apiFactoryConfigs[0]?.directory).toBe(dir);
      expect(imAdapter.outputs.some((event) => event.type === "assistant.message")).toBe(true);
    } finally {
      storeProbe = null;
      await core.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resumes the persisted working directory through the real module after restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-gateway-resume-"));
    const store = createInMemoryChannelStateStore();
    const firstAdapter = new FakeIMAdapter();
    const first = makeCore(firstAdapter, store);

    storeProbe = store;
    try {
      await first.core.start();
      await firstAdapter.emit({
        type: "command.session.new",
        clientSessionId: "client-1",
        workingDirectory: dir,
      });
      await vi.waitFor(async () => {
        const document = await store.load();
        expect(document.bindings["client-1"]).toMatch(/^opencode:/);
      });
      await first.core.stop();
    } finally {
      storeProbe = null;
    }

    // Simulate a bridge restart: a fresh core (and fresh fake server) over the
    // same persisted store.
    const secondAdapter = new FakeIMAdapter();
    const second = makeCore(secondAdapter, store);
    storeProbe = store;
    try {
      await second.core.start();
      await secondAdapter.emit({ type: "user.message", clientSessionId: "client-1", text: "hello" });

      await vi.waitFor(() => {
        expect(second.getApi()).not.toBeNull();
        expect(second.getApi()!.getSession).toHaveBeenCalledWith("session-1");
      });
      // Resume must not create a new provider session.
      expect(second.getApi()!.createSession).not.toHaveBeenCalled();
      // The directory-scoped api is bound to the persisted directory.
      expect(second.apiFactoryConfigs[0]?.directory).toBe(dir);
    } finally {
      storeProbe = null;
      await second.core.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
