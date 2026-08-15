import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelConfig, ChannelCommonContext } from "../types";

const createClientAdapter = vi.fn();
const gatewayCoreStart = vi.fn(async () => {});
const gatewayCoreStop = vi.fn(async () => {});
const gatewayCoreCtor = vi.fn().mockImplementation(() => ({
  start: gatewayCoreStart,
  stop: gatewayCoreStop,
}));

const clientModule = {
  type: "fake-client",
  sessionStateCodec: {
    currentVersion: 1,
    decode: (raw: unknown) => raw as object,
    encode: (state: object) => state,
  },
  createClientAdapter,
};

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
      input: async () => {},
      isBusy: async () => false,
    });
    gatewayCoreCtor.mockClear();
    gatewayCoreStart.mockClear();
    gatewayCoreStop.mockClear();
    createAgentSessionStateRegistry.mockClear();
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
});
