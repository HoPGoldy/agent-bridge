import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayCore } from "./gateway-core";
import { emptyChannelState } from "../config/channel-state";
import type {
  AgentAdapter,
  AgentInputEvent,
  AgentModule,
  AgentOutputEvent,
  AgentSessionRecord,
  AgentSessionStateCodec,
  ChannelCommonContext,
  ChannelPersistentState,
  ChannelStateStore,
  ClientInputEvent,
  ClientOutputEvent,
  IMAdapter,
  NewAgentSessionStateApi,
} from "../types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await assertion();
      return;
    } catch {
      await sleep(10);
    }
  }
  await assertion();
}

/** Creates a temporary queue-definitions root for `/queue-here` tests (spec D1). */
async function makeTempQueuesDir(tempDirs: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-queues-"));
  tempDirs.push(dir);
  return dir;
}

/** Seeds a queue definition file: `queues/<name>.md` with an optional `channel` and optional extra fields. */
async function writeQueueDefinitionFile(
  queuesRoot: string,
  name: string,
  channel?: string,
  extra: Record<string, string> = {},
): Promise<void> {
  const frontMatter = [
    "---",
    ...(channel !== undefined ? [`channel: ${channel}`] : []),
    ...Object.entries(extra).map(([key, value]) => `${key}: ${value}`),
    "---",
  ];
  await writeFile(path.join(queuesRoot, `${name}.md`), `${frontMatter.join("\n")}\n`);
}

class FakeIMAdapter implements IMAdapter {
  #onOutput: ((event: ClientOutputEvent) => Promise<void> | void) | null = null;
  readonly outputs: ClientInputEvent[] = [];

  async start(onOutput: (event: ClientOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
  }

  async stop(): Promise<void> {
    this.#onOutput = null;
  }

  async input(event: ClientInputEvent): Promise<void> {
    this.outputs.push(event);
  }

  async isBusy(): Promise<boolean> {
    return false;
  }

  async emit(event: ClientOutputEvent): Promise<void> {
    if (!this.#onOutput) {
      throw new Error("FakeIMAdapter is not started");
    }
    await this.#onOutput(event);
  }
}

class FakeAgentAdapter implements AgentAdapter {
  readonly inputs: AgentInputEvent[] = [];
  readonly outputs: AgentOutputEvent[] = [];
  stopCount = 0;
  abortCount = 0;
  statusResult?: import("../types").AgentSessionStatus;
  statusError?: Error;
  availableModels: import("../types").AgentAvailableModel[] = [];
  availableModelsError?: Error;
  setModelResult?: { provider: string; modelId: string };
  setModelError?: Error;
  setModelCalls: string[] = [];
  startError?: Error;
  stopError?: Error;
  #onOutput: ((event: AgentOutputEvent) => Promise<void> | void) | null = null;

  constructor(readonly agentSessionId: string) {}

  async start(onOutput: (event: AgentOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    if (this.startError) {
      throw this.startError;
    }
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    if (!this.retainOutputCallback) {
      this.#onOutput = null;
    }
    if (this.stopError) {
      throw this.stopError;
    }
  }

  retainOutputCallback = false;

  async abort(): Promise<void> {
    this.abortCount += 1;
  }

  async input(event: AgentInputEvent): Promise<void> {
    this.inputs.push(event);
  }

  async getStatus(): Promise<import("../types").AgentSessionStatus> {
    if (this.statusError) {
      throw this.statusError;
    }
    if (!this.statusResult) {
      throw new Error("status not configured");
    }
    return this.statusResult;
  }

  async getAvailableModels(): Promise<import("../types").AgentAvailableModel[]> {
    if (this.availableModelsError) {
      throw this.availableModelsError;
    }
    return this.availableModels;
  }

  async setModel(target: string): Promise<{ provider: string; modelId: string }> {
    this.setModelCalls.push(target);
    if (this.setModelError) {
      throw this.setModelError;
    }
    if (!this.setModelResult) {
      throw new Error("setModel not configured");
    }
    return this.setModelResult;
  }

  async emitAssistant(text: string): Promise<void> {
    const event: AgentOutputEvent = {
      type: "assistant.message",
      agentSessionId: this.agentSessionId,
      text,
    };
    this.outputs.push(event);
    await this.#onOutput?.(event);
  }

  async emit(event: AgentOutputEvent): Promise<void> {
    this.outputs.push(event);
    await this.#onOutput?.(event);
  }
}

/** Fake module state: a minimal versioned record carrying an optional cwd. */
interface FakeState {
  version: 1;
  workingDirectory?: string;
}

const fakeStateCodec: AgentSessionStateCodec<FakeState> = {
  currentVersion: 1,
  decode(raw, _stateVersion, _context) {
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      if (record.version === 1) {
        return {
          version: 1,
          ...(typeof record.workingDirectory === "string" && record.workingDirectory.length > 0
            ? { workingDirectory: record.workingDirectory }
            : {}),
        };
      }
    }
    throw new Error("invalid fake agent session state");
  },
  encode(state) {
    return { ...state };
  },
};

type CreateSessionArgs = Parameters<
  NonNullable<AgentModule<Record<string, never>, FakeState>["createAgentSession"]>
>[0];
type ResumeSessionArgs = Parameters<
  NonNullable<AgentModule<Record<string, never>, FakeState>["resumeAgentSession"]>
>[0];

/**
 * Builds a fake module on the new contract: the core owns the agent session
 * id, create initializes the reserved state (carrying the working directory
 * when one was requested) and returns an adapter for that id; resume reads the
 * persisted state.
 */
function makeFakeModule(options: {
  createdAdapters?: FakeAgentAdapter[];
  create?: (args: CreateSessionArgs, createdAdapters: FakeAgentAdapter[]) => AgentAdapter | Promise<AgentAdapter>;
  resume?: (args: ResumeSessionArgs) => AgentAdapter | Promise<AgentAdapter>;
} = {}): AgentModule<Record<string, never>, FakeState> {
  return {
    type: "fake",
    sessionStateCodec: fakeStateCodec,
    async createAgentSession(args) {
      await args.sessionState.initialize({
        version: 1,
        ...(args.workingDirectory !== undefined && args.workingDirectory.trim() !== ""
          ? { workingDirectory: args.workingDirectory }
          : {}),
      });
      if (options.create) {
        return options.create(args, options.createdAdapters ?? []);
      }
      const adapter = new FakeAgentAdapter(args.agentSessionId);
      options.createdAdapters?.push(adapter);
      return adapter;
    },
    // Resume is required on the module contract; the default restores a plain
    // adapter for the persisted id, while a test can override the behavior.
    async resumeAgentSession(args) {
      if (options.resume) {
        return options.resume(args);
      }
      return new FakeAgentAdapter(args.agentSessionId);
    },
  };
}

/** In-memory ChannelStateStore with serialized transactions. */
class InMemoryStateStore implements ChannelStateStore {
  state: ChannelPersistentState = emptyChannelState();
  #tail: Promise<void> = Promise.resolve();

  load(): Promise<ChannelPersistentState> {
    return Promise.resolve(this.state);
  }

  save(state: ChannelPersistentState): Promise<void> {
    return this.transaction(() => state);
  }

