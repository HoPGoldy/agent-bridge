import { describe, expect, it, vi } from "vitest";
import type { Session } from "@opencode-ai/sdk/v2/types";
import type { AgentSessionRecord, ConfigCollectContext, OpenCodeAgentConfig } from "../../../types";
import { createAgentSessionStateRegistry } from "../../../config/agent-session-state";
import { createInMemoryChannelStateStore } from "../../../config/channel-state";
import { createOpenCodeAgentModule, openCodeAgentSessionStateCodec } from "./index";
import type { OpenCodeApi } from "./adapter/opencode-api";

type OpenCodeModule = ReturnType<typeof createOpenCodeAgentModule>;

function createApi(overrides: Partial<OpenCodeApi> = {}): OpenCodeApi {
  // Each fake api hands out distinct provider session ids, mirroring the real
  // server, so sessions sharing one runtime never collide in the registry.
  let sessionCounter = 0;
  return {
    health: vi.fn(async () => ({ healthy: true as const, version: "1.18.10" })),
    createSession: vi.fn(async () => {
      sessionCounter += 1;
      return { id: `session-${sessionCounter}` } as Session;
    }),
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
    subscribe: vi.fn(async ({ signal, onConnected }) => {
      await onConnected();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }),
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

async function reserveHandle(module: OpenCodeModule, id: string) {
  const store = createInMemoryChannelStateStore();
  const registry = createAgentSessionStateRegistry(store);
  const handle = await registry.reserve({
    agentSessionId: id,
    agentType: "opencode",
    codec: module.sessionStateCodec,
  });
  return { store, registry, handle };
}

async function openHandle(module: OpenCodeModule, id: string, initialState: unknown) {
  const store = createInMemoryChannelStateStore();
  const registry = createAgentSessionStateRegistry(store);
  const record: AgentSessionRecord = {
    recordVersion: 1,
    agentType: "opencode",
    stateVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: initialState,
  };
  await store.transaction((draft) => {
    draft.agentSessions[id] = record;
  });
  const handle = await registry.open({
    agentSessionId: id,
    agentType: "opencode",
    codec: module.sessionStateCodec,
  });
  return { store, handle };
}

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

  it("creates and resumes OpenCode sessions with core-owned ids and provider ids in state", async () => {
    const api = createApi({
      createSession: vi.fn(async () => ({ id: "session-1", model: { providerID: "anthropic", id: "sonnet" } }) as Session),
      getSession: vi.fn(async () => ({ id: "session-1" }) as Session),
    });
    const module = createOpenCodeAgentModule({ apiFactory: () => api });
    const config = { baseUrl: "http://127.0.0.1:4096", model: "anthropic/sonnet" };
    const bridgeId = "opencode:core-generated-id";

    const { handle } = await reserveHandle(module, bridgeId);
    const created = await module.createAgentSession({
      config,
      common,
      agentSessionId: bridgeId,
      sessionState: handle,
    });
    // The module must not create the provider session or touch state: both
    // happen inside the adapter's start().
    expect(api.createSession).not.toHaveBeenCalled();
    await created.start(vi.fn());
    expect(api.createSession).toHaveBeenCalledWith({
      title: "agent-bridge:test",
      agent: undefined,
      model: { providerID: "anthropic", modelID: "sonnet" },
    });

    // The provider session id lives in the state, never in the bridge id.
    await expect(handle.read()).resolves.toEqual({
      version: 1,
      openCodeSessionId: "session-1",
      workingDirectory: process.cwd(),
      workingDirectorySource: "bridge-default",
    });
    await created.stop();

    const { handle: resumeHandle } = await openHandle(module, bridgeId, {
      version: 1,
      openCodeSessionId: "session-1",
      workingDirectory: process.cwd(),
      workingDirectorySource: "bridge-default",
    });
    const resumed = await module.resumeAgentSession?.({
      config,
      common,
      agentSessionId: bridgeId,
      sessionState: resumeHandle,
    });
    expect(api.getSession).not.toHaveBeenCalled();
    await resumed!.start(vi.fn());
    expect(api.getSession).toHaveBeenCalledWith("session-1");
    expect(api.getMessages).toHaveBeenCalledWith("session-1", 50);
    await resumed!.stop();
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
      module: OpenCodeModule;
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

    it("persists the override as a user-sourced directory and passes it to the api factory without mutating the shared config", async () => {
      const { module, apiConfigs, apis } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096", model: "anthropic/sonnet" };

      const { handle } = await reserveHandle(module, "opencode:override-1");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:override-1",
        sessionState: handle,
        workingDirectory: "/srv/project-a",
      });
      await adapter.start(vi.fn());
      await adapter.stop();

      expect(apiConfigs).toHaveLength(1);
      expect(apiConfigs[0]?.directory).toBe("/srv/project-a");
      expect(apis[0]?.createSession).toHaveBeenCalledWith({
        title: "agent-bridge:test",
        agent: undefined,
        model: { providerID: "anthropic", modelID: "sonnet" },
      });
      expect(config.directory).toBeUndefined();
      await expect(handle.read()).resolves.toEqual({
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: "/srv/project-a",
        workingDirectorySource: "user",
      });
    });

    it("persists the trimmed channel directory as a configured source when no override is given", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096", directory: "/srv/default" };

      const { handle } = await reserveHandle(module, "opencode:default-1");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:default-1",
        sessionState: handle,
      });
      await adapter.start(vi.fn());
      await adapter.stop();

      expect(apiConfigs).toHaveLength(1);
      expect(apiConfigs[0]?.directory).toBe("/srv/default");
      // The shared config is never mutated; the effective config is a copy.
      expect(config.directory).toBe("/srv/default");
      expect(apiConfigs[0]).not.toBe(config);
      // The channel-configured directory is trusted, so the user allowlist
      // never applies to it, and it is persisted for a stable resume.
      await expect(handle.read()).resolves.toEqual({
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: "/srv/default",
        workingDirectorySource: "configured",
      });
    });

    it("treats a whitespace-only override as a bare /new (bridge-default cwd)", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const { handle } = await reserveHandle(module, "opencode:blank-1");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:blank-1",
        sessionState: handle,
        workingDirectory: "   ",
      });
      await adapter.start(vi.fn());
      await adapter.stop();

      expect(apiConfigs).toHaveLength(1);
      expect(apiConfigs[0]?.directory).toBe(process.cwd());
      await expect(handle.read()).resolves.toEqual({
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: process.cwd(),
        workingDirectorySource: "bridge-default",
      });
    });

    it("passes a relative override through to the server when no allowlist is configured", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const { handle } = await reserveHandle(module, "opencode:relative-1");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:relative-1",
        sessionState: handle,
        workingDirectory: "./project-a",
      });
      await adapter.start(vi.fn());
      await adapter.stop();

      expect(apiConfigs).toHaveLength(1);
      expect(apiConfigs[0]?.directory).toBe("./project-a");
      await expect(handle.read()).resolves.toEqual({
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: "./project-a",
        workingDirectorySource: "user",
      });
    });

    it("creates independent runtimes and APIs for different directories", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const first = await reserveHandle(module, "opencode:dir-a");
      const firstAdapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:dir-a",
        sessionState: first.handle,
        workingDirectory: "/srv/a",
      });
      await firstAdapter.start(vi.fn());
      const second = await reserveHandle(module, "opencode:dir-b");
      const secondAdapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:dir-b",
        sessionState: second.handle,
        workingDirectory: "/srv/b",
      });
      await secondAdapter.start(vi.fn());
      await firstAdapter.stop();
      await secondAdapter.stop();

      expect(apiConfigs.map((c) => c.directory)).toEqual(["/srv/a", "/srv/b"]);
      await expect(first.handle.read()).resolves.toEqual({
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: "/srv/a",
        workingDirectorySource: "user",
      });
      await expect(second.handle.read()).resolves.toEqual({
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: "/srv/b",
        workingDirectorySource: "user",
      });
    });

    it("reuses the runtime and API for the same directory", async () => {
      const { module, apiConfigs, apis } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const first = await reserveHandle(module, "opencode:same-a");
      const firstAdapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:same-a",
        sessionState: first.handle,
        workingDirectory: "/srv/a",
      });
      await firstAdapter.start(vi.fn());
      const second = await reserveHandle(module, "opencode:same-b");
      const secondAdapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:same-b",
        sessionState: second.handle,
        workingDirectory: "/srv/a",
      });
      await secondAdapter.start(vi.fn());
      await firstAdapter.stop();
      await secondAdapter.stop();

      expect(apiConfigs).toHaveLength(1);
      expect(apis).toHaveLength(1);
    });

    it("resumes through a runtime bound to the persisted override directory", async () => {
      const { module, apiConfigs, apis } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const { handle } = await reserveHandle(module, "opencode:resume-1");
      const created = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:resume-1",
        sessionState: handle,
        workingDirectory: "/srv/project-a",
      });
      await created.start(vi.fn());
      await created.stop();

      const { handle: resumeHandle } = await openHandle(module, "opencode:resume-1", {
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: "/srv/project-a",
        workingDirectorySource: "user",
      });
      const resumed = await module.resumeAgentSession?.({
        config,
        common,
        agentSessionId: "opencode:resume-1",
        sessionState: resumeHandle,
      });
      await resumed!.start(vi.fn());
      await resumed!.stop();

      expect(resumed).toBeDefined();
      // Stopping the created adapter evicted its directory-scoped runtime, so
      // the resume builds a fresh runtime — still bound to the persisted
      // directory, never to the channel config or the current cwd.
      expect(apiConfigs.map((c) => c.directory)).toEqual(["/srv/project-a", "/srv/project-a"]);
      expect(apis[1]?.getSession).toHaveBeenCalledWith("session-1");
      expect(apis[1]?.getMessages).toHaveBeenCalledWith("session-1", 50);
      expect(config.directory).toBeUndefined();
    });
  });

  describe("working directory allowlist", () => {
    function recordingModule(): {
      module: OpenCodeModule;
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

      const { handle } = await reserveHandle(module, "opencode:root-eq");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-eq",
        sessionState: handle,
        workingDirectory: "/srv/projects",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await adapter.start(vi.fn());
      await adapter.stop();

      expect(apiConfigs[0]?.directory).toBe("/srv/projects");
    });

    it("allows a strict descendant of an allowed root", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const { handle } = await reserveHandle(module, "opencode:root-desc");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-desc",
        sessionState: handle,
        workingDirectory: "/srv/projects/project-a/sub",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await adapter.start(vi.fn());
      await adapter.stop();

      expect(apiConfigs[0]?.directory).toBe("/srv/projects/project-a/sub");
    });

    it("rejects an override outside the allowed roots", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const { handle } = await reserveHandle(module, "opencode:root-outside");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-outside",
        sessionState: handle,
        workingDirectory: "/etc",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await expect(adapter.start(vi.fn())).rejects.toThrow(/not inside an allowed root/);
      expect(apiConfigs).toHaveLength(0);
    });

    it("rejects a sibling-prefix root bypass (root /srv/work vs target /srv/work2)", async () => {
      const { module } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const { handle } = await reserveHandle(module, "opencode:root-sibling");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-sibling",
        sessionState: handle,
        workingDirectory: "/srv/work2/project",
        allowedWorkingDirectoryRoots: ["/srv/work"],
      });
      await expect(adapter.start(vi.fn())).rejects.toThrow(/not inside an allowed root/);
    });

    it("rejects a .. escape that lexically leaves the root", async () => {
      const { module } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const { handle } = await reserveHandle(module, "opencode:root-dotdot");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-dotdot",
        sessionState: handle,
        workingDirectory: "/srv/projects/project-a/../../etc",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await expect(adapter.start(vi.fn())).rejects.toThrow(/not inside an allowed root/);
    });

    it("allows when any of multiple roots matches", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const { handle } = await reserveHandle(module, "opencode:root-multi");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-multi",
        sessionState: handle,
        workingDirectory: "/home/me/work/project",
        allowedWorkingDirectoryRoots: ["/srv/projects", "/home/me/work"],
      });
      await adapter.start(vi.fn());
      await adapter.stop();

      expect(apiConfigs[0]?.directory).toBe("/home/me/work/project");
    });

    it("is permissive with an empty allowlist", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const { handle } = await reserveHandle(module, "opencode:root-empty");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-empty",
        sessionState: handle,
        workingDirectory: "/anywhere",
        allowedWorkingDirectoryRoots: [],
      });
      await adapter.start(vi.fn());
      await adapter.stop();

      expect(apiConfigs[0]?.directory).toBe("/anywhere");
    });

    it("never checks a bare /new even when roots are configured", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096", directory: "/srv/configured" };

      const { handle } = await reserveHandle(module, "opencode:root-bare");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-bare",
        sessionState: handle,
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await adapter.start(vi.fn());
      await adapter.stop();

      expect(apiConfigs[0]?.directory).toBe("/srv/configured");
      await expect(handle.read()).resolves.toEqual({
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: "/srv/configured",
        workingDirectorySource: "configured",
      });
    });

    it("enforces consistently on create and resume", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const { handle } = await reserveHandle(module, "opencode:root-both");
      const created = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-both",
        sessionState: handle,
        workingDirectory: "/srv/projects/project-a",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await created.start(vi.fn());
      await created.stop();

      const { handle: resumeHandle } = await openHandle(module, "opencode:root-both", {
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: "/srv/projects/project-a",
        workingDirectorySource: "user",
      });
      const resumed = await module.resumeAgentSession?.({
        config,
        common,
        agentSessionId: "opencode:root-both",
        sessionState: resumeHandle,
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await resumed!.start(vi.fn());
      await resumed!.stop();

      // Create and resume both re-enforce the user allowlist against the same
      // directory; each lifecycle builds its own directory-scoped runtime.
      expect(apiConfigs.map((c) => c.directory)).toEqual(["/srv/projects/project-a", "/srv/projects/project-a"]);

      const outside = await reserveHandle(module, "opencode:root-outside-2");
      const outsideAdapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-outside-2",
        sessionState: outside.handle,
        workingDirectory: "/outside",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await expect(outsideAdapter.start(vi.fn())).rejects.toThrow(/not inside an allowed root/);

      const { handle: outsideResume } = await openHandle(module, "opencode:root-outside-2", {
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: "/outside",
        workingDirectorySource: "user",
      });
      const outsideResumed = await module.resumeAgentSession?.({
        config,
        common,
        agentSessionId: "opencode:root-outside-2",
        sessionState: outsideResume,
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await expect(outsideResumed!.start(vi.fn())).rejects.toThrow(/not inside an allowed root/);
    });

    it("rejects a relative override when an allowlist is configured (fail closed)", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const { handle } = await reserveHandle(module, "opencode:root-relative");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-relative",
        sessionState: handle,
        workingDirectory: "relative/project",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await expect(adapter.start(vi.fn())).rejects.toThrow(/must be an absolute path/);

      const { handle: relativeResume } = await openHandle(module, "opencode:root-relative", {
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: "relative/project",
        workingDirectorySource: "user",
      });
      const relativeResumed = await module.resumeAgentSession?.({
        config,
        common,
        agentSessionId: "opencode:root-relative",
        sessionState: relativeResume,
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await expect(relativeResumed!.start(vi.fn())).rejects.toThrow(/must be an absolute path/);

      expect(apiConfigs).toHaveLength(0);
    });

    it("allows child names that start with two dots (e.g. ..foo, ...) inside a root", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      const first = await reserveHandle(module, "opencode:root-dotfoo");
      const firstAdapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-dotfoo",
        sessionState: first.handle,
        workingDirectory: "/srv/projects/..foo",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await firstAdapter.start(vi.fn());
      await firstAdapter.stop();
      const second = await reserveHandle(module, "opencode:root-dotdot");
      const secondAdapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-dotdot",
        sessionState: second.handle,
        workingDirectory: "/srv/projects/...",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await secondAdapter.start(vi.fn());
      await secondAdapter.stop();

      expect(apiConfigs.map((c) => c.directory)).toEqual(["/srv/projects/..foo", "/srv/projects/..."]);
    });

    it("does not rewrite the directory sent to the server (lexical check only)", async () => {
      const { module, apiConfigs } = recordingModule();
      const config = { baseUrl: "http://127.0.0.1:4096" };

      // path.resolve collapses the segment to /srv/projects/project-a for the
      // boundary check, but the value forwarded to the server stays trimmed.
      const { handle } = await reserveHandle(module, "opencode:root-lexical");
      const adapter = await module.createAgentSession({
        config,
        common,
        agentSessionId: "opencode:root-lexical",
        sessionState: handle,
        workingDirectory: "/srv/projects/./project-a",
        allowedWorkingDirectoryRoots: ["/srv/projects"],
      });
      await adapter.start(vi.fn());
      await adapter.stop();

      expect(apiConfigs[0]?.directory).toBe("/srv/projects/./project-a");
    });
  });

  it("recovers a legacy migrated record by deriving the provider id from the old bridge id", async () => {
    const api = createApi();
    const module = createOpenCodeAgentModule({ apiFactory: () => api });
    const config = { baseUrl: "http://127.0.0.1:4096" };
    const oldBridgeId = "opencode:session-1";

    const { store, handle } = await openHandle(module, oldBridgeId, {
      migratedFromBinding: true,
      workingDirectory: "/srv/project-a",
    });

    const adapter = await module.resumeAgentSession?.({
      config,
      common,
      agentSessionId: oldBridgeId,
      sessionState: handle,
    });
    await adapter!.start(vi.fn());

    // The provider id is derived from the old bridge id, not stored yet.
    expect(api.getSession).toHaveBeenCalledWith("session-1");
    expect(api.getMessages).toHaveBeenCalledWith("session-1", 50);

    // The record is upgraded to the canonical versioned shape on resume.
    const document = await store.load();
    expect(document.agentSessions[oldBridgeId]!.state).toEqual({
      version: 1,
      openCodeSessionId: "session-1",
      workingDirectory: "/srv/project-a",
      workingDirectorySource: "user",
    });
    await adapter!.stop();
  });

  it("upgrades a legacy record without a working directory to the configured directory", async () => {
    const api = createApi();
    const module = createOpenCodeAgentModule({ apiFactory: () => api });
    const config = { baseUrl: "http://127.0.0.1:4096", directory: "/srv/configured" };
    const oldBridgeId = "opencode:session-2";

    const { store, handle } = await openHandle(module, oldBridgeId, { migratedFromBinding: true });

    const adapter = await module.resumeAgentSession?.({
      config,
      common,
      agentSessionId: oldBridgeId,
      sessionState: handle,
    });
    await adapter!.start(vi.fn());
    await adapter!.stop();

    const document = await store.load();
    expect(document.agentSessions[oldBridgeId]!.state).toEqual({
      version: 1,
      openCodeSessionId: "session-2",
      workingDirectory: "/srv/configured",
      workingDirectorySource: "configured",
    });
  });

  it("keeps the provisional process cwd when upgrading a legacy record without a working directory or configured directory", async () => {
    const api = createApi();
    const module = createOpenCodeAgentModule({ apiFactory: () => api });
    const config = { baseUrl: "http://127.0.0.1:4096" };
    const oldBridgeId = "opencode:session-3";

    const { store, handle } = await openHandle(module, oldBridgeId, { migratedFromBinding: true });

    const adapter = await module.resumeAgentSession?.({
      config,
      common,
      agentSessionId: oldBridgeId,
      sessionState: handle,
    });
    await adapter!.start(vi.fn());
    await adapter!.stop();

    const document = await store.load();
    expect(document.agentSessions[oldBridgeId]!.state).toEqual({
      version: 1,
      openCodeSessionId: "session-3",
      workingDirectory: process.cwd(),
      workingDirectorySource: "bridge-default",
    });
  });

  describe("state codec strictness", () => {
    const codec = openCodeAgentSessionStateCodec;

    it("rejects non-object state documents on decode", () => {
      expect(() => codec.decode("nope", 1, { agentSessionId: "opencode:x" })).toThrow(/expected a state document/);
      expect(() => codec.decode(null, 1, { agentSessionId: "opencode:x" })).toThrow(/expected a state document/);
      expect(() => codec.decode([], 1, { agentSessionId: "opencode:x" })).toThrow(/expected a state document/);
    });

    it("strictly validates stateVersion on decode", () => {
      const state = { version: 1, openCodeSessionId: "s", workingDirectory: "/w", workingDirectorySource: "user" };
      expect(() => codec.decode(state, 2, { agentSessionId: "opencode:x" })).toThrow(
        /unsupported OpenCode agent session state version 2/,
      );
      expect(() =>
        codec.decode({ migratedFromBinding: true }, 2, { agentSessionId: "opencode:old" }),
      ).toThrow(/unsupported OpenCode agent session state version 2/);
    });

    it("rejects missing or invalid fields on decode", () => {
      expect(() =>
        codec.decode({ version: 1, workingDirectory: "/w", workingDirectorySource: "user" }, 1, { agentSessionId: "opencode:x" }),
      ).toThrow(/openCodeSessionId/);
      expect(() =>
        codec.decode({ version: 1, openCodeSessionId: "s", workingDirectorySource: "user" }, 1, { agentSessionId: "opencode:x" }),
      ).toThrow(/workingDirectory/);
      expect(() =>
        codec.decode({ version: 1, openCodeSessionId: "s", workingDirectory: "/w", workingDirectorySource: "server" }, 1, {
          agentSessionId: "opencode:x",
        }),
      ).toThrow(/workingDirectorySource/);
      expect(() => codec.decode({ openCodeSessionId: "s" }, 1, { agentSessionId: "opencode:x" })).toThrow(
        /versioned state document/,
      );
    });

    it("rejects forged or invalid states on encode", () => {
      const valid = { version: 1, openCodeSessionId: "s", workingDirectory: "/w", workingDirectorySource: "user" };
      expect(() => codec.encode({ ...valid, version: 2 })).toThrow(/version must be 1/);
      expect(() => codec.encode({ ...valid, openCodeSessionId: "" })).toThrow(/openCodeSessionId/);
      expect(() => codec.encode({ ...valid, workingDirectory: "" })).toThrow(/workingDirectory/);
      expect(() =>
        codec.encode({
          ...valid,
          workingDirectorySource: "default",
        } as unknown as ReturnType<typeof codec.decode>),
      ).toThrow(/workingDirectorySource/);
    });

    it("strips the decode-only migration marker on encode", () => {
      expect(
        codec.encode({
          version: 1,
          openCodeSessionId: "s",
          workingDirectory: "/w",
          workingDirectorySource: "user",
          migratedFromBinding: true,
        }),
      ).toEqual({ version: 1, openCodeSessionId: "s", workingDirectory: "/w", workingDirectorySource: "user" });
    });

    it("never derives a provider id from a new-style bridge id", () => {
      // A versioned record for a new core-owned id decodes from the persisted
      // openCodeSessionId, never by slicing the bridge id.
      const decoded = codec.decode(
        { version: 1, openCodeSessionId: "real-session", workingDirectory: "/w", workingDirectorySource: "user" },
        1,
        { agentSessionId: "opencode:core-generated-uuid" },
      );
      expect(decoded.openCodeSessionId).toBe("real-session");
    });

    it("derives the provider id from the old bridge id only on the migrated path", () => {
      const decoded = codec.decode({ migratedFromBinding: true, workingDirectory: "/w" }, 1, {
        agentSessionId: "opencode:old-provider-session",
      });
      expect(decoded).toMatchObject({
        openCodeSessionId: "old-provider-session",
        workingDirectorySource: "user",
        migratedFromBinding: true,
      });
      // Migrated records without a usable old id are rejected.
      expect(() => codec.decode({ migratedFromBinding: true }, 1, { agentSessionId: "opencode:" })).toThrow(
        /cannot derive/,
      );
      expect(() => codec.decode({ migratedFromBinding: true }, 1, { agentSessionId: "pi-coding-agent:x" })).toThrow(
        /cannot derive/,
      );
    });
  });

  describe("failure rollback", () => {
    it("leaves no record behind when provider session creation fails", async () => {
      const api = createApi({
        createSession: vi.fn(async () => {
          throw new Error("server unreachable");
        }),
      });
      const module = createOpenCodeAgentModule({ apiFactory: () => api });

      const { store, handle } = await reserveHandle(module, "opencode:fail-create");
      const adapter = await module.createAgentSession({
        config: { baseUrl: "http://127.0.0.1:4096" },
        common,
        agentSessionId: "opencode:fail-create",
        sessionState: handle,
        workingDirectory: "/srv/a",
      });
      await expect(adapter.start(vi.fn())).rejects.toThrow("server unreachable");

      // No provider session write happened and no record was initialized: the
      // reserved record is absent from the store and the handle stays
      // uninitialized (the gateway deletes the reservation on failure).
      const document = await store.load();
      expect(document.agentSessions["opencode:fail-create"]).toBeUndefined();
      await expect(handle.read()).rejects.toThrow(/not been initialized/);
      await adapter.stop();
    });

    it("does not leak a stuck runtime after a failed create on the same directory", async () => {
      const api = createApi({
        createSession: vi.fn(async () => {
          throw new Error("server unreachable");
        }),
      });
      const module = createOpenCodeAgentModule({ apiFactory: () => api });

      const firstStore = createInMemoryChannelStateStore();
      const firstRegistry = createAgentSessionStateRegistry(firstStore);
      const firstHandle = await firstRegistry.reserve({
        agentSessionId: "opencode:fail-a",
        agentType: "opencode",
        codec: module.sessionStateCodec,
      });
      const first = await module.createAgentSession({
        config: { baseUrl: "http://127.0.0.1:4096" },
        common,
        agentSessionId: "opencode:fail-a",
        sessionState: firstHandle,
        workingDirectory: "/srv/a",
      });
      await expect(first.start(vi.fn())).rejects.toThrow("server unreachable");
      await first.stop();

      // A later create on the same directory must start cleanly: the cached
      // runtime is inert (never registered, never started) and reusable.
      api.createSession.mockResolvedValue({ id: "session-2" } as Session);
      const secondStore = createInMemoryChannelStateStore();
      const secondRegistry = createAgentSessionStateRegistry(secondStore);
      const secondHandle = await secondRegistry.reserve({
        agentSessionId: "opencode:fail-b",
        agentType: "opencode",
        codec: module.sessionStateCodec,
      });
      const second = await module.createAgentSession({
        config: { baseUrl: "http://127.0.0.1:4096" },
        common,
        agentSessionId: "opencode:fail-b",
        sessionState: secondHandle,
        workingDirectory: "/srv/a",
      });
      await second.start(vi.fn());
      expect(api.createSession).toHaveBeenCalledTimes(2);
      expect(api.subscribe).toHaveBeenCalledTimes(1);
      await second.stop();
    });

    it("cleans up after a runtime registration failure and allows a fresh start", async () => {
      const api = createApi({
        subscribe: vi.fn(async () => {
          throw new Error("sse refused");
        }),
      });
      const module = createOpenCodeAgentModule({ apiFactory: () => api });

      const firstStore = createInMemoryChannelStateStore();
      const firstRegistry = createAgentSessionStateRegistry(firstStore);
      const firstHandle = await firstRegistry.reserve({
        agentSessionId: "opencode:fail-register",
        agentType: "opencode",
        codec: module.sessionStateCodec,
      });
      const first = await module.createAgentSession({
        config: { baseUrl: "http://127.0.0.1:4096" },
        common,
        agentSessionId: "opencode:fail-register",
        sessionState: firstHandle,
        workingDirectory: "/srv/a",
      });
      await expect(first.start(vi.fn())).rejects.toThrow("sse refused");
      // stop() must be safe after a failed start; the runtime already removed
      // the adapter and shut its loop down.
      await first.stop();

      // The record was initialized before registration, so it exists; the
      // gateway deletes it on a failed start (registry.delete). Simulate the
      // core's cleanup to prove the record is gone afterwards.
      await firstRegistry.delete("opencode:fail-register");
      expect((await firstStore.load()).agentSessions["opencode:fail-register"]).toBeUndefined();

      // A later session on the same directory subscribes again on a fresh loop.
      api.subscribe.mockImplementation(async ({ signal, onConnected }) => {
        await onConnected();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      });
      const secondStore = createInMemoryChannelStateStore();
      const secondRegistry = createAgentSessionStateRegistry(secondStore);
      const secondHandle = await secondRegistry.reserve({
        agentSessionId: "opencode:fail-register-2",
        agentType: "opencode",
        codec: module.sessionStateCodec,
      });
      const second = await module.createAgentSession({
        config: { baseUrl: "http://127.0.0.1:4096" },
        common,
        agentSessionId: "opencode:fail-register-2",
        sessionState: secondHandle,
        workingDirectory: "/srv/a",
      });
      await second.start(vi.fn());
      expect(api.subscribe).toHaveBeenCalledTimes(2);
      await second.stop();
    });

    it("leaves the persisted record intact when resume fails to reach the server", async () => {
      const api = createApi({
        getSession: vi.fn(async () => {
          throw new Error("server gone");
        }),
      });
      const module = createOpenCodeAgentModule({ apiFactory: () => api });
      const state = {
        version: 1,
        openCodeSessionId: "session-1",
        workingDirectory: "/srv/project-a",
        workingDirectorySource: "user",
      };

      const { store, handle } = await openHandle(module, "opencode:resume-fail", state);
      const adapter = await module.resumeAgentSession?.({
        config: { baseUrl: "http://127.0.0.1:4096" },
        common,
        agentSessionId: "opencode:resume-fail",
        sessionState: handle,
      });
      await expect(adapter!.start(vi.fn())).rejects.toThrow("server gone");

      // Nothing was rewritten and no runtime was registered: the record is
      // byte-for-byte intact and a later resume can retry.
      const document = await store.load();
      expect(document.agentSessions["opencode:resume-fail"]!.state).toEqual(state);
      await adapter!.stop();
    });
  });

  it("rejects a state record whose agent type does not match the module", async () => {
    const module = createOpenCodeAgentModule({ apiFactory: () => createApi() });
    const store = createInMemoryChannelStateStore();
    const registry = createAgentSessionStateRegistry(store);
    const record: AgentSessionRecord = {
      recordVersion: 1,
      agentType: "pi-coding-agent",
      stateVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      state: { version: 1, openCodeSessionId: "session-1" },
    };
    await store.transaction((draft) => {
      draft.agentSessions["opencode:wrong-type"] = record;
    });

    await expect(
      registry.open({
        agentSessionId: "opencode:wrong-type",
        agentType: "opencode",
        codec: module.sessionStateCodec,
      }),
    ).rejects.toThrow(/agentType/);
  });
});
