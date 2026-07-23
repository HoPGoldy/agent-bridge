import { beforeEach, describe, expect, it, vi } from "vitest";

const readFile = vi.fn();
const writeFile = vi.fn();
const mkdir = vi.fn(async () => {});

vi.mock("node:fs/promises", () => ({
  readFile,
  writeFile,
  mkdir,
}));

vi.mock("node:os", () => ({
  default: {
    homedir: () => "/tmp/agent-bridge-home",
  },
}));

describe("config store", () => {
  beforeEach(() => {
    vi.resetModules();
    readFile.mockReset();
    writeFile.mockReset();
    mkdir.mockClear();
  });

  it("fills in en-US as the default channel language for legacy configs", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({
        channels: {
          legacy: {
            client: { type: "wecom", config: { botId: "bot", secret: "sec" } },
            agent: { type: "pi-coding-agent", config: {} },
          },
        },
      }),
    );

    const { loadConfig } = await import("./store");
    const config = await loadConfig();

    expect(config.channels.legacy?.common).toEqual({ language: "en-US" });
  });
});