  transaction<T>(updater: (draft: ChannelPersistentState) => T | ChannelPersistentState): Promise<T> {
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

/**
 * Store whose transaction commits stay parked until explicitly released, so
 * save ordering, concurrency, and failure recovery can be interleaved
 * deterministically.
 */
class DeferredStateStore implements ChannelStateStore {
  state: ChannelPersistentState = emptyChannelState();
  readonly deferreds: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  maxConcurrent = 0;
  failNextWrite = false;
  #inFlight = 0;
  #tail: Promise<void> = Promise.resolve();

  load(): Promise<ChannelPersistentState> {
    return Promise.resolve(this.state);
  }

  save(state: ChannelPersistentState): Promise<void> {
    return this.transaction(() => state);
  }

  transaction<T>(updater: (draft: ChannelPersistentState) => T | ChannelPersistentState): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = this.#tail.then(async () => {
        this.#inFlight += 1;
        this.maxConcurrent = Math.max(this.maxConcurrent, this.#inFlight);
        if (this.failNextWrite) {
          this.failNextWrite = false;
          this.#inFlight -= 1;
          throw new Error("save boom");
        }
        const draft = JSON.parse(JSON.stringify(this.state)) as ChannelPersistentState;
        const result = updater(draft);
        const isState =
          result !== null &&
          typeof result === "object" &&
          (result as { version?: unknown }).version === 2 &&
          typeof (result as { bindings?: unknown }).bindings === "object" &&
          typeof (result as { agentSessions?: unknown }).agentSessions === "object";
        const next: ChannelPersistentState = isState ? (result as ChannelPersistentState) : draft;
        await new Promise<void>((resolveCommit, rejectCommit) => {
          this.deferreds.push({ resolve: resolveCommit, reject: rejectCommit });
        });
        this.state = next;
        this.#inFlight -= 1;
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

function makeStore(initial: { bindings?: Record<string, string>; records?: Record<string, AgentSessionRecord> } = {}): InMemoryStateStore {
  const store = new InMemoryStateStore();
  store.state = {
    version: 3,
    bindings: { ...(initial.bindings ?? {}) },
    agentSessions: { ...(initial.records ?? {}) },
    clientSessions: {},
  };
  return store;
}

function recordFor(agentSessionId: string, state: unknown, agentType = "fake"): AgentSessionRecord {
  return {
    recordVersion: 1,
    agentType,
    stateVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state,
  };
}

/**
 * FakeIMAdapter variant that keeps its output callback after stop(), so tests
 * can simulate a late event racing in while the core is shutting down.
 */
class KeepCallbackOnStopAdapter extends FakeIMAdapter {
  async stop(): Promise<void> {
    // Intentionally keep the output callback so emit() still works after stop().
  }
}

/**
 * FakeAgentAdapter whose input() blocks until stop() releases it, simulating a
 * user.message handler waiting on a long-running agent turn.
 */
class BlockingInputAdapter extends FakeAgentAdapter {
  #releaseInput: (() => void) | null = null;
  inputEntered = 0;
  inputResolved = 0;

  async input(event: AgentInputEvent): Promise<void> {
    this.inputs.push(event);
    this.inputEntered += 1;
    await new Promise<void>((resolve) => {
      this.#releaseInput = resolve;
    });
    this.inputResolved += 1;
  }

  releaseInput(): void {
    this.#releaseInput?.();
    this.#releaseInput = null;
  }

  async stop(): Promise<void> {
    await super.stop();
    this.releaseInput();
  }
}

describe("GatewayCore", () => {
  const running: Array<{ stop: () => Promise<void> }> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (running.length > 0) {
      await running.pop()!.stop();
    }
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("passes the channel common context and core-owned ids to agent session lifecycle calls", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore({
      bindings: { "client-1": "agent-1" },
      records: { "agent-1": recordFor("agent-1", { version: 1 }) },
    });
    const createArgs: Array<{
      common: ChannelCommonContext;
      agentSessionId: string;
      workingDirectory?: string;
      sessionStateProvided: boolean;
    }> = [];
    const resumeArgs: Array<{
      common: ChannelCommonContext;
      agentSessionId: string;
      sessionStateProvided: boolean;
    }> = [];

    const agentModule = makeFakeModule({
      create: async (args) => {
        createArgs.push({
          common: args.common,
          agentSessionId: args.agentSessionId,
          workingDirectory: args.workingDirectory,
          sessionStateProvided: Boolean(args.sessionState),
        });
        return new FakeAgentAdapter(args.agentSessionId);
      },
      resume: async (args) => {
        resumeArgs.push({
          common: args.common,
          agentSessionId: args.agentSessionId,
          sessionStateProvided: Boolean(args.sessionState),
        });
        return new FakeAgentAdapter(args.agentSessionId);
      },
    });

    const common: ChannelCommonContext = {
      channelName: "demo-channel",
      language: "zh-CN",
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
      common,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "resume me",
    });
    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-2",
      text: "create me",
    });

    await waitFor(() => {
      expect(resumeArgs).toEqual([
        { common, agentSessionId: "agent-1", sessionStateProvided: true },
      ]);
      expect(createArgs).toEqual([
        {
          common,
          agentSessionId: expect.stringMatching(/^fake:/),
          workingDirectory: undefined,
          sessionStateProvided: true,
        },
      ]);
    });
  });

  it("localizes fixed gateway messages with the configured channel language", async () => {
    const imAdapter = new FakeIMAdapter();

    const agentModule = makeFakeModule();

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      common: {
        channelName: "demo-channel",
        language: "zh-CN",
      },
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "command.session.stop",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "client-1",
        text: "当前没有可停止的智能体会话。",
      });
    });
  });

  it("drops late output from an old agent session after command.session.new", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
      expect(createdAdapters[0]!.inputs).toEqual([{ type: "user.message", text: "hello" }]);
    });

    const first = createdAdapters[0]!;

    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/default/dir",
      workingDirectorySource: "default",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(2);
      expect(first.stopCount).toBe(1);
      expect(imAdapter.outputs.some((event) => event.text === "Started a new session (working directory: /default/dir).")).toBe(true);
    });

    await first.emitAssistant("late old reply");
    await sleep(30);

    expect(imAdapter.outputs.some((event) => event.text === "late old reply")).toBe(false);
  });

  it("drops output from an agent session released after idle timeout", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      create: async (args) => {
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        adapter.retainOutputCallback = true;
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 20,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    const first = createdAdapters[0]!;
    await waitFor(() => {
      expect(first.stopCount).toBe(1);
    });

    await first.emitAssistant("late reply after release");
    await sleep(30);

    expect(imAdapter.outputs.some((event) => event.text === "late reply after release")).toBe(false);
  });

  it("resumes the persisted agent session for a known client after restart", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore({
      bindings: { "client-1": "agent-1" },
      records: { "agent-1": recordFor("agent-1", { version: 1 }) },
    });
    const resumed: string[] = [];
    let createCount = 0;
    const resumedAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      create: async (args) => {
        createCount += 1;
        return new FakeAgentAdapter(args.agentSessionId);
      },
      resume: async (args) => {
        resumed.push(args.agentSessionId);
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        resumedAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello again",
    });

    await waitFor(() => {
      expect(resumed).toEqual(["agent-1"]);
      expect(createCount).toBe(0);
      expect(resumedAdapters[0]!.inputs).toEqual([{ type: "user.message", text: "hello again" }]);
    });
  });

  it("persists the binding and an agent session record when a new agent session is created", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();

    const agentModule = makeFakeModule();

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      const boundId = store.state.bindings["client-1"];
      expect(boundId).toMatch(/^fake:/);
      expect(store.state.agentSessions[boundId!]).toMatchObject({
        recordVersion: 1,
        agentType: "fake",
        stateVersion: 1,
      });
    });
  });

  it("passes workingDirectory from /new into createAgentSession and persists it in the binding and record", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdDirs: Array<string | undefined> = [];
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      createdAdapters,
      create: async (args) => {
        createdDirs.push(args.workingDirectory);
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });
    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "user",
    });

    await waitFor(() => {
      expect(createdDirs.at(-1)).toBe("/tmp/project-a");
      expect(createdAdapters[0]!.stopCount).toBe(1);
      const boundId = store.state.bindings["client-1"];
      expect(boundId).toBe(createdAdapters[1]!.agentSessionId);
      expect(store.state.agentSessions[boundId!]!.state).toEqual({
        version: 1,
        workingDirectory: "/tmp/project-a",
      });
      // The previous record is dropped once nothing references it.
      expect(store.state.agentSessions[createdAdapters[0]!.agentSessionId]).toBeUndefined();
      expect(imAdapter.outputs.some((event) => event.text === "Started a new session (working directory: /tmp/project-a).")).toBe(true);
    });
  });

  it("passes a default-source /new working directory through to createAgentSession", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdCalls: Array<{ workingDirectory?: string; workingDirectorySource?: string }> = [];

    const agentModule = makeFakeModule({
      create: async (args) => {
        createdCalls.push({
          workingDirectory: args.workingDirectory,
          workingDirectorySource: args.workingDirectorySource,
        });
        return new FakeAgentAdapter(args.agentSessionId);
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    // The client adapter always resolves a concrete directory for `/new`; a
    // `default` source marks the trusted client-side cwd fallback.
    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/default/dir",
      workingDirectorySource: "default",
    });

    await waitFor(() => {
      expect(createdCalls).toEqual([
        { workingDirectory: "/default/dir", workingDirectorySource: "default" },
      ]);
      const boundId = store.state.bindings["client-1"];
      expect(boundId).toMatch(/^fake:/);
      expect(store.state.agentSessions[boundId!]!.state).toEqual({
        version: 1,
        workingDirectory: "/default/dir",
      });
      expect(
        imAdapter.outputs.some(
          (event) => event.text === "Started a new session (working directory: /default/dir).",
        ),
      ).toBe(true);
    });
  });

  it("forwards model from a command.session.new event into createAgentSession options", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdModels: Array<string | undefined> = [];

    const agentModule = makeFakeModule({
      create: async (args) => {
        createdModels.push(args.model);
        return new FakeAgentAdapter(args.agentSessionId);
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    // A chat-originated /new never sets model → the option is undefined.
    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "user",
    });
    await waitFor(() => {
      expect(createdModels).toHaveLength(1);
      expect(createdModels[0]).toBeUndefined();
    });

    // A schedule fire with a pinned model threads it through to the module.
    await core.input({
      type: "command.session.new",
      clientSessionId: "schedule:report:1",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "default",
      model: "azure-openai-responses/gpt-5.6-terra",
    });
    await waitFor(() => {
      expect(createdModels).toHaveLength(2);
      expect(createdModels[1]).toBe("azure-openai-responses/gpt-5.6-terra");
    });
  });

  it("passes the persisted workingDirectory to resumeAgentSession on restore", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore({
      bindings: { "client-1": "agent-1" },
      records: { "agent-1": recordFor("agent-1", { version: 1, workingDirectory: "/tmp/project-a" }) },
    });
    const resumed: Array<{ agentSessionId: string; workingDirectory?: string }> = [];

    const agentModule = makeFakeModule({
      create: async (args) => new FakeAgentAdapter(args.agentSessionId),
      resume: async (args) => {
        const state = await args.sessionState.read();
        resumed.push({ agentSessionId: args.agentSessionId, workingDirectory: state.workingDirectory });
        return new FakeAgentAdapter(args.agentSessionId);
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello again",
    });

    await waitFor(() => {
      expect(resumed).toEqual([{ agentSessionId: "agent-1", workingDirectory: "/tmp/project-a" }]);
    });
  });

  it("re-resumes with the persisted workingDirectory after idle release", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore({
      bindings: { "client-1": "agent-1" },
      records: { "agent-1": recordFor("agent-1", { version: 1, workingDirectory: "/tmp/project-a" }) },
    });
    const resumedDirs: Array<string | undefined> = [];

    const agentModule = makeFakeModule({
      create: async (args) => new FakeAgentAdapter(args.agentSessionId),
      resume: async (args) => {
        const state = await args.sessionState.read();
        resumedDirs.push(state.workingDirectory);
        return new FakeAgentAdapter(args.agentSessionId);
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 20,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "first",
    });
    await waitFor(() => {
      expect(resumedDirs).toEqual(["/tmp/project-a"]);
    });

    await sleep(60);

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "second",
    });
    await waitFor(() => {
      expect(resumedDirs).toEqual(["/tmp/project-a", "/tmp/project-a"]);
    });
  });

  it("keeps the previous session and binding when /new creation fails", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];
    let failNextCreate = false;

    const agentModule = makeFakeModule({
      createdAdapters,
      create: async (args) => {
        if (failNextCreate) {
          throw new Error("boom: cannot create");
        }
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });
    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    failNextCreate = true;
    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/missing",
      workingDirectorySource: "user",
    });

    await waitFor(() => {
      expect(createdAdapters[0]!.stopCount).toBe(0);
      expect(store.state.bindings).toEqual({ "client-1": createdAdapters[0]!.agentSessionId });
      // The failed new session left no record behind.
      expect(Object.keys(store.state.agentSessions)).toHaveLength(1);
      expect(
        imAdapter.outputs.some(
          (event) =>
            event.type === "assistant.message" && event.text.includes("Failed to start a new session"),
        ),
      ).toBe(true);
    });

    await createdAdapters[0]!.emitAssistant("still alive");
    await waitFor(() => {
      expect(imAdapter.outputs.some((event) => event.text === "still alive")).toBe(true);
    });
  });

  it("cleans up a partially created adapter when start fails and keeps the old session", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      create: async (args) => {
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        if (createdAdapters.length > 0) {
          adapter.startError = new Error("start boom");
        }
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });
    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-b",
      workingDirectorySource: "user",
    });

    await waitFor(() => {
      expect(createdAdapters[1]!.stopCount).toBe(1);
      expect(createdAdapters[0]!.stopCount).toBe(0);
      expect(store.state.bindings).toEqual({ "client-1": createdAdapters[0]!.agentSessionId });
      expect(
        imAdapter.outputs.some(
          (event) =>
            event.type === "assistant.message" && event.text.includes("Failed to start a new session"),
        ),
      ).toBe(true);
    });
  });

  it("fails the new session when the module does not initialize its state record", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    // Module that never calls sessionState.initialize: the core must treat it
    // as a failed create and clean up everything. Resume is provided because
    // the module contract requires it, but this session never gets that far.
    const agentModule: AgentModule<Record<string, never>, FakeState> = {
      type: "fake",
      sessionStateCodec: fakeStateCodec,
      async createAgentSession(args) {
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        createdAdapters.push(adapter);
        return adapter;
      },
      async resumeAgentSession(args) {
        return new FakeAgentAdapter(args.agentSessionId);
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/default/dir",
      workingDirectorySource: "default",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
      expect(createdAdapters[0]!.stopCount).toBe(1);
      expect(store.state.bindings).toEqual({});
      expect(Object.keys(store.state.agentSessions)).toHaveLength(0);
      expect(
        imAdapter.outputs.some(
          (event) =>
            event.type === "assistant.message" && event.text.includes("Failed to start a new session"),
        ),
      ).toBe(true);
    });
  });

  it("passes the configured roots into createAgentSession and keeps the old session when the allowlist rejects /new", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];
    const createCalls: Array<{
      workingDirectory?: string;
      workingDirectorySource?: string;
      allowedWorkingDirectoryRoots?: string[];
    }> = [];

    // Fake module enforcing the same contract the real providers implement:
    // a user-sourced workingDirectory must resolve inside an allowed root,
    // while default-sourced fallbacks are trusted and never checked.
    const agentModule = makeFakeModule({
      createdAdapters,
      create: async (args) => {
        createCalls.push({
          workingDirectory: args.workingDirectory,
          workingDirectorySource: args.workingDirectorySource,
          allowedWorkingDirectoryRoots: args.allowedWorkingDirectoryRoots,
        });
        const roots = args.allowedWorkingDirectoryRoots ?? [];
        const wd = args.workingDirectory;
        if (wd !== undefined && args.workingDirectorySource !== "default" && roots.length > 0) {
          const allowed = roots.some(
            (root) => wd === root || wd.startsWith(`${root.replace(/\/+$/, "")}/`),
          );
          if (!allowed) {
            throw new Error(`working directory "${wd}" is not inside an allowed root`);
          }
        }
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      allowedWorkingDirectoryRoots: ["/tmp/allowed"],
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    // A default-sourced /new (the client-side cwd fallback) is not
    // allowlist-checked and succeeds.
    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/default/dir",
      workingDirectorySource: "default",
    });
    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });
    expect(createCalls[0]!.workingDirectory).toBe("/default/dir");
    expect(createCalls[0]!.workingDirectorySource).toBe("default");
    expect(createCalls[0]!.allowedWorkingDirectoryRoots).toEqual(["/tmp/allowed"]);

    // The out-of-root override is rejected before any teardown of the old session.
    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/outside",
      workingDirectorySource: "user",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
      expect(createdAdapters[0]!.stopCount).toBe(0);
      expect(store.state.bindings).toEqual({ "client-1": createdAdapters[0]!.agentSessionId });
      expect(
        imAdapter.outputs.some(
          (event) =>
            event.type === "assistant.message" &&
            event.text.includes("Failed to start a new session") &&
            event.text.includes("not inside an allowed root"),
        ),
      ).toBe(true);
    });
    expect(createCalls[1]!.workingDirectory).toBe("/tmp/outside");
    expect(createCalls[1]!.allowedWorkingDirectoryRoots).toEqual(["/tmp/allowed"]);

    // The old session is still bound and usable after the rejection.
    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "still here",
    });
    await waitFor(() => {
      expect(createdAdapters[0]!.inputs).toContainEqual({ type: "user.message", text: "still here" });
    });
  });

  it("passes the configured roots into resumeAgentSession on restore", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore({
      bindings: { "client-1": "agent-1" },
      records: {
        "agent-1": recordFor("agent-1", { version: 1, workingDirectory: "/tmp/allowed/project" }),
      },
    });
    const resumed: Array<{
      agentSessionId: string;
      workingDirectory?: string;
      allowedWorkingDirectoryRoots?: string[];
    }> = [];

    const agentModule = makeFakeModule({
      create: async (args) => new FakeAgentAdapter(args.agentSessionId),
      resume: async (args) => {
        const state = await args.sessionState.read();
        resumed.push({
          agentSessionId: args.agentSessionId,
          workingDirectory: state.workingDirectory,
          allowedWorkingDirectoryRoots: args.allowedWorkingDirectoryRoots,
        });
        return new FakeAgentAdapter(args.agentSessionId);
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      allowedWorkingDirectoryRoots: ["/tmp/allowed"],
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "resume me",
    });

    await waitFor(() => {
      expect(resumed).toEqual([
        {
          agentSessionId: "agent-1",
          workingDirectory: "/tmp/allowed/project",
          allowedWorkingDirectoryRoots: ["/tmp/allowed"],
        },
      ]);
    });
  });

  it("keeps a shared agent record when another client still references it after /new", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore({
      bindings: { "client-1": "agent-1", "client-2": "agent-1" },
      records: { "agent-1": recordFor("agent-1", { version: 1 }) },
    });
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/default/dir",
      workingDirectorySource: "default",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
      expect(store.state.bindings["client-1"]).toBe(createdAdapters[0]!.agentSessionId);
      expect(store.state.bindings["client-2"]).toBe("agent-1");
      // The record is still referenced by client-2, so it must not be deleted.
      expect(store.state.agentSessions["agent-1"]).toBeDefined();
    });
  });

  it("continues the /new switch when stopping the previous runtime throws", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      createdAdapters,
      create: async (args) => {
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });
    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    createdAdapters[0]!.stopError = new Error("stop boom");

    // Must not reject: the failed previous stop is logged and the switch completes.
    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "user",
    });

    expect(createdAdapters).toHaveLength(2);
    expect(createdAdapters[0]!.stopCount).toBe(1);
    expect(createdAdapters[1]!.stopCount).toBe(0);
    expect(store.state.bindings["client-1"]).toBe(createdAdapters[1]!.agentSessionId);
    expect(store.state.agentSessions[createdAdapters[0]!.agentSessionId]).toBeUndefined();
    expect(imAdapter.outputs.some((event) => event.text === "Started a new session (working directory: /tmp/project-a).")).toBe(true);

    // The new runtime is bound and reachable: a follow-up message goes to the
    // new adapter and is never routed to the stale (failed-stop) runtime.
    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "next",
    });
    await waitFor(() => {
      expect(createdAdapters[1]!.inputs).toContainEqual({ type: "user.message", text: "next" });
    });
    expect(createdAdapters[0]!.inputs.some((event) => event.text === "next")).toBe(false);
  });

  it("revokes the live state handle even when stopping the previous runtime throws", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];
    let capturedHandle: NewAgentSessionStateApi<FakeState> | null = null;

    const agentModule = makeFakeModule({
      createdAdapters,
      create: async (args) => {
        // Only the first (previous) session's handle is stale after the /new
        // switch; the second create must not overwrite the captured one.
        capturedHandle ??= args.sessionState;
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });
    await waitFor(() => {
      expect(capturedHandle).not.toBeNull();
    });

    // The old runtime's stop throws during the /new switch.
    createdAdapters[0]!.stopError = new Error("stop boom");

    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/default/dir",
      workingDirectorySource: "default",
    });
    await waitFor(() => {
      expect(createdAdapters).toHaveLength(2);
    });

    // Even though stop() threw, the stale adapter's handle was revoked: a late
    // read or update must fail instead of writing dead state back.
    await expect(capturedHandle!.read()).rejects.toThrow(/revoked/);
    await expect(capturedHandle!.update((state) => ({ ...state }))).rejects.toThrow(/revoked/);
  });

  it("serializes state-store writes so the latest binding wins with at most one concurrent write", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = new DeferredStateStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    const first = imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "user",
    });
    // The first /new parks on its create's initialize transaction first.
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(1);
    });
    expect(store.maxConcurrent).toBe(1);

    store.deferreds[0]!.resolve();
    // The binding save for the first /new is now parked.
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(2);
    });
    expect(store.maxConcurrent).toBe(1);

    const second = imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-b",
      workingDirectorySource: "user",
    });
    // The second /new is parked on the store flush (blocked by the first
    // binding save): nothing new is in flight yet.
    await sleep(30);
    expect(store.deferreds).toHaveLength(2);
    expect(store.maxConcurrent).toBe(1);

    store.deferreds[1]!.resolve();
    // The second create's initialize is now parked.
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(3);
    });
    expect(store.maxConcurrent).toBe(1);
    store.deferreds[2]!.resolve();
    // The second binding save is now parked.
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(4);
    });
    expect(store.maxConcurrent).toBe(1);
    store.deferreds[3]!.resolve();

    await first;
    await second;

    expect(store.maxConcurrent).toBe(1);
    expect(store.state.bindings["client-1"]).toBe(createdAdapters[1]!.agentSessionId);
    // The switch transaction dropped the now-unreferenced first record.
    expect(Object.keys(store.state.agentSessions)).toHaveLength(1);
    expect(store.state.agentSessions[createdAdapters[1]!.agentSessionId]).toBeDefined();
    expect(store.state.agentSessions[createdAdapters[0]!.agentSessionId]).toBeUndefined();
    expect(
      imAdapter.outputs.filter(
        (event) => event.type === "assistant.message" && event.text.startsWith("Started a new session"),
      ),
    ).toHaveLength(2);
  });

  it("rolls back the new session when its binding save fails and keeps the queue alive", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = new DeferredStateStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    // First /new: let the create's initialize commit, then fail the binding save.
    const first = imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "user",
    });
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(1);
    });
    store.failNextWrite = true;
    store.deferreds[0]!.resolve();

    // The failed binding save rejects the switch: the /new flow cleans up the
    // new runtime and its record, delivers a failure message, and never
    // updates the in-memory or durable binding.
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(2);
    });
    store.deferreds[1]!.resolve();
    await first;
    expect(createdAdapters[0]!.stopCount).toBe(1);
    expect(store.state.bindings).toEqual({});
    expect(Object.keys(store.state.agentSessions)).toHaveLength(0);
    expect(
      imAdapter.outputs.some(
        (event) =>
          event.type === "assistant.message" &&
          event.text.includes("Failed to start a new session") &&
          event.text.includes("save boom"),
      ),
    ).toBe(true);

    // The queue stays alive: the next /new persists the latest binding.
    const second = imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-b",
      workingDirectorySource: "user",
    });
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(3);
    });
    store.deferreds[2]!.resolve();
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(4);
    });
    store.deferreds[3]!.resolve();
    await second;

    expect(store.state.bindings["client-1"]).toBe(createdAdapters[1]!.agentSessionId);
  });

  it("keeps the previous session and binding when the /new binding switch fails", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = new DeferredStateStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    // Establish a first session through a user message (initialize + binding).
    const first = imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(1);
    });
    store.deferreds[0]!.resolve();
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(2);
    });
    store.deferreds[1]!.resolve();
    await first;
    await waitFor(() => {
      expect(store.state.bindings["client-1"]).toBe(createdAdapters[0]!.agentSessionId);
    });

    // /new: initialize the new session, then fail the binding switch.
    const second = imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-b",
      workingDirectorySource: "user",
    });
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(3);
    });
    store.failNextWrite = true;
    store.deferreds[2]!.resolve();
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(4);
    });
    store.deferreds[3]!.resolve();
    await second;

    // The failed switch kept the previous session authoritative: it was never
    // stopped, is still bound both in memory and durably, and its record
    // survives; the new runtime and its record were cleaned up.
    expect(createdAdapters[0]!.stopCount).toBe(0);
    expect(createdAdapters[1]!.stopCount).toBe(1);
    expect(store.state.bindings["client-1"]).toBe(createdAdapters[0]!.agentSessionId);
    expect(store.state.agentSessions[createdAdapters[0]!.agentSessionId]).toBeDefined();
    expect(store.state.agentSessions[createdAdapters[1]!.agentSessionId]).toBeUndefined();
    expect(
      imAdapter.outputs.some(
        (event) =>
          event.type === "assistant.message" &&
          event.text.includes("Failed to start a new session") &&
          event.text.includes("save boom"),
      ),
    ).toBe(true);

    // The old session is still the active one for this client.
    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "still here",
    });
    await waitFor(() => {
      expect(createdAdapters[0]!.inputs).toContainEqual({ type: "user.message", text: "still here" });
    });
    expect(createdAdapters[1]!.inputs.some((event) => event.text === "still here")).toBe(false);
  });

  it("rolls back the runtime when the first-time binding save fails", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = new DeferredStateStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    // The user message creates the session and parks on the initialize commit.
    const messageEmit = imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(1);
    });
    store.failNextWrite = true;
    store.deferreds[0]!.resolve();

    // The first-time binding save fails; the cleanup deletes the new record.
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(2);
    });
    store.deferreds[1]!.resolve();
    await messageEmit;

    // No binding, no orphan record, and the created runtime was stopped.
    expect(store.state.bindings).toEqual({});
    expect(Object.keys(store.state.agentSessions)).toHaveLength(0);
    expect(createdAdapters[0]!.stopCount).toBe(1);
  });

  it("drains pending state writes before core.stop resolves", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = new DeferredStateStore();

    const agentModule = makeFakeModule();

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    // The user-message handler awaits its binding write, so the initialize
    // and binding writes are still pending after the handler is parked.
    const messageEmit = imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(1);
    });
    store.deferreds[0]!.resolve();
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(2);
    });

    let stopped = false;
    const stopPromise = core.stop().then(() => {
      stopped = true;
    });
    await sleep(30);
    expect(stopped).toBe(false);

    store.deferreds[1]!.resolve();
    await stopPromise;
    await messageEmit;
    expect(stopped).toBe(true);
    expect(store.state.bindings).toEqual({ "client-1": expect.stringMatching(/^fake:/) });
  });

  it("waits for an in-flight /new handler during stop and cleans up its runtime and binding", async () => {
    const imAdapter = new KeepCallbackOnStopAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let createEntered = false;

    const agentModule = makeFakeModule({
      create: async (args) => {
        createEntered = true;
        await createGate;
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    try {
      // The /new handler enters and blocks on the deferred create.
      const newEmit = imAdapter.emit({
        type: "command.session.new",
        clientSessionId: "client-1",
        workingDirectory: "/tmp/project-a",
        workingDirectorySource: "user",
      });
      await waitFor(() => {
        expect(createEntered).toBe(true);
      });

      // Stop while the handler is in flight: it must not resolve early.
      let stopped = false;
      const stopPromise = core.stop().then(() => {
        stopped = true;
      });
      await sleep(30);
      expect(stopped).toBe(false);

      // A late event racing in after stop began must be ignored.
      await imAdapter.emit({
        type: "user.message",
        clientSessionId: "client-2",
        text: "ignored",
      });

      // Release the create; stop may now finish its drain and cleanup.
      releaseCreate();
      await newEmit;
      await waitFor(() => {
        expect(stopped).toBe(true);
      });

      // The new runtime was stopped by the stop drain, the binding was saved,
      // and the late event never created a second runtime or reached any agent.
      expect(createdAdapters[0]!.stopCount).toBe(1);
      expect(store.state.bindings).toEqual({
        "client-1": createdAdapters[0]!.agentSessionId,
      });
      expect(imAdapter.outputs.some((event) => event.text === "Started a new session (working directory: /tmp/project-a).")).toBe(true);
      expect(createdAdapters).toHaveLength(1);
      expect(createdAdapters[0]!.inputs).toEqual([]);
    } finally {
      // Always release the gate so stop()/afterEach cleanup cannot hang.
      releaseCreate();
    }
  });

  it("stops the remaining runtimes and drains bindings when one runtime stop throws", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const adapters: FakeAgentAdapter[] = [];
    let first = true;

    const agentModule = makeFakeModule({
      create: async (args) => {
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        if (first) {
          adapter.stopError = new Error("stop boom");
          first = false;
        }
        adapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({ type: "user.message", clientSessionId: "client-1", text: "hello" });
    await imAdapter.emit({ type: "user.message", clientSessionId: "client-2", text: "hello" });
    await waitFor(() => {
      expect(adapters[0]!.inputs).toEqual([{ type: "user.message", text: "hello" }]);
      expect(adapters[1]!.inputs).toEqual([{ type: "user.message", text: "hello" }]);
    });

    await core.stop();

    // The throwing stop did not prevent the healthy runtime from being stopped
    // or the bindings from being drained.
    expect(adapters[0]!.stopCount).toBe(1);
    expect(adapters[1]!.stopCount).toBe(1);
    expect(store.state.bindings).toEqual({
      "client-1": adapters[0]!.agentSessionId,
      "client-2": adapters[1]!.agentSessionId,
    });
  });

  it("unblocks an in-flight user message during stop by stopping its adapter", async () => {
    const imAdapter = new FakeIMAdapter();
    let adapter!: BlockingInputAdapter;

    const agentModule = makeFakeModule({
      create: async (args) => {
        adapter = new BlockingInputAdapter(args.agentSessionId);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    // The user message handler enters and blocks inside agentAdapter.input().
    const messageEmit = imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });
    await waitFor(() => {
      expect(adapter.inputEntered).toBe(1);
    });

    // stop() must not wait forever on the blocked handler: it stops the
    // adapter first, which unblocks input() and lets the handler settle.
    await core.stop();
    expect(adapter.stopCount).toBe(1);

    await messageEmit;
    expect(adapter.inputResolved).toBe(1);
  });

  it("replies with a localized resume-failure message and keeps the binding when resume throws", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore({
      bindings: { "client-1": "agent-1" },
      records: { "agent-1": recordFor("agent-1", { version: 1, workingDirectory: "/tmp/project-a" }) },
    });
    let resumeCalls = 0;

    const agentModule = makeFakeModule({
      create: async (args) => new FakeAgentAdapter(args.agentSessionId),
      resume: async () => {
        resumeCalls += 1;
        throw new Error("resume boom");
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "client-1",
        text: "Failed to resume the agent session: resume boom\nStart a new session with `/new`.",
      });
    });

    // Exactly one reply is delivered for this single failure.
    const replies = imAdapter.outputs.filter(
      (event) => event.type === "assistant.message" && event.clientSessionId === "client-1",
    );
    expect(replies).toHaveLength(1);

    // The persisted binding and record are untouched so a later message retries.
    expect(store.state.bindings).toEqual({ "client-1": "agent-1" });
    expect(store.state.agentSessions["agent-1"]).toBeDefined();
    expect(resumeCalls).toBe(1);
  });

  it("replies with a localized resume-failure message when /status hits a failing restore", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore({
      bindings: { "client-1": "agent-1" },
      records: { "agent-1": recordFor("agent-1", { version: 1 }) },
    });

    const agentModule = makeFakeModule({
      create: async (args) => new FakeAgentAdapter(args.agentSessionId),
      resume: async () => {
        throw new Error("resume status boom");
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
      common: {
        channelName: "demo-channel",
        language: "zh-CN",
      },
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "command.session.status",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "client-1",
        text: "恢复智能体会话失败：resume status boom\n请使用 `/new` 开始新会话。",
      });
    });

    // The generic status-unavailable error must not also be emitted for the
    // same failure.
    expect(
      imAdapter.outputs.some((event) => event.type === "error" && event.kind === "agent.status.unavailable"),
    ).toBe(false);
  });

  it("replies with a localized resume-failure message when /compact hits a failing restore", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore({
      bindings: { "client-1": "agent-1" },
      records: { "agent-1": recordFor("agent-1", { version: 1, workingDirectory: "/tmp/project-a" }) },
    });
    let resumeCalls = 0;

    const agentModule = makeFakeModule({
      create: async (args) => new FakeAgentAdapter(args.agentSessionId),
      resume: async () => {
        resumeCalls += 1;
        throw new Error("resume compact boom");
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "command.session.compact",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "client-1",
        text: "Failed to resume the agent session: resume compact boom\nStart a new session with `/new`.",
      });
    });

    // Exactly one reply is delivered for this single failure: the compact
    // command must not additionally fall through to the no-active-session
    // message or emit any error event.
    const replies = imAdapter.outputs.filter(
      (event) => event.type === "assistant.message" && event.clientSessionId === "client-1",
    );
    expect(replies).toHaveLength(1);
    expect(
      imAdapter.outputs.some((event) => event.text === "No active agent session to compact."),
    ).toBe(false);

    // The persisted binding and record are untouched.
    expect(store.state.bindings).toEqual({ "client-1": "agent-1" });
    expect(store.state.agentSessions["agent-1"]).toBeDefined();
    expect(resumeCalls).toBe(1);
  });

  it("cleans up a partially started resumed adapter and keeps the persisted binding", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore({
      bindings: { "client-1": "agent-1" },
      records: { "agent-1": recordFor("agent-1", { version: 1, workingDirectory: "/tmp/project-a" }) },
    });
    const resumedAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      create: async (args) => new FakeAgentAdapter(args.agentSessionId),
      resume: async (args) => {
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        adapter.startError = new Error("resume start boom");
        resumedAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(resumedAdapters).toHaveLength(1);
      expect(resumedAdapters[0]!.stopCount).toBe(1);
    });

    // The user receives the localized resume-failure message with the detail
    // and a /new hint, and no other reply is delivered for this failure.
    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "client-1",
        text: "Failed to resume the agent session: resume start boom\nStart a new session with `/new`.",
      });
    });
    const replies = imAdapter.outputs.filter(
      (event) => event.type === "assistant.message" && event.clientSessionId === "client-1",
    );
    expect(replies).toHaveLength(1);

    // The persisted binding and record are untouched.
    expect(store.state.bindings).toEqual({ "client-1": "agent-1" });
    expect(store.state.agentSessions["agent-1"]).toBeDefined();

    // A later message retries the restore from the same binding.
    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "retry",
    });
    await waitFor(() => {
      expect(resumedAdapters).toHaveLength(2);
    });
    expect(store.state.bindings).toEqual({ "client-1": "agent-1" });
  });

  it("replies with a localized resume-failure message when the persisted record has the wrong agent type", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore({
      bindings: { "client-1": "agent-1" },
      records: { "agent-1": recordFor("agent-1", { version: 1 }, "pi-coding-agent") },
    });

    const agentModule = makeFakeModule({
      create: async (args) => new FakeAgentAdapter(args.agentSessionId),
      resume: async (args) => new FakeAgentAdapter(args.agentSessionId),
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual(
        expect.objectContaining({
          type: "assistant.message",
          clientSessionId: "client-1",
          text: expect.stringContaining("Failed to resume the agent session"),
        }),
      );
      expect(imAdapter.outputs).toContainEqual(
        expect.objectContaining({
          type: "assistant.message",
          clientSessionId: "client-1",
          text: expect.stringContaining('has agentType "pi-coding-agent"'),
        }),
      );
    });
    expect(store.state.bindings).toEqual({ "client-1": "agent-1" });
  });

  it("returns a message when compact is requested without an active agent session", async () => {
    const imAdapter = new FakeIMAdapter();

    const agentModule = makeFakeModule();

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "command.session.compact",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "client-1",
        text: "No active agent session to compact.",
      });
    });
  });

  it("forwards stop to the agent without pre-checking its busy state", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    await imAdapter.emit({
      type: "command.session.stop",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(createdAdapters[0]!.abortCount).toBe(1);
    });
  });

  it("returns a message when stop is requested without an active agent session", async () => {
    const imAdapter = new FakeIMAdapter();

    const agentModule = makeFakeModule();

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "command.session.stop",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "client-1",
        text: "No active agent session to stop.",
      });
    });
  });

  it("forwards agent session status info back to the client adapter", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      create: async (args) => {
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        adapter.statusResult = {
          sessionId: args.agentSessionId,
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          thinkingLevel: "medium",
          context: {
            tokens: 60_000,
            contextWindow: 200_000,
            percent: 30,
          },
        };
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    await imAdapter.emit({
      type: "command.session.status",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(imAdapter.outputs.at(-1)).toEqual({
        type: "agent.status.info",
        clientSessionId: "client-1",
        status: {
          sessionId: createdAdapters[0]!.agentSessionId,
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          thinkingLevel: "medium",
          context: {
            tokens: 60_000,
            contextWindow: 200_000,
            percent: 30,
          },
        },
      });
    });
  });

  it("emits a generic unavailable error event when no active agent session exists for /status", async () => {
    const imAdapter = new FakeIMAdapter();

    const agentModule = makeFakeModule();

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "command.session.status",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(imAdapter.outputs.at(-1)).toEqual({
        type: "error",
        clientSessionId: "client-1",
        kind: "agent.status.unavailable",
      });
    });
  });

  it("emits a generic unavailable error event with detail when status lookup fails", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      create: async (args) => {
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        adapter.statusError = new Error("RPC timeout");
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    await imAdapter.emit({
      type: "command.session.status",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(imAdapter.outputs.at(-1)).toEqual({
        type: "error",
        clientSessionId: "client-1",
        kind: "agent.status.unavailable",
        detail: "RPC timeout",
      });
    });
  });

  it("forwards available model lists back to the client adapter", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      create: async (args) => {
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        adapter.availableModels = [
          { provider: "anthropic", modelId: "claude-sonnet-4-5", isCurrent: true },
          { provider: "openai", modelId: "gpt-5", isCurrent: false },
        ];
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    await imAdapter.emit({
      type: "command.session.model.list",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(imAdapter.outputs.at(-1)).toEqual({
        type: "agent.model.list",
        clientSessionId: "client-1",
        models: [
          { provider: "anthropic", modelId: "claude-sonnet-4-5", isCurrent: true },
          { provider: "openai", modelId: "gpt-5", isCurrent: false },
        ],
      });
    });
  });

  it("emits a model-list unavailable error when no active agent session exists for /model", async () => {
    const imAdapter = new FakeIMAdapter();

    const agentModule = makeFakeModule();

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "command.session.model.list",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(imAdapter.outputs.at(-1)).toEqual({
        type: "error",
        clientSessionId: "client-1",
        kind: "agent.model.list.unavailable",
      });
    });
  });

  it("emits a model-updated event when model switching succeeds", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      create: async (args) => {
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        adapter.setModelResult = {
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
        };
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    await imAdapter.emit({
      type: "command.session.model.set",
      clientSessionId: "client-1",
      target: "anthropic/claude-sonnet-4-5",
    });

    await waitFor(() => {
      expect(createdAdapters[0]?.setModelCalls).toEqual(["anthropic/claude-sonnet-4-5"]);
      expect(imAdapter.outputs.at(-1)).toEqual({
        type: "agent.model.updated",
        clientSessionId: "client-1",
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });
    });
  });

  it("reaches the adapter and switches the model even during an active turn", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      create: async (args) => {
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        // T1: busy state is adapter-internal — a mid-turn /model reaches the
        // adapter, which answers (or errors) on its own.
        adapter.setModelResult = {
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
        };
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    await imAdapter.emit({
      type: "command.session.model.set",
      clientSessionId: "client-1",
      target: "anthropic/claude-sonnet-4-5",
    });

    await waitFor(() => {
      expect(createdAdapters[0]?.setModelCalls).toEqual(["anthropic/claude-sonnet-4-5"]);
      expect(imAdapter.outputs.at(-1)).toEqual({
        type: "agent.model.updated",
        clientSessionId: "client-1",
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });
    });
  });

  it("emits an invalid-model error with detail when switching model fails validation", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      create: async (args) => {
        const adapter = new FakeAgentAdapter(args.agentSessionId);
        const error = new Error("Model not found: anthropic/unknown");
        Object.assign(error, { kind: "agent.model.invalid" });
        adapter.setModelError = error;
        createdAdapters.push(adapter);
        return adapter;
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    await imAdapter.emit({
      type: "command.session.model.set",
      clientSessionId: "client-1",
      target: "anthropic/unknown",
    });

    await waitFor(() => {
      expect(imAdapter.outputs.at(-1)).toEqual({
        type: "error",
        clientSessionId: "client-1",
        kind: "agent.model.invalid",
        detail: "Model not found: anthropic/unknown",
      });
    });
  });

  it("forwards non-message agent events to the client adapter without aggregating them", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const agentModule = makeFakeModule({ createdAdapters });

      const core = new GatewayCore({
        imAdapter,
        agentModule,
        agentConfig: {},
        agentIdleTimeoutMs: 60_000,
      });
      running.push(core);
      await core.start();

      await imAdapter.emit({
        type: "user.message",
        clientSessionId: "client-1",
        text: "hello",
      });

      await waitFor(() => {
        expect(createdAdapters).toHaveLength(1);
      });

      await createdAdapters[0]!.emit({
        type: "assistant.thinking",
        agentSessionId: createdAdapters[0]!.agentSessionId,
        text: "Planning next step",
      });
      await createdAdapters[0]!.emit({
        type: "assistant.tool.running",
        agentSessionId: createdAdapters[0]!.agentSessionId,
        toolName: "read_file",
        text: undefined,
      });

      await waitFor(() => {
        expect(imAdapter.outputs.at(-1)).toEqual({
          type: "assistant.tool.running",
          clientSessionId: "client-1",
          agentSessionId: createdAdapters[0]!.agentSessionId,
          toolName: "read_file",
          text: undefined,
        });
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[core]"),
        "forwarding tool event from agent",
        {
          type: "assistant.tool.running",
          agentSessionId: createdAdapters[0]!.agentSessionId,
          clientSessionId: "client-1",
          toolName: "read_file",
          text: undefined,
        },
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("input() processes synthetic events like adapter messages with schedule bindings kept in memory only", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    // A fresh task run fires through the public ingress: session.new first
    // (spec D1), then the prompt as a user.message.
    await core.input({
      type: "command.session.new",
      clientSessionId: "schedule:report:1",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "default",
    });
    await core.input({
      type: "user.message",
      clientSessionId: "schedule:report:1",
      text: "produce the report",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
      expect(createdAdapters[0]!.inputs).toEqual([{ type: "user.message", text: "produce the report" }]);
      // The agent session record is still created like for any session ...
      expect(store.state.agentSessions[createdAdapters[0]!.agentSessionId]).toBeDefined();
    });

    // ... but the schedule:* binding never reaches the state file (spec D1),
    // and no "started a new session" confirmation is delivered (T3 review).
    expect(store.state.bindings).toEqual({});
    expect(imAdapter.outputs).toEqual([]);

    // SF-1: releasing the runtime (stop path) deletes the ephemeral record, so
    // a restart leaves no residue in the state file.
    const agentSessionId = createdAdapters[0]!.agentSessionId;
    await core.stop();
    expect(store.state.agentSessions[agentSessionId]).toBeUndefined();
  });

  it("input() resolves { ok: true } on success for session.new and user.message", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const core = new GatewayCore({
      imAdapter,
      agentModule: makeFakeModule({ createdAdapters }),
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    // Run-history spec D5: a successful session.new carries the freshly
    // created session's core-owned id; the follow-up user.message result
    // stays a bare { ok: true }.
    await expect(
      core.input({
        type: "command.session.new",
        clientSessionId: "schedule:report:1",
        workingDirectory: "/tmp/project-a",
        workingDirectorySource: "default",
      }),
    ).resolves.toEqual({ ok: true, agentSessionId: expect.any(String) });
    const sessionResult = await core.input({
      type: "command.session.new",
      clientSessionId: "schedule:report:2",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "default",
    });
    expect(sessionResult.ok).toBe(true);
    if (sessionResult.ok) {
      expect(createdAdapters.map((a) => a.agentSessionId)).toContain(sessionResult.agentSessionId);
    }
    await expect(
      core.input({
        type: "user.message",
        clientSessionId: "schedule:report:1",
        text: "produce the report",
      }),
    ).resolves.toEqual({ ok: true });
    await waitFor(() => expect(createdAdapters).toHaveLength(2));
  });

  it("surfaces a failed schedule session.new as { ok: false } without delivering to the IM adapter", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    // A session creation failure (for example an invalid/unavailable task
    // model rejected by the adapter) for a schedule:* id.
    const agentModule = makeFakeModule({
      createdAdapters,
      create: async () => {
        throw new Error("boom: model not available");
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    const result = await core.input({
      type: "command.session.new",
      clientSessionId: "schedule:report:1",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "default",
    });
    expect(result).toEqual({ ok: false, reason: "boom: model not available" });

    // Nothing reached the IM adapter: a schedule:* id cannot be resolved by
    // any adapter, so the failure surfaces through the ingress result only
    // (T6) — the scheduler delivers the failure to the task's target chat.
    expect(imAdapter.outputs).toEqual([]);
    expect(createdAdapters).toHaveLength(0);
  });

  it("chat /new failure still delivers the localized notice and input() resolves with { ok: false }", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({
      createdAdapters,
      create: async () => {
        throw new Error("boom: cannot create");
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    // The ingress never rejects — adapters rely on that — and the localized
    // notice still reaches the chat, unchanged from before T6.
    await expect(
      core.input({
        type: "command.session.new",
        clientSessionId: "client-1",
        workingDirectory: "/tmp/project-a",
        workingDirectorySource: "user",
      }),
    ).resolves.toEqual({ ok: false, reason: "boom: cannot create" });
    expect(
      imAdapter.outputs.some(
        (event) =>
          event.type === "assistant.message" && event.text.includes("Failed to start a new session"),
      ),
    ).toBe(true);
  });

  it("drops a user.message for an unbound schedule:* id instead of auto-creating a session", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const agentModule = makeFakeModule({ createdAdapters });

      const core = new GatewayCore({
        imAdapter,
        agentModule,
        agentConfig: {},
        agentIdleTimeoutMs: 60_000,
        channelStateStore: store,
      });
      running.push(core);
      await core.start();

      // A user.message with no prior session.new must never auto-create a
      // session (T6): schedule:* sessions are created exclusively by their
      // synthetic session.new (spec D1), and auto-creation would run without
      // the task's model override. The orphan message is logged and dropped;
      // the intentional drop counts as handled.
      await expect(
        core.input({
          type: "user.message",
          clientSessionId: "schedule:report:1",
          text: "produce the report",
        }),
      ).resolves.toEqual({ ok: true });
      expect(createdAdapters).toHaveLength(0);
      expect(imAdapter.outputs).toEqual([]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[core]"),
        expect.stringContaining("dropping user.message for unbound schedule session schedule:report:1"),
      );

      // A bound schedule session still works: session.new then user.message,
      // and the binding stays memory-only (spec D1).
      await core.input({
        type: "command.session.new",
        clientSessionId: "schedule:report:1",
        workingDirectory: "/tmp/project-a",
        workingDirectorySource: "default",
      });
      await core.input({
        type: "user.message",
        clientSessionId: "schedule:report:1",
        text: "produce the report",
      });
      await waitFor(() => {
        expect(createdAdapters).toHaveLength(1);
        expect(createdAdapters[0]!.inputs).toEqual([{ type: "user.message", text: "produce the report" }]);
      });
      expect(store.state.bindings).toEqual({});
    } finally {
      logSpy.mockRestore();
    }
  });

  it("deletes the agent session record when a schedule:* runtime is released by the idle timer", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 10,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    // Spec D1: schedule sessions are created by their synthetic session.new;
    // the follow-up user.message then finds the in-memory binding.
    await core.input({
      type: "command.session.new",
      clientSessionId: "schedule:report:1",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "default",
    });
    await core.input({
      type: "user.message",
      clientSessionId: "schedule:report:1",
      text: "produce the report",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    // #releaseIdleRuntime → #stopRuntime releases the runtime; for an
    // ephemeral schedule session the record is deleted with it (SF-1), while
    // the memory-only binding never touches the state file (spec D1).
    const agentSessionId = createdAdapters[0]!.agentSessionId;
    await waitFor(() => {
      expect(store.state.agentSessions[agentSessionId]).toBeUndefined();
    });
    expect(store.state.bindings).toEqual({});
  });

  it("keeps the agent session record of an ordinary session after the runtime is released", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
      expect(store.state.agentSessions[createdAdapters[0]!.agentSessionId]).toBeDefined();
    });

    const agentSessionId = createdAdapters[0]!.agentSessionId;
    await core.stop();

    // Ordinary sessions keep their record (and durable binding) across a
    // stop, so they can be resumed after a restart — the schedule-only
    // deletion in #stopRuntime must not affect them (SF-1).
    expect(store.state.agentSessions[agentSessionId]).toBeDefined();
    expect(store.state.bindings["client-1"]).toBe(agentSessionId);
  });

  it("rejects input() after stop like a late adapter event", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await core.stop();
    // The ingress never rejects: after stop it resolves `{ ok: false }`.
    await expect(
      core.input({
        type: "user.message",
        clientSessionId: "client-1",
        text: "ignored",
      }),
    ).resolves.toEqual({ ok: false, reason: "gateway is not running" });
    await expect(
      core.input({
        type: "command.session.new",
        clientSessionId: "schedule:report:1",
        workingDirectory: "/tmp/project-a",
        workingDirectorySource: "default",
      }),
    ).resolves.toEqual({ ok: false, reason: "gateway is not running" });

    // No runtime was created and nothing was delivered: the shutdown guard
    // applies to the public ingress exactly as it does to adapter messages.
    expect(createdAdapters).toHaveLength(0);
    expect(imAdapter.outputs).toEqual([]);
  });

  it("diverts every schedule:* output event to onScheduleOutput and never to the IM adapter", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];
    const diverted: ClientInputEvent[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const agentModule = makeFakeModule({ createdAdapters });

      const core = new GatewayCore({
        imAdapter,
        agentModule,
        agentConfig: {},
        agentIdleTimeoutMs: 60_000,
        channelStateStore: store,
        onScheduleOutput: (event) => {
          diverted.push(event);
        },
      });
      running.push(core);
      await core.start();

      // Fire a synthetic run through the public ingress (spec D1).
      await core.input({
        type: "command.session.new",
        clientSessionId: "schedule:report:1",
        workingDirectory: "/tmp/project-a",
        workingDirectorySource: "default",
      });
      await core.input({
        type: "user.message",
        clientSessionId: "schedule:report:1",
        text: "produce the report",
      });
      await waitFor(() => {
        expect(createdAdapters).toHaveLength(1);
      });
      const adapter = createdAdapters[0]!;

      // Progress, completion and terminal-error events are all diverted.
      await adapter.emit({
        type: "assistant.thinking",
        agentSessionId: adapter.agentSessionId,
        text: "hmm",
      });
      await adapter.emit({
        type: "assistant.tool.running",
        agentSessionId: adapter.agentSessionId,
        toolName: "read_file",
        text: undefined,
      });
      await adapter.emitAssistant("the final report");
      await adapter.emit({
        type: "error",
        agentSessionId: adapter.agentSessionId,
        kind: "agent.run.failed",
        detail: "boom",
      });

      await waitFor(() => {
        expect(diverted).toHaveLength(4);
      });
      expect(diverted.map(({ type, clientSessionId }) => ({ type, clientSessionId }))).toEqual([
        { type: "assistant.thinking", clientSessionId: "schedule:report:1" },
        { type: "assistant.tool.running", clientSessionId: "schedule:report:1" },
        { type: "assistant.message", clientSessionId: "schedule:report:1" },
        { type: "error", clientSessionId: "schedule:report:1" },
      ]);
      expect(diverted[2]).toMatchObject({ text: "the final report" });
      expect(diverted[3]).toMatchObject({ kind: "agent.run.failed", detail: "boom" });
      // Nothing reached the IM adapter, and the schedule:* binding stayed out
      // of the state file.
      expect(imAdapter.outputs).toEqual([]);
      expect(Object.keys(store.state.bindings).filter((key) => key.startsWith("schedule:"))).toEqual([]);

      // A normal chat session is completely unaffected: same handler, same
      // delivery path, and its binding is still persisted.
      await imAdapter.emit({
        type: "user.message",
        clientSessionId: "client-1",
        text: "hello",
      });
      await waitFor(() => {
        expect(createdAdapters).toHaveLength(2);
      });
      const chatAdapter = createdAdapters[1]!;
      await chatAdapter.emitAssistant("a normal reply");
      await waitFor(() => {
        expect(imAdapter.outputs.some((event) => event.text === "a normal reply")).toBe(true);
        expect(store.state.bindings["client-1"]).toBe(chatAdapter.agentSessionId);
      });
      expect(diverted.some((event) => event.clientSessionId === "client-1")).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("falls back to the IM adapter path for schedule:* output when no onScheduleOutput is injected", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await core.input({
      type: "command.session.new",
      clientSessionId: "schedule:report:1",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "default",
    });
    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    await createdAdapters[0]!.emitAssistant("fallback reply");
    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "schedule:report:1",
        text: "fallback reply",
      });
    });
  });

  it("swallows a throwing onScheduleOutput without affecting the core", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const agentModule = makeFakeModule({ createdAdapters });

      const core = new GatewayCore({
        imAdapter,
        agentModule,
        agentConfig: {},
        agentIdleTimeoutMs: 60_000,
        onScheduleOutput: () => {
          throw new Error("divert boom");
        },
      });
      running.push(core);
      await core.start();

      await core.input({
        type: "command.session.new",
        clientSessionId: "schedule:report:1",
        workingDirectory: "/tmp/project-a",
        workingDirectorySource: "default",
      });
      await waitFor(() => {
        expect(createdAdapters).toHaveLength(1);
      });

      await createdAdapters[0]!.emitAssistant("boom");
      await sleep(30);

      // The divert error was logged and swallowed: no unhandled rejection,
      // nothing delivered to the IM adapter, and the core keeps working.
      expect(imAdapter.outputs).toEqual([]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[core]"),
        "failed to divert schedule output for schedule:report:1:",
        expect.any(Error),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("diverts every queue:* output event to onQueueOutput and never to the IM adapter", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];
    const queueDiverted: ClientInputEvent[] = [];
    const scheduleDiverted: ClientInputEvent[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const agentModule = makeFakeModule({ createdAdapters });

      const core = new GatewayCore({
        imAdapter,
        agentModule,
        agentConfig: {},
        agentIdleTimeoutMs: 60_000,
        channelStateStore: store,
        onScheduleOutput: (event) => {
          scheduleDiverted.push(event);
        },
        onQueueOutput: (event) => {
          queueDiverted.push(event);
        },
      });
      running.push(core);
      await core.start();

      // Fire a queue run through the public ingress (spec D1/D3): session.new
      // first, then the prompt as a user.message.
      await core.input({
        type: "command.session.new",
        clientSessionId: "queue:build:1",
        workingDirectory: "/tmp/project-a",
        workingDirectorySource: "default",
      });
      await core.input({
        type: "user.message",
        clientSessionId: "queue:build:1",
        text: "run the build",
      });
      await waitFor(() => {
        expect(createdAdapters).toHaveLength(1);
      });
      const queueAdapter = createdAdapters[0]!;

      // Progress, completion and terminal-error events are all diverted to the
      // queue callback with the substituted clientSessionId.
      await queueAdapter.emit({
        type: "assistant.thinking",
        agentSessionId: queueAdapter.agentSessionId,
        text: "hmm",
      });
      await queueAdapter.emit({
        type: "assistant.tool.running",
        agentSessionId: queueAdapter.agentSessionId,
        toolName: "read_file",
        text: undefined,
      });
      await queueAdapter.emitAssistant("the build output");
      await queueAdapter.emit({
        type: "error",
        agentSessionId: queueAdapter.agentSessionId,
        kind: "agent.run.failed",
        detail: "boom",
      });

      await waitFor(() => {
        expect(queueDiverted).toHaveLength(4);
      });
      expect(queueDiverted.map(({ type, clientSessionId }) => ({ type, clientSessionId }))).toEqual([
        { type: "assistant.thinking", clientSessionId: "queue:build:1" },
        { type: "assistant.tool.running", clientSessionId: "queue:build:1" },
        { type: "assistant.message", clientSessionId: "queue:build:1" },
        { type: "error", clientSessionId: "queue:build:1" },
      ]);
      expect(queueDiverted[2]).toMatchObject({ text: "the build output" });
      expect(queueDiverted[3]).toMatchObject({ kind: "agent.run.failed", detail: "boom" });
      // Nothing reached the IM adapter, and the queue:* binding stayed out of
      // the state file.
      expect(imAdapter.outputs).toEqual([]);
      expect(Object.keys(store.state.bindings).filter((key) => key.startsWith("queue:"))).toEqual([]);

      // Each controller gets only its own events: a schedule run diverts to
      // the schedule callback, never the queue one.
      await core.input({
        type: "command.session.new",
        clientSessionId: "schedule:report:1",
        workingDirectory: "/tmp/project-a",
        workingDirectorySource: "default",
      });
      await waitFor(() => {
        expect(createdAdapters).toHaveLength(2);
      });
      const scheduleAdapter = createdAdapters[1]!;
      await scheduleAdapter.emitAssistant("a scheduled reply");
      await waitFor(() => {
        expect(scheduleDiverted).toHaveLength(1);
      });
      expect(scheduleDiverted[0]).toMatchObject({
        type: "assistant.message",
        clientSessionId: "schedule:report:1",
        text: "a scheduled reply",
      });
      expect(queueDiverted.some((event) => event.clientSessionId.startsWith("schedule:"))).toBe(false);
      expect(scheduleDiverted.some((event) => event.clientSessionId.startsWith("queue:"))).toBe(false);

      // A normal chat session is completely unaffected: same handler, same
      // delivery path, and its binding is still persisted.
      await imAdapter.emit({
        type: "user.message",
        clientSessionId: "client-1",
        text: "hello",
      });
      await waitFor(() => {
        expect(createdAdapters).toHaveLength(3);
      });
      const chatAdapter = createdAdapters[2]!;
      await chatAdapter.emitAssistant("a normal reply");
      await waitFor(() => {
        expect(imAdapter.outputs.some((event) => event.text === "a normal reply")).toBe(true);
        expect(store.state.bindings["client-1"]).toBe(chatAdapter.agentSessionId);
      });
      expect(queueDiverted.some((event) => event.clientSessionId === "client-1")).toBe(false);
      expect(scheduleDiverted.some((event) => event.clientSessionId === "client-1")).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("falls back to the IM adapter path for queue:* output when no onQueueOutput is injected", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule = makeFakeModule({ createdAdapters });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await core.input({
      type: "command.session.new",
      clientSessionId: "queue:build:1",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "default",
    });
    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });

    await createdAdapters[0]!.emitAssistant("fallback reply");
    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "queue:build:1",
        text: "fallback reply",
      });
    });
  });

  it("swallows a throwing onQueueOutput without affecting the core", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const agentModule = makeFakeModule({ createdAdapters });

      const core = new GatewayCore({
        imAdapter,
        agentModule,
        agentConfig: {},
        agentIdleTimeoutMs: 60_000,
        onQueueOutput: () => {
          throw new Error("divert boom");
        },
      });
      running.push(core);
      await core.start();

      await core.input({
        type: "command.session.new",
        clientSessionId: "queue:build:1",
        workingDirectory: "/tmp/project-a",
        workingDirectorySource: "default",
      });
      await waitFor(() => {
        expect(createdAdapters).toHaveLength(1);
      });

      await createdAdapters[0]!.emitAssistant("boom");
      await sleep(30);

      // The divert error was logged and swallowed: no unhandled rejection,
      // nothing delivered to the IM adapter, and the core keeps working.
      expect(imAdapter.outputs).toEqual([]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[core]"),
        "failed to divert queue output for queue:build:1:",
        expect.any(Error),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("surfaces a failed queue session.new as { ok: false } without delivering to the IM adapter", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    // A session creation failure (for example an invalid/unavailable worker
    // model rejected by the adapter) for a queue:* id.
    const agentModule = makeFakeModule({
      createdAdapters,
      create: async () => {
        throw new Error("boom: model not available");
      },
    });

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      channelStateStore: store,
    });
    running.push(core);
    await core.start();

    const result = await core.input({
      type: "command.session.new",
      clientSessionId: "queue:build:1",
      workingDirectory: "/tmp/project-a",
      workingDirectorySource: "default",
    });
    expect(result).toEqual({ ok: false, reason: "boom: model not available" });

    // Nothing reached the IM adapter: a queue:* id cannot be resolved by any
    // adapter, so the failure surfaces through the ingress result only (T6) —
    // the queue controller delivers the failure to the queue's target chat.
    expect(imAdapter.outputs).toEqual([]);
    expect(createdAdapters).toHaveLength(0);
  });

  it("drops a user.message for an unbound queue:* id, keeps bound runs memory-only, and deletes the record on release", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = makeStore();
    const createdAdapters: FakeAgentAdapter[] = [];
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const agentModule = makeFakeModule({ createdAdapters });

      const core = new GatewayCore({
        imAdapter,
        agentModule,
        agentConfig: {},
        agentIdleTimeoutMs: 60_000,
        channelStateStore: store,
      });
      running.push(core);
      await core.start();

      // A user.message with no prior session.new must never auto-create a
      // session (T6): queue:* sessions are created exclusively by their
      // synthetic session.new (spec D1/D3). The orphan message is logged and
      // dropped; the intentional drop counts as handled.
      await expect(
        core.input({
          type: "user.message",
          clientSessionId: "queue:build:1",
          text: "run the build",
        }),
      ).resolves.toEqual({ ok: true });
      expect(createdAdapters).toHaveLength(0);
      expect(imAdapter.outputs).toEqual([]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[core]"),
        expect.stringContaining("dropping user.message for unbound queue session queue:build:1"),
      );

      // A bound queue session still works: session.new then user.message,
      // and the binding stays memory-only (spec D3).
      await core.input({
        type: "command.session.new",
        clientSessionId: "queue:build:1",
        workingDirectory: "/tmp/project-a",
        workingDirectorySource: "default",
      });
      await core.input({
        type: "user.message",
        clientSessionId: "queue:build:1",
        text: "run the build",
      });
      await waitFor(() => {
        expect(createdAdapters).toHaveLength(1);
        expect(createdAdapters[0]!.inputs).toEqual([{ type: "user.message", text: "run the build" }]);
      });
      expect(store.state.bindings).toEqual({});

      // SF-1: releasing the runtime (stop path) deletes the ephemeral queue
      // record too, so a restart leaves no residue in the state file.
      const agentSessionId = createdAdapters[0]!.agentSessionId;
      await core.stop();
      expect(store.state.agentSessions[agentSessionId]).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("binds a channel-less queue on /queue-here by writing BOTH channel and target", async () => {
    const queuesRoot = await makeTempQueuesDir(tempDirs);
    // `queue add` writes no `channel` (T1): the file only carries workers etc.
    await writeQueueDefinitionFile(queuesRoot, "build");
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const core = new GatewayCore({
      imAdapter,
      agentModule: makeFakeModule({ createdAdapters }),
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      common: { channelName: "feishu-dev", language: "en-US" },
      queuesRoot,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "chat:build-results",
      text: "/queue-here build",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "chat:build-results",
        text: 'Queue "build" is now bound to this chat.',
      });
    });
    // The binding is a plain file write (spec D4): BOTH the current
    // channel's config name and the sending chat's clientSessionId land in
    // the front matter in one atomic write (`bindQueue`). The controller
    // picks the binding up on its next tick reload.
    const content = await readFile(path.join(queuesRoot, "build.md"), "utf8");
    expect(content).toContain("channel: feishu-dev");
    expect(content).toContain("target: chat:build-results");
    // A pure command message never touches the agent session.
    expect(createdAdapters).toHaveLength(0);
  });

  it("replies with a localized error when the queue does not exist", async () => {
    const queuesRoot = await makeTempQueuesDir(tempDirs);
    const imAdapter = new FakeIMAdapter();

    const core = new GatewayCore({
      imAdapter,
      agentModule: makeFakeModule(),
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      common: { channelName: "feishu-dev", language: "en-US" },
      queuesRoot,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "/queue-here missing",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "client-1",
        text: "Queue \"missing\" was not found.",
      });
    });
  });

  it("rebinds a queue with a stale channel line to the current channel (no ownership check anymore)", async () => {
    const queuesRoot = await makeTempQueuesDir(tempDirs);
    // A legacy file may still carry a `channel`; `/queue-here` always
    // overwrites it with the current channel at bind time (T1) — the
    // "belongs to another channel" refusal is gone.
    await writeQueueDefinitionFile(queuesRoot, "build", "feishu-dev");
    const imAdapter = new FakeIMAdapter();

    const core = new GatewayCore({
      imAdapter,
      agentModule: makeFakeModule(),
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      common: { channelName: "wecom-dev", language: "zh-CN" },
      queuesRoot,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "/queue-here build",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "client-1",
        text: '队列 "build" 已绑定到本会话。',
      });
    });
    // Both the channel and the target were written (localized to the chat's
    // own language, zh-CN here).
    const content = await readFile(path.join(queuesRoot, "build.md"), "utf8");
    expect(content).toContain("channel: wecom-dev");
    expect(content).toContain("target: client-1");
  });

  it("refuses to rebind a queue that already has a target", async () => {
    const queuesRoot = await makeTempQueuesDir(tempDirs);
    await writeQueueDefinitionFile(queuesRoot, "build", undefined, {
      target: "chat:old-owner",
    });
    const imAdapter = new FakeIMAdapter();

    const core = new GatewayCore({
      imAdapter,
      agentModule: makeFakeModule(),
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      common: { channelName: "feishu-dev", language: "en-US" },
      queuesRoot,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "/queue-here build",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "client-1",
        text: expect.stringContaining('Queue "build" is already bound'),
      });
    });
    // The existing binding is untouched (rebinding is an AI file edit).
    const content = await readFile(path.join(queuesRoot, "build.md"), "utf8");
    expect(content).toContain("target: chat:old-owner");
  });

  it("shows a usage reply for a malformed /queue-here without touching the agent session", async () => {
    const queuesRoot = await makeTempQueuesDir(tempDirs);
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const core = new GatewayCore({
      imAdapter,
      agentModule: makeFakeModule({ createdAdapters }),
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      common: { channelName: "feishu-dev", language: "en-US" },
      queuesRoot,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "/queue-here",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "client-1",
        text: "Usage: `/queue-here <queue-name>` (queue names match `[a-z0-9-]+`).",
      });
    });
    expect(createdAdapters).toHaveLength(0);
  });
});
