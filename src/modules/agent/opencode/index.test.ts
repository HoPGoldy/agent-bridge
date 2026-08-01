import { describe, expect, it, vi } from "vitest";
import type { Session } from "@opencode-ai/sdk/v2/types";
import type { ConfigCollectContext } from "../../../types";
import { createOpenCodeAgentModule } from "./index";
import type { OpenCodeApi } from "./adapter/opencode-api";

function createApi(overrides: Partial<OpenCodeApi> = {}): OpenCodeApi {
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
    subscribe: vi.fn(async () => undefined),
    ...overrides,
  };
}

function context(args: {
  values?: Record<string, string>;
  confirms?: boolean[];
  inputSpy?: ReturnType<typeof vi.fn>;
} = {}): ConfigCollectContext {
  const values = args.values ?? {};
  const input = args.inputSpy ?? vi.fn(async (label: string) => values[label] ?? "");
  const confirms = [...(args.confirms ?? [false])];
  return {
    input,
    select: vi.fn(),
    confirm: vi.fn(async () => confirms.shift() ?? false),
    close: vi.fn(),
  };
}

const common = { channelName: "test", language: "en-US" as const };

describe("OpenCode agent module", () => {
  it("collects and validates a reachable local server", async () => {
    const api = createApi();
    const module = createOpenCodeAgentModule({ apiFactory: () => api });
    const collector = module.createConfigCollector?.();
    const config = await collector?.collect(
      context({ values: { "OpenCode Server URL": "http://127.0.0.1:4096/" } }),
    );

    expect(config).toEqual({ baseUrl: "http://127.0.0.1:4096" });
    await collector?.validate(config!);
    expect(api.health).toHaveBeenCalledOnce();
    expect(collector?.summarize?.(config!)).toContain("auth=none");
  });

  it("uses secret input for Basic Auth and never includes the password in summaries", async () => {
    const api = createApi();
    const input = vi.fn(async (label: string) => {
      const values: Record<string, string> = {
        "OpenCode Server URL": "http://server.internal:4096",
        "OpenCode Server username": "opencode",
        "OpenCode Server password": "test-password-value",
      };
      return values[label] ?? "";
    });
    const module = createOpenCodeAgentModule({ apiFactory: () => api });
    const collector = module.createConfigCollector?.();
    const config = await collector?.collect(context({ inputSpy: input, confirms: [true, true] }));

    expect(input).toHaveBeenCalledWith("OpenCode Server password", { required: true, secret: true });
    const summary = collector?.summarize?.(config!);
    expect(summary).toContain("auth=basic");
    expect(summary).not.toContain("test-password-value");
  });

  it("prints a safe startup command and retries when the server is unavailable", async () => {
    const health = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({ healthy: true as const, version: "1.18.10" });
    const api = createApi({ health });
    const lines: string[] = [];
    const module = createOpenCodeAgentModule({ apiFactory: () => api, writeLine: (line) => lines.push(line) });
    const collector = module.createConfigCollector?.();

    await collector?.collect(
      context({
        values: { "OpenCode Server URL": "http://127.0.0.1:4096" },
        confirms: [false, true],
      }),
    );

    expect(health).toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).toContain("opencode serve --hostname 127.0.0.1 --port 4096");
    expect(lines.join("\n")).toContain('"question":"deny"');
  });

  it("creates and resumes exact OpenCode session IDs", async () => {
    const api = createApi({
      createSession: vi.fn(async () => ({ id: "session-1", model: { providerID: "anthropic", id: "sonnet" } }) as Session),
      getSession: vi.fn(async () => ({ id: "session-1" }) as Session),
    });
    const module = createOpenCodeAgentModule({ apiFactory: () => api });
    const config = { baseUrl: "http://127.0.0.1:4096", model: "anthropic/sonnet" };

    const created = await module.createAgentSession({ config, common });
    expect(created.agentSessionId).toBe("opencode:session-1");
    expect(api.createSession).toHaveBeenCalledWith({
      title: "agent-bridge:test",
      agent: undefined,
      model: { providerID: "anthropic", modelID: "sonnet" },
    });

    await module.resumeAgentSession?.({ config, common, agentSessionId: "opencode:session-1" });
    expect(api.getSession).toHaveBeenCalledWith("session-1");
    expect(api.getMessages).toHaveBeenCalledWith("session-1", 50);
  });

  it("rejects embedded URL credentials", async () => {
    const module = createOpenCodeAgentModule({ apiFactory: () => createApi() });
    const collector = module.createConfigCollector?.();
    await expect(
      collector?.validate({ baseUrl: "http://user:password@127.0.0.1:4096" }),
    ).rejects.toThrow("Do not include credentials");
  });
});
