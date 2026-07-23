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
  createClientAdapter,
};

const agentModule = {
  type: "fake-agent",
  async createAgentSession() {
    throw new Error("not used in channel-runner unit test");
  },
};

vi.mock("./gateway-core", () => ({
  GatewayCore: gatewayCoreCtor,
}));

vi.mock("../modules/client", () => ({
  getTypedClientModule: () => clientModule,
}));

vi.mock("../modules/agent", () => ({
  getTypedAgentModule: () => agentModule,
}));

vi.mock("../config/session-bindings", () => ({
  createFileSessionBindingStore: () => ({ load: async () => ({}), save: async () => {} }),
  getSessionBindingStorePath: () => "/tmp/session-bindings.json",
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
    });
    expect(gatewayCoreCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        common,
      }),
    );
    expect(gatewayCoreStart).toHaveBeenCalledTimes(1);
  });
});
