import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayCore } from "../../../core/gateway-core";
import { createAgentSessionStateRegistry } from "../../../config/agent-session-state";
import { createInMemoryChannelStateStore } from "../../../config/channel-state";
import type {
  ChannelPersistentState,
  ClientInputEvent,
  ClientOutputEvent,
  IMAdapter,
} from "../../../types";
import { piCodingAgentModule } from "./index";

let fakeClients: Array<{ cwd?: string; started: boolean }> = [];
/**
 * The store the fake Pi process probes at spawn time. The adapter must
 * initialize and commit the agent session record before the spawn step, so
 * this is the observable ordering proof for the composition.
 */
let storeProbe: { load(): Promise<ChannelPersistentState> } | null = null;

vi.mock("./adapter/pi-rpc-client", () => ({
  PiRpcClient: class FakePiRpcClient {
    #listener: ((event: { type: string; [key: string]: unknown }) => void) | null = null;

    constructor(options: { cwd?: string }) {
      fakeClients.push({ cwd: options.cwd, started: false });
    }

    onEvent(listener: (event: { type: string; [key: string]: unknown }) => void): void {
      this.#listener = listener;
    }

    async start(): Promise<void> {
      const instance = fakeClients.at(-1)!;
      // Ordering proof: if a future refactor moved initialize() after the
      // spawn step, the record would not be visible here yet.
      const state = storeProbe ? await storeProbe.load() : { agentSessions: {} };
      if (Object.keys(state.agentSessions).length === 0) {
        throw new Error("agent session record was not committed before the Pi process started");
      }
      instance.started = true;
    }

    async stop(): Promise<void> {}
    async abort(): Promise<void> {}
    async prompt(): Promise<void> {}
    async compact(): Promise<{ estimatedTokensAfter?: number; summary?: string }> {
      return {};
    }
    async getState(): Promise<Record<string, never>> {
      return {};
    }
    async getSessionStats(): Promise<Record<string, never>> {
      return {};
    }
    async getAvailableModels(): Promise<Array<{ provider: string; id: string }>> {
      return [];
    }
    async setModel(): Promise<{ provider: string; id: string }> {
      return { provider: "x", id: "y" };
    }
    async setSessionName(): Promise<void> {}
  },
}));

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

function makeCore(imAdapter: IMAdapter, store: ReturnType<typeof createInMemoryChannelStateStore>): GatewayCore {
  return new GatewayCore({
    imAdapter,
    agentModule: piCodingAgentModule,
    agentConfig: {},
    agentIdleTimeoutMs: 60_000,
    channelStateStore: store,
    agentSessionStateRegistry: createAgentSessionStateRegistry(store),
    common: { channelName: "test-channel", language: "en-US" },
  });
}

afterEach(() => {
  fakeClients.length = 0;
  storeProbe = null;
});

describe("Gateway + Pi module composition", () => {
  it("commits the record before the Pi process starts and commits binding + record on /new", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-gateway-compose-"));
    const canonical = await realpath(dir);
    const store = createInMemoryChannelStateStore();
    const imAdapter = new FakeIMAdapter();
    const core = makeCore(imAdapter, store);

    storeProbe = store;
    try {
      await core.start();
      await imAdapter.emit({
        type: "command.session.new",
        clientSessionId: "client-1",
        workingDirectory: dir,
        workingDirectorySource: "user",
      });

      await vi.waitFor(() => {
        expect(fakeClients).toHaveLength(1);
        expect(fakeClients[0]!.started).toBe(true);
      });

      const document = await store.load();
      const agentSessionId = document.bindings["client-1"];
      expect(agentSessionId).toMatch(/^pi-coding-agent:/);
      expect(document.agentSessions[agentSessionId!]!.state).toEqual({
        version: 1,
        workingDirectory: canonical,
        workingDirectorySource: "user",
      });
      expect(fakeClients[0]?.cwd).toBe(canonical);
      expect(imAdapter.outputs.some((event) => event.type === "assistant.message")).toBe(true);
    } finally {
      storeProbe = null;
      await core.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adopts an external provider session through command.session.resume end to end", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "pi-gateway-adopt-"));
    const projectDir = path.join(base, "external-project");
    await mkdir(projectDir, { recursive: true });
    const projectCanonical = await realpath(projectDir);
    const bridgeDir = path.join(base, "bridge-sessions");
    await mkdir(bridgeDir);
    const sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
    const sessionFile = path.join(bridgeDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: projectDir })}\n`,
    );

    const store = createInMemoryChannelStateStore();
    const imAdapter = new FakeIMAdapter();
    // Route the module's sessionDir into the temp bridge dir for the test.
    const core = new GatewayCore({
      imAdapter,
      agentModule: piCodingAgentModule,
      agentConfig: { sessionDir: bridgeDir },
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
      agentSessionStateRegistry: createAgentSessionStateRegistry(store),
      common: { channelName: "test-channel", language: "en-US" },
    });

    storeProbe = store;
    try {
      await core.start();
      await imAdapter.emit({
        type: "command.session.resume",
        clientSessionId: "client-1",
        providerSessionId: sessionId,
      });

      await vi.waitFor(() => {
        expect(fakeClients).toHaveLength(1);
        expect(fakeClients[0]!.started).toBe(true);
      });

      // The adopted provider session drives the spawn directory.
      expect(fakeClients[0]?.cwd).toBe(projectCanonical);

      const document = await store.load();
      const agentSessionId = document.bindings["client-1"];
      expect(agentSessionId).toMatch(/^pi-coding-agent:/);
      expect(document.agentSessions[agentSessionId!]!.state).toEqual({
        version: 1,
        workingDirectory: projectCanonical,
        workingDirectorySource: "user",
        sessionFile,
      });
      expect(imAdapter.outputs.some((event) => event.type === "assistant.message")).toBe(true);
    } finally {
      storeProbe = null;
      await core.stop();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("resumes the persisted working directory through the real module after restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-gateway-resume-"));
    const canonical = await realpath(dir);
    const store = createInMemoryChannelStateStore();
    const firstAdapter = new FakeIMAdapter();
    const first = makeCore(firstAdapter, store);

    storeProbe = store;
    try {
      await first.start();
      await firstAdapter.emit({
        type: "command.session.new",
        clientSessionId: "client-1",
        workingDirectory: dir,
        workingDirectorySource: "user",
      });
      await vi.waitFor(async () => {
        const document = await store.load();
        expect(document.bindings["client-1"]).toMatch(/^pi-coding-agent:/);
      });
      await first.stop();

      // Simulate a bridge restart: a fresh core over the same persisted store.
      fakeClients.length = 0;
      const secondAdapter = new FakeIMAdapter();
      const second = makeCore(secondAdapter, store);
      try {
        await second.start();
        await secondAdapter.emit({ type: "user.message", clientSessionId: "client-1", text: "hello" });

        await vi.waitFor(() => {
          expect(fakeClients).toHaveLength(1);
          expect(fakeClients[0]!.started).toBe(true);
        });
        expect(fakeClients[0]?.cwd).toBe(canonical);
      } finally {
        await second.stop();
      }
    } finally {
      storeProbe = null;
      await first.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
