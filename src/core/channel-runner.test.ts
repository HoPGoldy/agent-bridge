import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelConfig, ChannelCommonContext, ClientInputEvent, ClientOutputEvent } from "../types";
import type { SchedulerOptions } from "../modules/schedule/scheduler";

const createClientAdapter = vi.fn();
const imAdapterInput = vi.fn(async () => {});
const gatewayCoreStart = vi.fn(async () => {});
const gatewayCoreStop = vi.fn(async () => {});
const gatewayCoreInput = vi.fn(async () => {});
const gatewayCoreCtor = vi.fn().mockImplementation(() => ({
  start: gatewayCoreStart,
  stop: gatewayCoreStop,
  input: gatewayCoreInput,
}));

const clientModule = {
  type: "fake-client",
  sessionStateCodec: {
    currentVersion: 1,
    decode: (raw: unknown) => raw as object,
    encode: (state: object) => state,
  },
  validateSessionId: vi.fn((clientSessionId: string) => clientSessionId.startsWith("fake:")),
  createClientAdapter,
};

const schedulerStart = vi.fn(async () => {});
const schedulerStop = vi.fn(async () => {});
const schedulerRunNow = vi.fn(async () => ({ ok: true as const }));
const schedulerClaimTarget = vi.fn(async () => ({ ok: true as const }));
const schedulerHandleOutput = vi.fn();
/** Options captured from the runner's `new Scheduler(...)` call, per test. */
let schedulerOptions: SchedulerOptions | undefined;
const schedulerCtor = vi.fn().mockImplementation((options: SchedulerOptions) => {
  schedulerOptions = options;
  return {
    start: schedulerStart,
    stop: schedulerStop,
    runNow: schedulerRunNow,
    claimTarget: schedulerClaimTarget,
    handleOutput: schedulerHandleOutput,
  };
});

const agentModule = {
  type: "fake-agent",
  async createAgentSession() {
    throw new Error("not used in channel-runner unit test");
  },
};

const fakeChannelStateStore = {
  load: vi.fn(async () => ({ version: 3, bindings: {}, agentSessions: {}, clientSessions: {} })),
  save: vi.fn(async () => {}),
  transaction: vi.fn(
    async (
      updater: (draft: {
        version: 3;
        bindings: object;
        agentSessions: object;
        clientSessions: Record<string, unknown>;
      }) => unknown,
    ) => {
      return updater({ version: 3, bindings: {}, agentSessions: {}, clientSessions: {} });
    },
  ),
  flush: vi.fn(async () => {}),
};

