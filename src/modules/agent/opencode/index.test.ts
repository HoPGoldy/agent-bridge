import { describe, expect, it, vi } from "vitest";
import type { Session } from "@opencode-ai/sdk/v2/types";
import type { ConfigCollectContext, OpenCodeAgentConfig } from "../../../types";
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

  describe("working directory override", () => {
    function recordingModule(): {
      module: ReturnType<typeof createOpenCodeAgentModule>;
      apiConfigs: OpenCodeAgentConfig[];
      apis: OpenCodeApi[];
    } {
      const apiConfigs: OpenCodeAgentConfig[] = [];
      const apis: OpenCodeApi[] = [];
      const module = createOpenCodeAgentModule({
        apiFactory: (config) => {
          apiConfigs.push(config);
          const api = createApi();
          apis.push(api);
          return api;
        },
      });
      return { module, apiConfigs, apis };
    }

    it("passes the override into the api factory and createSession without mutating the shared config", async () => {
      const { module, apiConfigs, apis } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096", model: "anthropic/sonnet" };

      const created = await module.createAgentSession({ config, common, workingDirectory: "/srv/project-a" });

      expect(created.agentSessionId).toBe("opencode:session-1");
      expect(apiConfigs).toHaveLength(1);
      expect(apiConfigs[0]?.directory).toBe("/srv/project-a");
      expect(apis[0]?.createSession).toHaveBeenCalledWith({
        title: "agent-bridge:test",
        agent: undefined,
        model: { providerID: "anthropic", modelID: "sonnet" },
      });
      expect(config.directory).toBeUndefined();
    });

    it("keeps the channel directory when no override is given", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096", directory: "/srv/default" };

      await module.createAgentSession({ config, common });

      expect(apiConfigs).toHaveLength(1);
      expect(apiConfigs[0]?.directory).toBe("/srv/default");
      // No override short-circuits without copying, so the shared config is
      // passed through untouched (and therefore cannot have been mutated).
      expect(apiConfigs[0]).toBe(config);
    });

    it("treats a whitespace-only override as no override", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      await module.createAgentSession({ config, common, workingDirectory: "   " });

      expect(apiConfigs).toHaveLength(1);
      expect(apiConfigs[0]?.directory).toBeUndefined();
    });

    it("passes a relative override through to the server when no allowlist is configured", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      await module.createAgentSession({ config, common, workingDirectory: "./project-a" });

      expect(apiConfigs).toHaveLength(1);
      expect(apiConfigs[0]?.directory).toBe("./project-a");
    });

    it("creates independent runtimes and APIs for different directories", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const first = await module.createAgentSession({ config, common, workingDirectory: "/srv/a" });
      const second = await module.createAgentSession({ config, common, workingDirectory: "/srv/b" });

      expect(first.agentSessionId).toBe("opencode:session-1");
      expect(second.agentSessionId).toBe("opencode:session-1");
      expect(apiConfigs.map((c) => c.directory)).toEqual(["/srv/a", "/srv/b"]);
    });

    it("reuses the runtime and API for the same directory", async () => {
      const { module, apiConfigs, apis } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      await module.createAgentSession({ config, common, workingDirectory: "/srv/a" });
      await module.createAgentSession({ config, common, workingDirectory: "/srv/a" });

      expect(apiConfigs).toHaveLength(1);
      expect(apis).toHaveLength(1);
    });

    it("resumes through the runtime bound to the persisted override directory", async () => {
      const { module, apiConfigs, apis } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const created = await module.createAgentSession({ config, common, workingDirectory: "/srv/project-a" });
      const resumed = await module.resumeAgentSession?.({
        config,
        common,
        agentSessionId: created.agentSessionId,
        workingDirectory: "/srv/project-a",
      });

      expect(resumed).toBeDefined();
      expect(apiConfigs).toHaveLength(1);
      expect(apiConfigs[0]?.directory).toBe("/srv/project-a");
      expect(apis[0]?.getSession).toHaveBeenCalledWith("session-1");
      expect(apis[0]?.getMessages).toHaveBeenCalledWith("session-1", 50);
      expect(config.directory).toBeUndefined();
    });
  });

  describe("working directory allowlist", () => {
    function recordingModule(): {
      module: ReturnType<typeof createOpenCodeAgentModule>;
      apiConfigs: OpenCodeAgentConfig[];
    } {
      const apiConfigs: OpenCodeAgentConfig[] = [];
      const module = createOpenCodeAgentModule({
        apiFactory: (config) => {
          apiConfigs.push(config);
          return createApi();
        },
      });
      return { module, apiConfigs };
    }

    it("allows an override equal to an allowed root", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      await module.createAgentSession({
        config,
        common,
        workingDirectory: "/srv/projects",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });

      expect(apiConfigs[0]?.directory).toBe("/srv/projects");
    });

    it("allows a strict descendant of an allowed root", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      await module.createAgentSession({
        config,
        common,
        workingDirectory: "/srv/projects/project-a/sub",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });

      expect(apiConfigs[0]?.directory).toBe("/srv/projects/project-a/sub");
    });

    it("rejects an override outside the allowed roots", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      await expect(
        module.createAgentSession({
          config,
          common,
          workingDirectory: "/etc",
          allowedWorkingDirectoryRoots: ["/srv/projects"],
        }),
      ).rejects.toThrow(/not inside an allowed root/);
      expect(apiConfigs).toHaveLength(0);
    });

    it("rejects a sibling-prefix root bypass (root /srv/work vs target /srv/work2)", async () => {
      const { module } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      await expect(
        module.createAgentSession({
          config,
          common,
          workingDirectory: "/srv/work2/project",
          allowedWorkingDirectoryRoots: ["/srv/work"],
        }),
      ).rejects.toThrow(/not inside an allowed root/);
    });

    it("rejects a .. escape that lexically leaves the root", async () => {
      const { module } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      await expect(
        module.createAgentSession({
          config,
          common,
          workingDirectory: "/srv/projects/project-a/../../etc",
          allowedWorkingDirectoryRoots: ["/srv/projects"],
        }),
      ).rejects.toThrow(/not inside an allowed root/);
    });

    it("allows when any of multiple roots matches", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      await module.createAgentSession({
        config,
        common,
        workingDirectory: "/home/me/work/project",
        allowedWorkingDirectoryRoots: ["/srv/projects", "/home/me/work"],
      });

      expect(apiConfigs[0]?.directory).toBe("/home/me/work/project");
    });

    it("is permissive with an empty allowlist", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      await module.createAgentSession({
        config,
        common,
        workingDirectory: "/anywhere",
        allowedWorkingDirectoryRoots: [],
      });

      expect(apiConfigs[0]?.directory).toBe("/anywhere");
    });

    it("never checks a bare /new even when roots are configured", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096", directory: "/srv/configured" };

      await module.createAgentSession({
        config,
        common,
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });

      expect(apiConfigs[0]?.directory).toBe("/srv/configured");
    });

    it("enforces consistently on create and resume", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const created = await module.createAgentSession({
        config,
        common,
        workingDirectory: "/srv/projects/project-a",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await module.resumeAgentSession?.({
        config,
        common,
        agentSessionId: created.agentSessionId,
        workingDirectory: "/srv/projects/project-a",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });

      expect(apiConfigs).toHaveLength(1);
      expect(apiConfigs[0]?.directory).toBe("/srv/projects/project-a");

      await expect(
        module.createAgentSession({
          config,
          common,
          workingDirectory: "/outside",
          allowedWorkingDirectoryRoots: ["/srv/projects"],
        }),
      ).rejects.toThrow(/not inside an allowed root/);
      await expect(
        module.resumeAgentSession?.({
          config,
          common,
          agentSessionId: "opencode:session-1",
          workingDirectory: "/outside",
          allowedWorkingDirectoryRoots: ["/srv/projects"],
        }),
      ).rejects.toThrow(/not inside an allowed root/);
    });

    it("rejects a relative override when an allowlist is configured (fail closed)", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      await expect(
        module.createAgentSession({
          config,
          common,
          workingDirectory: "relative/project",
          allowedWorkingDirectoryRoots: ["/srv/projects"],
        }),
      ).rejects.toThrow(/must be an absolute path/);

      await expect(
        module.resumeAgentSession?.({
          config,
          common,
          agentSessionId: "opencode:session-1",
          workingDirectory: "relative/project",
          allowedWorkingDirectoryRoots: ["/srv/projects"],
        }),
      ).rejects.toThrow(/must be an absolute path/);

      expect(apiConfigs).toHaveLength(0);
    });

    it("allows child names that start with two dots (e.g. ..foo, ...) inside a root", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      await module.createAgentSession({
        config,
        common,
        workingDirectory: "/srv/projects/..foo",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await module.createAgentSession({
        config,
        common,
        workingDirectory: "/srv/projects/...",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });

      expect(apiConfigs.map((c) => c.directory)).toEqual(["/srv/projects/..foo", "/srv/projects/..."]);
    });

    it("does not rewrite the directory sent to the server (lexical check only)", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      // path.resolve collapses the segment to /srv/projects/project-a for the
      // boundary check, but the value forwarded to the server stays trimmed.
      await module.createAgentSession({
        config,
        common,
        workingDirectory: "/srv/projects/./project-a",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });

      expect(apiConfigs[0]?.directory).toBe("/srv/projects/./project-a");
    });
  });
});
