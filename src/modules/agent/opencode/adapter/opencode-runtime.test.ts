import { describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2/types";
import type { OpenCodeApi } from "./opencode-api";
import { OpenCodeRuntime, type OpenCodeRuntimeAdapter } from "./opencode-runtime";

function createApi(): OpenCodeApi {
  return {
    health: vi.fn(),
    createSession: vi.fn(),
    getSession: vi.fn(),
    getSessionStatuses: vi.fn(async () => ({})),
    getMessages: vi.fn(),
    promptAsync: vi.fn(),
    abort: vi.fn(),
    summarize: vi.fn(),
    getProviders: vi.fn(),
    listPermissions: vi.fn(async () => []),
    replyPermission: vi.fn(),
    listQuestions: vi.fn(async () => []),
    rejectQuestion: vi.fn(),
    subscribe: vi.fn(),
  };
}

function adapter(sessionID: string): OpenCodeRuntimeAdapter {
  return {
    openCodeSessionId: sessionID,
    handleOpenCodeEvent: vi.fn(async () => undefined),
  };
}

describe("OpenCodeRuntime", () => {
  it("shares one SSE subscription and routes events by session ID", async () => {
    const api = createApi();
    let subscriptionArgs: Parameters<OpenCodeApi["subscribe"]>[0] | undefined;
    api.subscribe = vi.fn(async (args) => {
      subscriptionArgs = args;
      await args.onConnected();
      await new Promise<void>((resolve) => args.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const runtime = new OpenCodeRuntime({ api });
    const first = adapter("session-1");
    const second = adapter("session-2");

    await runtime.register(first);
    await runtime.register(second);
    await subscriptionArgs?.onEvent({
      id: "event-1",
      type: "session.idle",
      properties: { sessionID: "session-2" },
    } as Event);

    expect(api.subscribe).toHaveBeenCalledOnce();
    expect(first.handleOpenCodeEvent).not.toHaveBeenCalled();
    expect(second.handleOpenCodeEvent).toHaveBeenCalledOnce();

    await runtime.unregister(first);
    expect(subscriptionArgs?.signal.aborted).toBe(false);
    await runtime.unregister(second);
    expect(subscriptionArgs?.signal.aborted).toBe(true);
  });

  it("replays pending permission and question requests after connecting", async () => {
    const api = createApi();
    api.listPermissions = vi.fn(async () => [
      { id: "permission-1", sessionID: "session-1", permission: "bash", patterns: ["*"], metadata: {}, always: [] },
    ]);
    api.listQuestions = vi.fn(async () => [
      { id: "question-1", sessionID: "session-1", questions: [] },
    ]);
    api.subscribe = vi.fn(async (args) => {
      await args.onConnected();
      await new Promise<void>((resolve) => args.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const runtime = new OpenCodeRuntime({ api });
    const target = adapter("session-1");

    await runtime.register(target);

    await vi.waitFor(() => {
      expect(target.handleOpenCodeEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "permission.asked", properties: expect.objectContaining({ id: "permission-1" }) }),
      );
      expect(target.handleOpenCodeEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "question.asked", properties: expect.objectContaining({ id: "question-1" }) }),
      );
    });

    await runtime.unregister(target);
  });

  it("checks occupancy precisely by provider session id", async () => {
    const api = createApi();
    api.subscribe = vi.fn(async ({ signal, onConnected }) => {
      await onConnected();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const runtime = new OpenCodeRuntime({ api });
    const holder = adapter("session-1");

    // Empty registry: any target is available.
    expect(runtime.assertSessionAvailable("session-1")).toBeUndefined();

    await runtime.register(holder);
    // An unrelated live session never blocks another session id.
    expect(runtime.assertSessionAvailable("session-2")).toBeUndefined();
    expect(() => runtime.assertSessionAvailable("session-1")).toThrow(
      'provider session "session-1" is already adopted by live agent session (unknown)',
    );
    await expect(runtime.register(adapter("session-1"))).rejects.toThrow(
      'provider session "session-1" is already adopted by live agent session (unknown)',
    );

    // Released slots end the conflict.
    await runtime.unregister(holder);
    expect(runtime.assertSessionAvailable("session-1")).toBeUndefined();

    const named = adapter("session-9");
    named.agentSessionId = "opencode:live-holder";
    await runtime.register(named);
    expect(() => runtime.assertSessionAvailable("session-9")).toThrow(
      'provider session "session-9" is already adopted by live agent session opencode:live-holder',
    );

    await runtime.unregister(named);
  });
});
