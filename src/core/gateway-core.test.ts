import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayCore } from "./gateway-core";
import type {
  AgentAdapter,
  AgentInputEvent,
  AgentModule,
  AgentOutputEvent,
  ChannelCommonContext,
  ClientInputEvent,
  ClientOutputEvent,
  IMAdapter,
  SessionBinding,
  SessionBindingStore,
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
  busy = false;
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

  async isBusy(): Promise<boolean> {
    return this.busy;
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

class FakeBindingStore implements SessionBindingStore {
  readonly saved: Array<Record<string, SessionBinding>> = [];

  constructor(readonly initial: Record<string, string | SessionBinding> = {}) {}

  async load(): Promise<Record<string, SessionBinding>> {
    const bindings: Record<string, SessionBinding> = {};
    for (const [clientSessionId, value] of Object.entries(this.initial)) {
      bindings[clientSessionId] =
        typeof value === "string" ? { agentSessionId: value } : value;
    }
    return bindings;
  }

  async save(bindings: Record<string, SessionBinding>): Promise<void> {
    this.saved.push({ ...bindings });
  }
}

/**
 * Binding store whose saves stay in flight until explicitly released, so tests
 * can observe save ordering, concurrency, and failure recovery.
 */
class DeferredBindingStore implements SessionBindingStore {
  readonly saved: Array<Record<string, SessionBinding>> = [];
  readonly deferreds: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  maxConcurrent = 0;
  failNextSave = false;
  #inFlight = 0;

  async load(): Promise<Record<string, SessionBinding>> {
    return {};
  }

  async save(bindings: Record<string, SessionBinding>): Promise<void> {
    this.#inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#inFlight);
    if (this.failNextSave) {
      this.failNextSave = false;
      this.#inFlight -= 1;
      throw new Error("save boom");
    }
    this.saved.push({ ...bindings });
    await new Promise<void>((resolve, reject) => {
      this.deferreds.push({ resolve, reject });
    });
    this.#inFlight -= 1;
  }
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

describe("GatewayCore", () => {
  const running: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    while (running.length > 0) {
      await running.pop()!.stop();
    }
  });

  it("passes the channel common context to agent session lifecycle calls", async () => {
    const imAdapter = new FakeIMAdapter();
    const bindingStore = new FakeBindingStore({ "client-1": "agent-1" });
    const createArgs: Array<{ common: ChannelCommonContext }> = [];
    const resumeArgs: Array<{ common: ChannelCommonContext; agentSessionId: string }> = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession(args) {
        createArgs.push(args as { common: ChannelCommonContext });
        return {
          agentSessionId: "agent-new",
          agentAdapter: new FakeAgentAdapter("agent-new"),
        };
      },
      async resumeAgentSession(args) {
        resumeArgs.push(args as { common: ChannelCommonContext; agentSessionId: string });
        return new FakeAgentAdapter(args.agentSessionId);
      },
    };

    const common: ChannelCommonContext = {
      channelName: "demo-channel",
      language: "zh-CN",
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore,
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
      expect(resumeArgs).toEqual([{ common, agentSessionId: "agent-1", config: {} }]);
      expect(createArgs).toEqual([{ common, config: {} }]);
    });
  });

  it("localizes fixed gateway messages with the configured channel language", async () => {
    const imAdapter = new FakeIMAdapter();

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        return {
          agentSessionId: "agent-1",
          agentAdapter: new FakeAgentAdapter("agent-1"),
        };
      },
    };

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

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentSessionId = `agent-${createdAdapters.length + 1}`;
        const agentAdapter = new FakeAgentAdapter(agentSessionId);
        createdAdapters.push(agentAdapter);
        return { agentSessionId, agentAdapter };
      },
    };

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
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(2);
      expect(first.stopCount).toBe(1);
      expect(imAdapter.outputs.some((event) => event.text === "Started a new session.")).toBe(true);
    });

    await first.emitAssistant("late old reply");
    await sleep(30);

    expect(imAdapter.outputs.some((event) => event.text === "late old reply")).toBe(false);
  });

  it("drops output from an agent session released after idle timeout", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentSessionId = `agent-${createdAdapters.length + 1}`;
        const agentAdapter = new FakeAgentAdapter(agentSessionId);
        agentAdapter.retainOutputCallback = true;
        createdAdapters.push(agentAdapter);
        return { agentSessionId, agentAdapter };
      },
    };

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
    const bindingStore = new FakeBindingStore({ "client-1": "agent-1" });
    const resumed: string[] = [];
    let createCount = 0;
    const resumedAdapters: FakeAgentAdapter[] = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        createCount += 1;
        return {
          agentSessionId: "agent-new",
          agentAdapter: new FakeAgentAdapter("agent-new"),
        };
      },
      async resumeAgentSession({ agentSessionId }) {
        resumed.push(agentSessionId);
        const adapter = new FakeAgentAdapter(agentSessionId);
        resumedAdapters.push(adapter);
        return adapter;
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore,
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

  it("persists the binding when a new agent session is created", async () => {
    const imAdapter = new FakeIMAdapter();
    const bindingStore = new FakeBindingStore();

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        return {
          agentSessionId: "agent-1",
          agentAdapter: new FakeAgentAdapter("agent-1"),
        };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(bindingStore.saved.at(-1)).toEqual({ "client-1": { agentSessionId: "agent-1" } });
    });
  });

  it("passes workingDirectory from /new into createAgentSession and persists it in the binding", async () => {
    const imAdapter = new FakeIMAdapter();
    const bindingStore = new FakeBindingStore();
    const createdDirs: Array<string | undefined> = [];
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession(args) {
        createdDirs.push(args.workingDirectory);
        const agentSessionId = `agent-${createdAdapters.length + 1}`;
        const agentAdapter = new FakeAgentAdapter(agentSessionId);
        createdAdapters.push(agentAdapter);
        return { agentSessionId, agentAdapter };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore,
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
    });

    await waitFor(() => {
      expect(createdDirs.at(-1)).toBe("/tmp/project-a");
      expect(createdAdapters[0]!.stopCount).toBe(1);
      expect(bindingStore.saved.at(-1)).toEqual({
        "client-1": { agentSessionId: "agent-2", workingDirectory: "/tmp/project-a" },
      });
      expect(imAdapter.outputs.some((event) => event.text === "Started a new session.")).toBe(true);
    });
  });

  it("keeps the no-argument /new behavior and omits workingDirectory", async () => {
    const imAdapter = new FakeIMAdapter();
    const bindingStore = new FakeBindingStore();
    const createdDirs: Array<string | undefined> = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession(args) {
        createdDirs.push(args.workingDirectory);
        return {
          agentSessionId: `agent-${createdDirs.length}`,
          agentAdapter: new FakeAgentAdapter(`agent-${createdDirs.length}`),
        };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(createdDirs).toEqual([undefined]);
      expect(bindingStore.saved.at(-1)).toEqual({
        "client-1": { agentSessionId: "agent-1" },
      });
      expect(imAdapter.outputs.some((event) => event.text === "Started a new session.")).toBe(true);
    });
  });

  it("passes the persisted workingDirectory to resumeAgentSession on restore", async () => {
    const imAdapter = new FakeIMAdapter();
    const bindingStore = new FakeBindingStore({
      "client-1": { agentSessionId: "agent-1", workingDirectory: "/tmp/project-a" },
    });
    const resumed: Array<{ agentSessionId: string; workingDirectory?: string }> = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        return {
          agentSessionId: "agent-new",
          agentAdapter: new FakeAgentAdapter("agent-new"),
        };
      },
      async resumeAgentSession(args) {
        resumed.push({ agentSessionId: args.agentSessionId, workingDirectory: args.workingDirectory });
        return new FakeAgentAdapter(args.agentSessionId);
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore,
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
    const bindingStore = new FakeBindingStore({
      "client-1": { agentSessionId: "agent-1", workingDirectory: "/tmp/project-a" },
    });
    const resumedDirs: Array<string | undefined> = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        return {
          agentSessionId: "agent-new",
          agentAdapter: new FakeAgentAdapter("agent-new"),
        };
      },
      async resumeAgentSession(args) {
        resumedDirs.push(args.workingDirectory);
        return new FakeAgentAdapter(args.agentSessionId);
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 20,
      bindingStore,
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
    const bindingStore = new FakeBindingStore();
    const createdAdapters: FakeAgentAdapter[] = [];
    let failNextCreate = false;

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        if (failNextCreate) {
          throw new Error("boom: cannot create");
        }
        const agentAdapter = new FakeAgentAdapter(`agent-${createdAdapters.length + 1}`);
        createdAdapters.push(agentAdapter);
        return { agentSessionId: `agent-${createdAdapters.length}`, agentAdapter };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore,
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
    });

    await waitFor(() => {
      expect(createdAdapters[0]!.stopCount).toBe(0);
      expect(bindingStore.saved.at(-1)).toEqual({
        "client-1": { agentSessionId: "agent-1" },
      });
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
    const bindingStore = new FakeBindingStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentAdapter = new FakeAgentAdapter(`agent-${createdAdapters.length + 1}`);
        if (createdAdapters.length > 0) {
          agentAdapter.startError = new Error("start boom");
        }
        createdAdapters.push(agentAdapter);
        return { agentSessionId: `agent-${createdAdapters.length}`, agentAdapter };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore,
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
    });

    await waitFor(() => {
      expect(createdAdapters[1]!.stopCount).toBe(1);
      expect(createdAdapters[0]!.stopCount).toBe(0);
      expect(bindingStore.saved.at(-1)).toEqual({
        "client-1": { agentSessionId: "agent-1" },
      });
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
    const bindingStore = new FakeBindingStore();
    const createdAdapters: FakeAgentAdapter[] = [];
    const createCalls: Array<{ workingDirectory?: string; allowedWorkingDirectoryRoots?: string[] }> = [];

    // Fake module enforcing the same contract the real providers implement:
    // a user-supplied workingDirectory must resolve inside an allowed root.
    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession(args) {
        createCalls.push({
          workingDirectory: args.workingDirectory,
          allowedWorkingDirectoryRoots: args.allowedWorkingDirectoryRoots,
        });
        const roots = args.allowedWorkingDirectoryRoots ?? [];
        const wd = args.workingDirectory;
        if (wd !== undefined && roots.length > 0) {
          const allowed = roots.some(
            (root) => wd === root || wd.startsWith(`${root.replace(/\/+$/, "")}/`),
          );
          if (!allowed) {
            throw new Error(`working directory "${wd}" is not inside an allowed root`);
          }
        }
        const agentAdapter = new FakeAgentAdapter(`agent-${createdAdapters.length + 1}`);
        createdAdapters.push(agentAdapter);
        return { agentSessionId: `agent-${createdAdapters.length}`, agentAdapter };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      allowedWorkingDirectoryRoots: ["/tmp/allowed"],
      bindingStore,
    });
    running.push(core);
    await core.start();

    // Bare /new (no workingDirectory) is not allowlist-checked and succeeds.
    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
    });
    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
    });
    expect(createCalls[0]!.workingDirectory).toBeUndefined();
    expect(createCalls[0]!.allowedWorkingDirectoryRoots).toEqual(["/tmp/allowed"]);

    // The out-of-root override is rejected before any teardown of the old session.
    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/outside",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
      expect(createdAdapters[0]!.stopCount).toBe(0);
      expect(bindingStore.saved.at(-1)).toEqual({
        "client-1": { agentSessionId: "agent-1" },
      });
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
    const bindingStore = new FakeBindingStore({
      "client-1": { agentSessionId: "agent-1", workingDirectory: "/tmp/allowed/project" },
    });
    const resumed: Array<{ agentSessionId: string; workingDirectory?: string; allowedWorkingDirectoryRoots?: string[] }> = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        return {
          agentSessionId: "agent-new",
          agentAdapter: new FakeAgentAdapter("agent-new"),
        };
      },
      async resumeAgentSession(args) {
        resumed.push({
          agentSessionId: args.agentSessionId,
          workingDirectory: args.workingDirectory,
          allowedWorkingDirectoryRoots: args.allowedWorkingDirectoryRoots,
        });
        return new FakeAgentAdapter(args.agentSessionId);
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      allowedWorkingDirectoryRoots: ["/tmp/allowed"],
      bindingStore,
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

  it("continues the /new switch when stopping the previous runtime throws", async () => {
    const imAdapter = new FakeIMAdapter();
    const bindingStore = new FakeBindingStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const id = `agent-${createdAdapters.length + 1}`;
        const agentAdapter = new FakeAgentAdapter(id);
        createdAdapters.push(agentAdapter);
        return { agentSessionId: id, agentAdapter };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore,
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
    });

    expect(createdAdapters).toHaveLength(2);
    expect(createdAdapters[0]!.stopCount).toBe(1);
    expect(createdAdapters[1]!.stopCount).toBe(0);
    expect(bindingStore.saved.at(-1)).toEqual({
      "client-1": { agentSessionId: "agent-2", workingDirectory: "/tmp/project-a" },
    });
    expect(imAdapter.outputs.some((event) => event.text === "Started a new session.")).toBe(true);

    // The new runtime is bound and reachable: a follow-up message goes to agent-2
    // and is never routed to the stale (failed-stop) runtime.
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

  it("serializes binding saves so the latest binding wins with at most one concurrent save", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = new DeferredBindingStore();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const id = `agent-${createdAdapters.length + 1}`;
        const agentAdapter = new FakeAgentAdapter(id);
        createdAdapters.push(agentAdapter);
        return { agentSessionId: id, agentAdapter };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore: store,
    });
    running.push(core);
    await core.start();

    const first = imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-a",
    });
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(1);
    });
    expect(store.maxConcurrent).toBe(1);

    const second = imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-b",
    });
    // The second save is queued behind the first: it must not be in flight yet.
    await sleep(30);
    expect(store.saved).toHaveLength(1);
    expect(store.maxConcurrent).toBe(1);

    store.deferreds[0]!.resolve();
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(2);
    });
    expect(store.maxConcurrent).toBe(1);
    store.deferreds[1]!.resolve();

    await first;
    await second;

    expect(store.saved).toHaveLength(2);
    expect(store.saved.at(-1)).toEqual({
      "client-1": { agentSessionId: "agent-2", workingDirectory: "/tmp/project-b" },
    });
    expect(store.maxConcurrent).toBe(1);
    expect(
      imAdapter.outputs.filter((event) => event.type === "assistant.message" && event.text === "Started a new session."),
    ).toHaveLength(2);
  });

  it("recovers the binding-save queue after a failed save and still persists the latest binding", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = new DeferredBindingStore();
    store.failNextSave = true;
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const id = `agent-${createdAdapters.length + 1}`;
        const agentAdapter = new FakeAgentAdapter(id);
        createdAdapters.push(agentAdapter);
        return { agentSessionId: id, agentAdapter };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore: store,
    });
    running.push(core);
    await core.start();

    // First save fails synchronously; the /new flow must not reject and must
    // still confirm success (the in-memory binding stays authoritative).
    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-a",
    });
    expect(store.saved).toHaveLength(0);
    expect(imAdapter.outputs.some((event) => event.text === "Started a new session.")).toBe(true);

    // The queue stays alive: the next save runs and persists the latest binding.
    const second = imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
      workingDirectory: "/tmp/project-b",
    });
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(1);
    });
    store.deferreds[0]!.resolve();
    await second;

    expect(store.saved.at(-1)).toEqual({
      "client-1": { agentSessionId: "agent-2", workingDirectory: "/tmp/project-b" },
    });
  });

  it("drains pending binding saves before core.stop resolves", async () => {
    const imAdapter = new FakeIMAdapter();
    const store = new DeferredBindingStore();

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        return { agentSessionId: "agent-1", agentAdapter: new FakeAgentAdapter("agent-1") };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore: store,
    });
    running.push(core);
    await core.start();

    // user.message binds through the fire-and-forget path, so the save is still
    // pending after emit resolves.
    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });
    await waitFor(() => {
      expect(store.deferreds).toHaveLength(1);
    });

    let stopped = false;
    const stopPromise = core.stop().then(() => {
      stopped = true;
    });
    await sleep(30);
    expect(stopped).toBe(false);

    store.deferreds[0]!.resolve();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(store.saved.at(-1)).toEqual({
      "client-1": { agentSessionId: "agent-1" },
    });
  });

  it("waits for an in-flight /new handler during stop and cleans up its runtime and binding", async () => {
    const imAdapter = new KeepCallbackOnStopAdapter();
    const bindingStore = new FakeBindingStore();
    const createdAdapters: FakeAgentAdapter[] = [];
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let createEntered = false;

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        createEntered = true;
        await createGate;
        const agentAdapter = new FakeAgentAdapter("agent-new");
        createdAdapters.push(agentAdapter);
        return { agentSessionId: "agent-new", agentAdapter };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore,
    });
    running.push(core);
    await core.start();

    try {
      // The /new handler enters and blocks on the deferred create.
      const newEmit = imAdapter.emit({
        type: "command.session.new",
        clientSessionId: "client-1",
        workingDirectory: "/tmp/project-a",
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
      expect(bindingStore.saved.at(-1)).toEqual({
        "client-1": { agentSessionId: "agent-new", workingDirectory: "/tmp/project-a" },
      });
      expect(imAdapter.outputs.some((event) => event.text === "Started a new session.")).toBe(true);
      expect(createdAdapters).toHaveLength(1);
      expect(createdAdapters[0]!.inputs).toEqual([]);
    } finally {
      // Always release the gate so stop()/afterEach cleanup cannot hang.
      releaseCreate();
    }
  });

  it("stops the remaining runtimes and drains bindings when one runtime stop throws", async () => {
    const imAdapter = new FakeIMAdapter();
    const bindingStore = new FakeBindingStore();
    const adapters = [new FakeAgentAdapter("agent-1"), new FakeAgentAdapter("agent-2")];
    adapters[0]!.stopError = new Error("stop boom");
    let next = 0;

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentAdapter = adapters[next]!;
        next += 1;
        return { agentSessionId: agentAdapter.agentSessionId, agentAdapter };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore,
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
    expect(bindingStore.saved.at(-1)).toEqual({
      "client-1": { agentSessionId: "agent-1" },
      "client-2": { agentSessionId: "agent-2" },
    });
  });

  it("cleans up a partially started resumed adapter and keeps the persisted binding", async () => {
    const imAdapter = new FakeIMAdapter();
    const bindingStore = new FakeBindingStore({
      "client-1": { agentSessionId: "agent-1", workingDirectory: "/tmp/project-a" },
    });
    const resumedAdapters: FakeAgentAdapter[] = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        return { agentSessionId: "agent-new", agentAdapter: new FakeAgentAdapter("agent-new") };
      },
      async resumeAgentSession({ agentSessionId }) {
        const agentAdapter = new FakeAgentAdapter(agentSessionId);
        agentAdapter.startError = new Error("resume start boom");
        resumedAdapters.push(agentAdapter);
        return agentAdapter;
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
      bindingStore,
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

    // The persisted binding is untouched: no save happened and the loaded
    // mapping is unchanged.
    expect(bindingStore.saved).toHaveLength(0);
    expect(bindingStore.initial).toEqual({
      "client-1": { agentSessionId: "agent-1", workingDirectory: "/tmp/project-a" },
    });

    // A later message retries the restore from the same binding.
    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "retry",
    });
    await waitFor(() => {
      expect(resumedAdapters).toHaveLength(2);
    });
    expect(bindingStore.saved).toHaveLength(0);
  });

  it("returns a message when compact is requested without an active agent session", async () => {
    const imAdapter = new FakeIMAdapter();

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        return {
          agentSessionId: "agent-1",
          agentAdapter: new FakeAgentAdapter("agent-1"),
        };
      },
    };

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

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentSessionId = `agent-${createdAdapters.length + 1}`;
        const agentAdapter = new FakeAgentAdapter(agentSessionId);
        createdAdapters.push(agentAdapter);
        return { agentSessionId, agentAdapter };
      },
    };

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

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        return {
          agentSessionId: "agent-1",
          agentAdapter: new FakeAgentAdapter("agent-1"),
        };
      },
    };

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

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentSessionId = `agent-${createdAdapters.length + 1}`;
        const agentAdapter = new FakeAgentAdapter(agentSessionId);
        agentAdapter.statusResult = {
          sessionId: agentSessionId,
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          thinkingLevel: "medium",
          context: {
            tokens: 60_000,
            contextWindow: 200_000,
            percent: 30,
          },
        };
        createdAdapters.push(agentAdapter);
        return { agentSessionId, agentAdapter };
      },
    };

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
          sessionId: "agent-1",
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

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        return {
          agentSessionId: "agent-1",
          agentAdapter: new FakeAgentAdapter("agent-1"),
        };
      },
    };

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

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentAdapter = new FakeAgentAdapter("agent-1");
        agentAdapter.statusError = new Error("RPC timeout");
        createdAdapters.push(agentAdapter);
        return { agentSessionId: "agent-1", agentAdapter };
      },
    };

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

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentAdapter = new FakeAgentAdapter("agent-1");
        agentAdapter.availableModels = [
          { provider: "anthropic", modelId: "claude-sonnet-4-5", isCurrent: true },
          { provider: "openai", modelId: "gpt-5", isCurrent: false },
        ];
        createdAdapters.push(agentAdapter);
        return { agentSessionId: "agent-1", agentAdapter };
      },
    };

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

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        return {
          agentSessionId: "agent-1",
          agentAdapter: new FakeAgentAdapter("agent-1"),
        };
      },
    };

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

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentAdapter = new FakeAgentAdapter("agent-1");
        agentAdapter.setModelResult = {
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
        };
        createdAdapters.push(agentAdapter);
        return { agentSessionId: "agent-1", agentAdapter };
      },
    };

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

  it("emits a busy error when trying to switch model during an active run", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentAdapter = new FakeAgentAdapter("agent-1");
        agentAdapter.busy = true;
        agentAdapter.setModelResult = {
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
        };
        createdAdapters.push(agentAdapter);
        return { agentSessionId: "agent-1", agentAdapter };
      },
    };

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
      expect(createdAdapters[0]?.setModelCalls).toEqual([]);
      expect(imAdapter.outputs.at(-1)).toEqual({
        type: "error",
        clientSessionId: "client-1",
        kind: "agent.model.busy",
      });
    });
  });

  it("emits an invalid-model error with detail when switching model fails validation", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentAdapter = new FakeAgentAdapter("agent-1");
        const error = new Error("Model not found: anthropic/unknown");
        Object.assign(error, { kind: "agent.model.invalid" });
        agentAdapter.setModelError = error;
        createdAdapters.push(agentAdapter);
        return { agentSessionId: "agent-1", agentAdapter };
      },
    };

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
      const agentModule: AgentModule<Record<string, never>> = {
        type: "fake",
        async createAgentSession() {
          const agentSessionId = `agent-${createdAdapters.length + 1}`;
          const agentAdapter = new FakeAgentAdapter(agentSessionId);
          createdAdapters.push(agentAdapter);
          return { agentSessionId, agentAdapter };
        },
      };

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
        agentSessionId: "agent-1",
        text: "Planning next step",
      });
      await createdAdapters[0]!.emit({
        type: "assistant.tool.running",
        agentSessionId: "agent-1",
        toolName: "read_file",
        text: undefined,
      });

      await waitFor(() => {
        expect(imAdapter.outputs.at(-1)).toEqual({
          type: "assistant.tool.running",
          clientSessionId: "client-1",
          agentSessionId: "agent-1",
          toolName: "read_file",
          text: undefined,
        });
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[core]"),
        "forwarding tool event from agent",
        {
          type: "assistant.tool.running",
          agentSessionId: "agent-1",
          clientSessionId: "client-1",
          toolName: "read_file",
          text: undefined,
        },
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});
