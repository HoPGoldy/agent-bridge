import { beforeEach, describe, expect, it, vi } from "vitest";

const promptCalls: string[] = [];
const close = vi.fn();
const input = vi.fn(async (label: string) => {
  promptCalls.push(`input:${label}`);
  if (label === "Channel name") return "demo";
  throw new Error(`unexpected input prompt: ${label}`);
});
const select = vi.fn(async (label: string) => {
  promptCalls.push(`select:${label}`);
  if (label === "Channel language") return "zh-CN";
  if (label === "Select client module") return "fake-client";
  if (label === "Select agent module") return "fake-agent";
  throw new Error(`unexpected select prompt: ${label}`);
});
const confirm = vi.fn(async () => true);
const loadConfig = vi.fn(async () => ({ channels: {}, defaults: { agentIdleTimeoutMs: 60_000 } }));
const saveConfig = vi.fn(async () => {});

const fakeClientModule = {
  type: "fake-client",
  createConfigCollector: () => ({
    collect: async () => ({ token: "client-token" }),
    validate: async () => {},
    summarize: () => "type=fake-client",
  }),
  createClientAdapter: vi.fn(),
};

const fakeAgentModule = {
  type: "fake-agent",
  createConfigCollector: () => ({
    collect: async () => ({ model: "demo-model" }),
    validate: async () => {},
    summarize: () => "type=fake-agent",
  }),
  createAgentSession: vi.fn(),
};

vi.mock("./config/prompt", () => ({
  createPromptContext: () => ({ input, select, confirm, close }),
}));

vi.mock("./config/store", () => ({
  getConfigPath: () => "/tmp/agent-bridge-config.json",
  loadConfig,
  saveConfig,
}));

vi.mock("./modules/client", () => ({
  listClientModules: () => [fakeClientModule],
  getClientModule: (type: string) => (type === "fake-client" ? fakeClientModule : undefined),
}));

vi.mock("./modules/agent", () => ({
  listAgentModules: () => [fakeAgentModule],
  getAgentModule: (type: string) => (type === "fake-agent" ? fakeAgentModule : undefined),
}));

vi.mock("./core/channel-runner", () => ({
  runChannel: vi.fn(),
}));

vi.mock("./config/session-bindings", () => ({
  removeSessionBindingStore: vi.fn(async () => {}),
}));

describe("runCli add", () => {
  beforeEach(() => {
    vi.resetModules();
    promptCalls.length = 0;
    close.mockClear();
    input.mockClear();
    select.mockClear();
    confirm.mockClear();
    loadConfig.mockClear();
    saveConfig.mockClear();
  });

  it("prompts for channel language immediately after channel name and saves it under common config", async () => {
    const { runCli } = await import("./cli");

    await runCli(["node", "agent-bridge", "add"]);

    expect(promptCalls.slice(0, 2)).toEqual(["input:Channel name", "select:Channel language"]);
    expect(saveConfig).toHaveBeenCalledWith({
      channels: {
        demo: {
          common: {
            language: "zh-CN",
          },
          client: {
            type: "fake-client",
            config: { token: "client-token" },
          },
          agent: {
            type: "fake-agent",
            config: { model: "demo-model" },
          },
        },
      },
      defaults: {
        agentIdleTimeoutMs: 60_000,
      },
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