const createAgentSessionStateRegistry = vi.fn(() => ({
  reserve: vi.fn(),
  open: vi.fn(),
  revoke: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("./gateway-core", () => ({
  GatewayCore: gatewayCoreCtor,
}));

vi.mock("../modules/schedule/scheduler", () => ({
  Scheduler: schedulerCtor,
}));

vi.mock("../modules/client", () => ({
  getTypedClientModule: () => clientModule,
}));

vi.mock("../modules/agent", () => ({
  getTypedAgentModule: () => agentModule,
}));

vi.mock("../config/channel-state", () => ({
  createFileChannelStateStore: () => fakeChannelStateStore,
  getChannelStateStorePath: () => "/tmp/channel-state.json",
}));

vi.mock("../config/agent-session-state", () => ({
  createAgentSessionStateRegistry,
}));

describe("runChannel", () => {
  beforeEach(() => {
    vi.resetModules();
    createClientAdapter.mockReset();
    createClientAdapter.mockReturnValue({
      start: async () => {},
      stop: async () => {},
      input: imAdapterInput,
      isBusy: async () => false,
    });
    imAdapterInput.mockClear();
    gatewayCoreCtor.mockClear();
    gatewayCoreStart.mockClear();
    gatewayCoreStop.mockClear();
    gatewayCoreInput.mockClear();
    createAgentSessionStateRegistry.mockClear();
    schedulerCtor.mockClear();
    schedulerStart.mockClear();
    schedulerStop.mockClear();
    schedulerRunNow.mockClear();
    schedulerClaimTarget.mockClear();
    schedulerHandleOutput.mockClear();
    schedulerOptions = undefined;
    clientModule.validateSessionId.mockClear();
  });

  it("builds a common context from the channel name and passes it to the client adapter and core", async () => {
    const { runChannel } = await import("./channel-runner");
    const channelConfig: ChannelConfig = {
      common: { language: "zh-CN" },
      client: {
        type: "wecom",
        config: { botId: "bot-id", secret: "secret" },
      },
      agent: {
        type: "pi-coding-agent",
        config: {},
      },
    };

    await runChannel({
      channelName: "demo-channel",
      channelConfig,
      defaults: { agentIdleTimeoutMs: 60_000 },
    });

    const common: ChannelCommonContext = {
      channelName: "demo-channel",
      language: "zh-CN",
    };

    expect(createClientAdapter).toHaveBeenCalledWith({
      config: channelConfig.client.config,
      common,
      sessionState: expect.any(Object),
      onScheduleRun: expect.any(Function),
      onScheduleHere: expect.any(Function),
    });
    expect(gatewayCoreCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        common,
      }),
    );
    expect(gatewayCoreStart).toHaveBeenCalledTimes(1);
  });

  it("injects the per-channel state store and a registry built on it into the gateway core", async () => {
    const { runChannel } = await import("./channel-runner");
    const channelConfig: ChannelConfig = {
      common: { language: "en-US" },
      client: {
        type: "wecom",
        config: { botId: "bot-id", secret: "secret" },
      },
      agent: {
        type: "pi-coding-agent",
        config: {},
      },
    };

    await runChannel({
      channelName: "demo-channel",
      channelConfig,
      defaults: { agentIdleTimeoutMs: 60_000 },
    });

    expect(gatewayCoreCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        channelStateStore: fakeChannelStateStore,
        agentSessionStateRegistry: expect.any(Object),
      }),
    );
    expect(createAgentSessionStateRegistry).toHaveBeenCalledWith(fakeChannelStateStore);
  });

  it("builds the client session state store on the same per-channel state store", async () => {
    const { runChannel } = await import("./channel-runner");
    const channelConfig: ChannelConfig = {
      common: { language: "en-US" },
      client: {
        type: "wecom",
        config: { botId: "bot-id", secret: "secret" },
      },
      agent: {
        type: "pi-coding-agent",
        config: {},
      },
    };

    await runChannel({
      channelName: "demo-channel",
      channelConfig,
      defaults: { agentIdleTimeoutMs: 60_000 },
    });

    const sessionState = createClientAdapter.mock.calls[0]![0].sessionState;
    await sessionState.session("client-1").update(() => ({ version: 1 }));
    expect(fakeChannelStateStore.transaction).toHaveBeenCalled();
  });

  it("passes defaults.allowedWorkingDirectoryRoots into the gateway core", async () => {
    const { runChannel } = await import("./channel-runner");
    const channelConfig: ChannelConfig = {
      common: { language: "en-US" },
      client: {
        type: "wecom",
        config: { botId: "bot-id", secret: "secret" },
      },
      agent: {
        type: "pi-coding-agent",
        config: {},
      },
    };

    await runChannel({
      channelName: "demo-channel",
      channelConfig,
      defaults: {
        agentIdleTimeoutMs: 60_000,
        allowedWorkingDirectoryRoots: ["/srv/projects", "/home/me/work"],
      },
    });

    expect(gatewayCoreCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedWorkingDirectoryRoots: ["/srv/projects", "/home/me/work"],
      }),
    );
  });

  it("omits allowedWorkingDirectoryRoots when the defaults do not configure it", async () => {
    const { runChannel } = await import("./channel-runner");
    const channelConfig: ChannelConfig = {
      common: { language: "en-US" },
      client: {
        type: "wecom",
        config: { botId: "bot-id", secret: "secret" },
      },
      agent: {
        type: "pi-coding-agent",
        config: {},
      },
    };

    await runChannel({
      channelName: "demo-channel",
      channelConfig,
      defaults: { agentIdleTimeoutMs: 60_000 },
    });

    expect(gatewayCoreCtor).toHaveBeenCalledWith(
      expect.not.objectContaining({ allowedWorkingDirectoryRoots: expect.anything() }),
    );
  });

  it("starts the scheduler after the core and stops it before the core", async () => {
    const { runChannel } = await import("./channel-runner");
    const channelConfig: ChannelConfig = {
      common: { language: "en-US" },
      client: {
        type: "wecom",
        config: { botId: "bot-id", secret: "secret" },
      },
      agent: {
        type: "pi-coding-agent",
        config: {},
      },
    };

    const runner = await runChannel({
      channelName: "demo-channel",
      channelConfig,
      defaults: { agentIdleTimeoutMs: 60_000 },
    });

    expect(gatewayCoreStart).toHaveBeenCalledTimes(1);
    expect(schedulerStart).toHaveBeenCalledTimes(1);
    // core.start() resolves before scheduler.start() is invoked.
    expect(schedulerStart.mock.invocationCallOrder[0]).toBeGreaterThan(
      gatewayCoreStart.mock.invocationCallOrder[0]!,
    );

    await runner.stop();
    expect(schedulerStop).toHaveBeenCalledTimes(1);
    expect(gatewayCoreStop).toHaveBeenCalledTimes(1);
    // runner.stop() shuts the scheduler down before the core (spec D9).
    expect(gatewayCoreStop.mock.invocationCallOrder[0]).toBeGreaterThan(
      schedulerStop.mock.invocationCallOrder[0]!,
    );
  });

  it("wires the scheduler callbacks to the core input, adapter input and client module validator", async () => {
    const { runChannel } = await import("./channel-runner");
    const channelConfig: ChannelConfig = {
      common: { language: "en-US" },
      client: {
        type: "wecom",
        config: { botId: "bot-id", secret: "secret" },
      },
      agent: {
        type: "pi-coding-agent",
        config: {},
      },
    };

    await runChannel({
      channelName: "demo-channel",
      channelConfig,
      defaults: { agentIdleTimeoutMs: 60_000 },
    });

    expect(schedulerOptions).toBeDefined();
    expect(schedulerOptions!.channelName).toBe("demo-channel");

    // dispatchClientEvent → core.input: synthetic fires enter the core's public ingress.
    const synthetic: ClientOutputEvent = {
      type: "user.message",
      clientSessionId: "schedule:report:1",
      text: "summarize",
    };
    await schedulerOptions!.dispatchClientEvent({
      type: "command.session.new",
      clientSessionId: synthetic.clientSessionId,
      workingDirectory: "/tmp",
      workingDirectorySource: "default",
    });
    await schedulerOptions!.dispatchClientEvent(synthetic);
    expect(gatewayCoreInput).toHaveBeenCalledTimes(2);
    expect(gatewayCoreInput).toHaveBeenNthCalledWith(1, {
      type: "command.session.new",
      clientSessionId: "schedule:report:1",
      workingDirectory: "/tmp",
      workingDirectorySource: "default",
    });
    expect(gatewayCoreInput).toHaveBeenNthCalledWith(2, synthetic);

    // deliver → imAdapter.input: egress to a task's target chat.
    const egress: ClientInputEvent = {
      type: "assistant.message",
      clientSessionId: "wecom:dm:oc_abc",
      text: "done",
    };
    await schedulerOptions!.deliver(egress);
    expect(imAdapterInput).toHaveBeenCalledWith(egress);

    // validateTarget → clientModule.validateSessionId.
    expect(schedulerOptions!.validateTarget).toBe(clientModule.validateSessionId);
    expect(clientModule.validateSessionId("fake:dm:ok")).toBe(true);
    expect(clientModule.validateSessionId("wecom:dm:no")).toBe(false);

    // t is the per-channel translator.
    expect(typeof schedulerOptions!.t).toBe("function");
  });

  it("diverts schedule output from the core to the scheduler", async () => {
    const { runChannel } = await import("./channel-runner");
    const channelConfig: ChannelConfig = {
      common: { language: "en-US" },
      client: {
        type: "wecom",
        config: { botId: "bot-id", secret: "secret" },
      },
      agent: {
        type: "pi-coding-agent",
        config: {},
      },
    };

    await runChannel({
      channelName: "demo-channel",
      channelConfig,
      defaults: { agentIdleTimeoutMs: 60_000 },
    });

    const coreOptions = gatewayCoreCtor.mock.calls[0]![0] as {
      onScheduleOutput: (event: ClientInputEvent) => void;
    };
    expect(typeof coreOptions.onScheduleOutput).toBe("function");

    const result: ClientInputEvent = {
      type: "assistant.message",
      clientSessionId: "schedule:report:1",
      text: "the result",
    };
    coreOptions.onScheduleOutput(result);
    expect(schedulerHandleOutput).toHaveBeenCalledWith(result);
  });

  it("exposes scheduler.runNow to the client adapter via onScheduleRun", async () => {
    const { runChannel } = await import("./channel-runner");
    const channelConfig: ChannelConfig = {
      common: { language: "en-US" },
      client: {
        type: "wecom",
        config: { botId: "bot-id", secret: "secret" },
      },
      agent: {
        type: "pi-coding-agent",
        config: {},
      },
    };

    await runChannel({
      channelName: "demo-channel",
      channelConfig,
      defaults: { agentIdleTimeoutMs: 60_000 },
    });

    const adapterOptions = createClientAdapter.mock.calls[0]![0] as {
      onScheduleRun: (taskName: string, clientSessionId: string) => Promise<unknown>;
    };
    expect(typeof adapterOptions.onScheduleRun).toBe("function");

    schedulerRunNow.mockResolvedValue({ ok: false, reason: "task not found" });
    const result = await adapterOptions.onScheduleRun("report", "wecom:dm:oc_abc");
    expect(schedulerRunNow).toHaveBeenCalledWith("report");
    expect(result).toEqual({ ok: false, reason: "task not found" });
  });

  it("exposes scheduler.claimTarget to the client adapter via onScheduleHere", async () => {
    const { runChannel } = await import("./channel-runner");
    const channelConfig: ChannelConfig = {
      common: { language: "en-US" },
      client: {
        type: "wecom",
        config: { botId: "bot-id", secret: "secret" },
      },
      agent: {
        type: "pi-coding-agent",
        config: {},
      },
    };

    await runChannel({
      channelName: "demo-channel",
      channelConfig,
      defaults: { agentIdleTimeoutMs: 60_000 },
    });

    const adapterOptions = createClientAdapter.mock.calls[0]![0] as {
      onScheduleHere: (taskName: string, clientSessionId: string) => Promise<unknown>;
    };
    expect(typeof adapterOptions.onScheduleHere).toBe("function");

    schedulerClaimTarget.mockResolvedValue({ ok: false, reason: "task not found" });
    const result = await adapterOptions.onScheduleHere("report", "wecom:dm:oc_abc");
    expect(schedulerClaimTarget).toHaveBeenCalledWith("report", "wecom:dm:oc_abc");
    expect(result).toEqual({ ok: false, reason: "task not found" });
  });
});
