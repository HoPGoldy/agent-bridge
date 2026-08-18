import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientInputEvent, ClientOutputEvent, OutboundAttachment } from "../../types";
import { getTranslator } from "../../i18n";
import type { Logger } from "../../core/logger";
import { DEFAULT_TIMEOUT_MS, type LoadedTask, type ScheduleTask } from "./task-file";
import { Scheduler } from "./scheduler";

const TARGET = "feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 1500): Promise<void> {
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

class FakeClock {
  #ms: number;
  constructor(ms = 1_700_000_000_000) {
    this.#ms = ms;
  }
  now(): Date {
    return new Date(this.#ms);
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
}

function makeTask(overrides: Partial<ScheduleTask> & { name: string }): ScheduleTask {
  return {
    name: overrides.name,
    scheduleRaw: overrides.scheduleRaw ?? "every 30m",
    schedule: overrides.schedule ?? { type: "every", intervalMs: 30 * 60_000 },
    directory: overrides.directory,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    enabled: overrides.enabled ?? true,
    // T2: harness tasks belong to the scheduler's channel ("test") unless
    // the test overrides `channel` (a deliberate `undefined` means an unbound
    // / legacy task).
    channel: "channel" in overrides ? overrides.channel : "test",
    target: overrides.target,
    prompt: overrides.prompt ?? "do the thing",
    model: overrides.model,
  };
}

function makeLoaded(task: ScheduleTask, errors: string[] = [], warnings: string[] = []): LoadedTask {
  return { task, errors, warnings };
}

type MockLogger = { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

interface Harness {
  clock: FakeClock;
  dispatched: ClientOutputEvent[];
  delivered: ClientInputEvent[];
  dispatchClientEvent: ReturnType<typeof vi.fn>;
  deliver: ReturnType<typeof vi.fn>;
  loadTasks: ReturnType<typeof vi.fn>;
  logger: MockLogger;
  tasks: LoadedTask[];
  scheduler: Scheduler;
}

const schedulers: Scheduler[] = [];

function createHarness(options: { tasks?: LoadedTask[]; validateTarget?: (id: string) => boolean } = {}): Harness {
  const clock = new FakeClock();
  const dispatched: ClientOutputEvent[] = [];
  const delivered: ClientInputEvent[] = [];
  // The real runner wires dispatchClientEvent to core.input, which never
  // rejects; the fake mirrors that contract and succeeds by default, so a
  // fire only proceeds past session.new when the dispatch actually succeeded.
  const dispatchClientEvent = vi.fn(async (event: ClientOutputEvent) => {
    dispatched.push(event);
    return { ok: true } as const;
  });
  const deliver = vi.fn(async (event: ClientInputEvent) => {
    delivered.push(event);
  });
  const tasks = options.tasks ?? [];
  const loadTasks = vi.fn(async () => [...tasks]);
  const logger: MockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const scheduler = new Scheduler({
    channelName: "test",
    tickMs: 20,
    now: () => clock.now(),
    dispatchClientEvent,
    deliver,
    t: getTranslator("en-US"),
    loadTasks,
    logger,
    ...(options.validateTarget !== undefined ? { validateTarget: options.validateTarget } : {}),
  });
  schedulers.push(scheduler);
  return { clock, dispatched, delivered, dispatchClientEvent, deliver, loadTasks, logger, tasks, scheduler };
}

afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) {
    await scheduler.stop();
  }
});

describe("tick loop and hot reload (D8)", () => {
  it("loads tasks on start and fires a due task with the exact synthetic event sequence", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "report", target: TARGET, prompt: "summarize" }))],
    });
    await h.scheduler.start();
    expect(h.loadTasks).toHaveBeenCalled();

    h.clock.advance(30 * 60_000);
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    expect(h.dispatched[0]).toEqual({
      type: "command.session.new",
      clientSessionId: "schedule:report:1",
      workingDirectory: await realpath(process.cwd()),
      workingDirectorySource: "default",
    });
    expect(h.dispatched[1]).toEqual({
      type: "user.message",
      clientSessionId: "schedule:report:1",
      text: "summarize",
    });
    expect(h.delivered).toEqual([]);

    // No re-fire while the clock stands still.
    await sleep(100);
    expect(h.dispatched).toHaveLength(2);
  });

  it("does not burst: a delayed tick fires at most once per task", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();

    h.clock.advance(3 * 60 * 60_000); // several due intervals at once
    await waitFor(() => expect(h.dispatched).toHaveLength(2));
    await sleep(100);
    expect(h.dispatched).toHaveLength(2); // exactly one fire despite the backlog

    h.clock.advance(30 * 60_000); // only the recomputed nextRun triggers again
    await waitFor(() => expect(h.dispatched).toHaveLength(4));
  });

  it("re-reads the task at fire time, so an edited prompt is used on the next fire", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "report", target: TARGET, prompt: "v1" }))],
    });
    await h.scheduler.start();

    h.clock.advance(30 * 60_000);
    await waitFor(() => expect(h.dispatched).toHaveLength(2));
    expect(h.dispatched[1]).toEqual({ type: "user.message", clientSessionId: "schedule:report:1", text: "v1" });

    h.tasks[0] = makeLoaded(makeTask({ name: "report", target: TARGET, prompt: "v2" }));
    h.clock.advance(30 * 60_000);
    await waitFor(() => expect(h.dispatched).toHaveLength(4));
    expect(h.dispatched[3]).toEqual({ type: "user.message", clientSessionId: "schedule:report:2", text: "v2" });
  });

  it("picks up newly added tasks on the next tick", async () => {
    const h = createHarness();
    await h.scheduler.start();

    h.tasks.push(makeLoaded(makeTask({ name: "fresh", target: TARGET })));
    await waitFor(() => expect(h.loadTasks.mock.calls.length).toBeGreaterThanOrEqual(2));
    h.clock.advance(30 * 60_000);
    await waitFor(() => expect(h.dispatched).toHaveLength(2));
    expect(h.dispatched[0]).toMatchObject({
      type: "command.session.new",
      clientSessionId: "schedule:fresh:1",
    });
  });

  it("removes deleted tasks and never fires disabled ones", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "gone", target: TARGET }))] });
    await h.scheduler.start();
    h.clock.advance(30 * 60_000);
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    // Delete the task file: no further fires.
    h.tasks.length = 0;
    h.clock.advance(30 * 60_000);
    await sleep(100);
    expect(h.dispatched).toHaveLength(2);

    // A disabled task never fires.
    const h2 = createHarness({
      tasks: [makeLoaded(makeTask({ name: "paused", target: TARGET, enabled: false }))],
    });
    await h2.scheduler.start();
    h2.clock.advance(30 * 60_000);
    await sleep(100);
    expect(h2.dispatched).toEqual([]);
  });

  it("re-anchors nextRun when the schedule changes", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();

    h.tasks[0] = makeLoaded(
      makeTask({ name: "report", target: TARGET, schedule: { type: "every", intervalMs: 24 * 60 * 60_000 } }),
    );
    await waitFor(() => expect(h.loadTasks.mock.calls.length).toBeGreaterThanOrEqual(2));
    h.clock.advance(30 * 60_000); // due under the old schedule, not the new one
    await sleep(100);
    expect(h.dispatched).toEqual([]);
  });

  it("fires only tasks bound to this channel: other channels and unbound tasks never tick", async () => {
    const h = createHarness({
      tasks: [
        makeLoaded(makeTask({ name: "mine", channel: "test", target: TARGET })),
        makeLoaded(makeTask({ name: "theirs", channel: "other", target: TARGET })),
        makeLoaded(makeTask({ name: "unbound", channel: undefined, target: TARGET })),
      ],
    });
    await h.scheduler.start();

    h.clock.advance(30 * 60_000);
    await waitFor(() => expect(h.dispatched).toHaveLength(2));
    await sleep(100);
    // Only the channel-owned task fired — "theirs" and "unbound" were skipped.
    expect(h.dispatched.every((event) => event.clientSessionId === "schedule:mine:1")).toBe(true);
  });
});

describe("fire-time validation (D6/D7)", () => {
  it("dispatches nothing and delivers a localized error when the working directory is invalid", async () => {
    const h = createHarness({
      tasks: [
        makeLoaded(
          makeTask({ name: "bad", directory: `/definitely/not/a/real/dir-${Date.now()}`, target: TARGET }),
        ),
      ],
    });
    await h.scheduler.start();
    const result = await h.scheduler.fire("bad");
    expect(result).toEqual({ ok: false, reason: "invalid working directory: no such file or directory" });
    expect(h.dispatched).toEqual([]);
    expect(h.delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: '❌ Scheduled task "bad" could not start: no such file or directory',
      },
    ]);
  });

  it("skips and only logs when the target is missing or fails validation", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "no-target" }))] });
    await h.scheduler.start();
    const result = await h.scheduler.fire("no-target");
    expect(result).toEqual({ ok: false, reason: "task has no valid target" });
    expect(h.dispatched).toEqual([]);
    expect(h.delivered).toEqual([]);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("no valid target"));

    const h2 = createHarness({
      tasks: [makeLoaded(makeTask({ name: "bad-target", target: TARGET }))],
      validateTarget: () => false,
    });
    await h2.scheduler.start();
    const result2 = await h2.scheduler.fire("bad-target");
    expect(result2).toEqual({ ok: false, reason: "task has no valid target" });
    expect(h2.dispatched).toEqual([]);
    expect(h2.delivered).toEqual([]);
  });

  it("delivers a localized error when the prompt is empty", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "empty", target: TARGET, prompt: "   " }))],
    });
    await h.scheduler.start();
    const result = await h.scheduler.fire("empty");
    expect(result).toEqual({ ok: false, reason: "task body is empty" });
    expect(h.dispatched).toEqual([]);
    expect(h.delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: '❌ Scheduled task "empty" could not start: task body is empty',
      },
    ]);
  });

  it("reports task not found and disabled from fire and runNow", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "off", target: TARGET, enabled: false }))] });
    await h.scheduler.start();
    expect(await h.scheduler.fire("missing")).toEqual({ ok: false, reason: "task not found" });
    expect(await h.scheduler.fire("off")).toEqual({ ok: false, reason: "task is disabled" });
    expect(await h.scheduler.runNow("missing")).toEqual({ ok: false, reason: "task not found" });
  });

  it("refuses to fire a task belonging to another channel, naming that channel", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "theirs", channel: "other", target: TARGET }))],
    });
    await h.scheduler.start();
    expect(await h.scheduler.fire("theirs")).toEqual({
      ok: false,
      reason: 'task belongs to channel "other"',
    });
    expect(await h.scheduler.runNow("theirs")).toEqual({
      ok: false,
      reason: 'task belongs to channel "other"',
    });
    expect(h.dispatched).toEqual([]);
    expect(h.delivered).toEqual([]);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('belongs to channel "other"'));
  });

  it("fires a legacy task with no channel field via runNow when it has a valid target (status quo)", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "legacy", channel: undefined, target: TARGET }))],
    });
    await h.scheduler.start();
    expect(await h.scheduler.runNow("legacy")).toEqual({ ok: true });
    expect(h.dispatched).toHaveLength(2);
    expect(h.dispatched[0]).toMatchObject({ type: "command.session.new", clientSessionId: "schedule:legacy:1" });
  });

  it("fire and runNow share the same success path", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "ok", target: TARGET, prompt: "hello" }))] });
    await h.scheduler.start();
    const result = await h.scheduler.runNow("ok");
    expect(result).toEqual({ ok: true });
    expect(h.dispatched).toEqual([
      {
        type: "command.session.new",
        clientSessionId: "schedule:ok:1",
        workingDirectory: await realpath(process.cwd()),
        workingDirectorySource: "default",
      },
      { type: "user.message", clientSessionId: "schedule:ok:1", text: "hello" },
    ]);

    // A run was registered: its completion signal is honored.
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:ok:1", text: "done" });
    expect(h.delivered).toEqual([
      { type: "assistant.message", clientSessionId: TARGET, text: '📋 Scheduled task "ok":\ndone' },
    ]);
  });
});

describe("per-task model override (scheduled-task-model spec)", () => {
  it("dispatches the task's pinned model on the synthetic session.new event", async () => {
    const h = createHarness({
      tasks: [
        makeLoaded(
          makeTask({ name: "pinned", target: TARGET, model: "azure-openai-responses/gpt-5.6-terra" }),
        ),
      ],
    });
    await h.scheduler.start();
    expect(await h.scheduler.fire("pinned")).toEqual({ ok: true });
    expect(h.dispatched[0]).toEqual({
      type: "command.session.new",
      clientSessionId: "schedule:pinned:1",
      workingDirectory: await realpath(process.cwd()),
      workingDirectorySource: "default",
      model: "azure-openai-responses/gpt-5.6-terra",
    });
    expect(h.dispatched[1]).toEqual({
      type: "user.message",
      clientSessionId: "schedule:pinned:1",
      text: "do the thing",
    });
  });

  it("leaves the model field absent when the task has no pinned model", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "plain", target: TARGET }))] });
    await h.scheduler.start();
    expect(await h.scheduler.fire("plain")).toEqual({ ok: true });
    expect("model" in h.dispatched[0]!).toBe(false);
    expect(h.dispatched[0]).toEqual({
      type: "command.session.new",
      clientSessionId: "schedule:plain:1",
      workingDirectory: await realpath(process.cwd()),
      workingDirectorySource: "default",
    });
  });
});

describe("dispatch failure (T6)", () => {
  it("fails the fire when session.new dispatch reports { ok: false }: run ended, no user.message, failure delivered to target", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "report", target: TARGET, prompt: "summarize" }))],
    });
    await h.scheduler.start();

    // A session-creation failure (for example an invalid/unavailable task
    // model rejected by the adapter) surfaces through the ingress result.
    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      h.dispatched.push(event);
      if (event.type === "command.session.new") {
        return { ok: false, reason: "boom: model not available" };
      }
      return { ok: true } as const;
    });

    const result = await h.scheduler.fire("report");
    // /schedule-run invokers see the real cause, not a generic message.
    expect(result).toEqual({ ok: false, reason: "boom: model not available" });

    // The run ended and the user.message was never dispatched: there is no
    // path to auto-create a model-less session (the pre-T6 silent fallback).
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({ type: "command.session.new" });
    expect(h.delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: '❌ Scheduled task "report" failed. boom: model not available',
      },
    ]);

    // The run has ended: a late completion is an orphan and delivers nothing.
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:report:1", text: "late" });
    expect(h.delivered).toHaveLength(1);
  });

  it("fails the fire when user.message dispatch reports { ok: false } with the same handling", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "report", target: TARGET, prompt: "summarize" }))],
    });
    await h.scheduler.start();

    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      h.dispatched.push(event);
      if (event.type === "user.message") {
        return { ok: false, reason: "boom: prompt rejected" };
      }
      return { ok: true } as const;
    });

    const result = await h.scheduler.fire("report");
    expect(result).toEqual({ ok: false, reason: "boom: prompt rejected" });
    expect(h.dispatched).toHaveLength(2);
    expect(h.delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: '❌ Scheduled task "report" failed. boom: prompt rejected',
      },
    ]);
  });

  it("a task without a valid target still returns { ok: false } with no dispatch and no delivery attempt", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "no-target" }))] });
    await h.scheduler.start();
    const result = await h.scheduler.fire("no-target");
    expect(result).toEqual({ ok: false, reason: "task has no valid target" });
    // The fire validates the target before dispatching, so the dispatch-
    // failure handler never runs for an unbound task (its no-target branch
    // is defensive only).
    expect(h.dispatchClientEvent).not.toHaveBeenCalled();
    expect(h.delivered).toEqual([]);
  });
});

describe("timeout (D5)", () => {
  it("aborts the synthetic session and delivers a localized timeout notice", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "slow", target: TARGET, timeoutMs: 100 }))],
    });
    await h.scheduler.start();
    await h.scheduler.runNow("slow");

    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.dispatched[2]).toEqual({ type: "command.session.stop", clientSessionId: "schedule:slow:1" });
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: '⏰ Scheduled task "slow" timed out.',
    });

    // The run has ended: a late completion is an orphan and delivers nothing.
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:slow:1", text: "too late" });
    expect(h.delivered).toHaveLength(1);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("orphan"));
  });
});

describe("handleOutput (D2)", () => {
  it("delivers the result with the localized task header and ends the run", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:report:1", text: "line1\nline2" });
    expect(h.delivered).toEqual([
      { type: "assistant.message", clientSessionId: TARGET, text: '📋 Scheduled task "report":\nline1\nline2' },
    ]);

    // The run ended: a second completion is an orphan.
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:report:1", text: "again" });
    expect(h.delivered).toHaveLength(1);
  });

  it("passes attachments through on the result", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    const attachments: OutboundAttachment[] = [{ kind: "file", filePath: "/tmp/x.txt", fileName: "x.txt" }];
    h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: "schedule:report:1",
      text: "see attached",
      attachments,
    });
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: '📋 Scheduled task "report":\nsee attached',
      attachments,
    });
  });

  it("delivers a no-output notice for an empty result instead of silence", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "quiet", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("quiet");

    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:quiet:1", text: "   " });
    expect(h.delivered).toEqual([
      { type: "assistant.message", clientSessionId: TARGET, text: 'Scheduled task "quiet" finished with no output.' },
    ]);
  });

  it("delivers a localized failure notice on a terminal error and ends the run", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    h.scheduler.handleOutput({ type: "error", clientSessionId: "schedule:report:1", kind: "agent.run.failed", detail: "boom" });
    expect(h.delivered).toEqual([
      { type: "assistant.message", clientSessionId: TARGET, text: '❌ Scheduled task "report" failed. boom' },
    ]);

    // The run ended: a second error is an orphan.
    h.scheduler.handleOutput({ type: "error", clientSessionId: "schedule:report:1", kind: "agent.run.failed" });
    expect(h.delivered).toHaveLength(1);
  });

  it("ignores non-schedule sessions and discards intermediate events", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: TARGET, text: "user's chat reply" });
    h.scheduler.handleOutput({ type: "assistant.thinking", clientSessionId: "schedule:report:1", text: "thinking..." });
    h.scheduler.handleOutput({
      type: "agent.status.info",
      clientSessionId: "schedule:report:1",
      status: { sessionId: "s1" },
    });
    expect(h.delivered).toEqual([]);

    // The run is still alive after the discarded intermediate events.
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:report:1", text: "final" });
    expect(h.delivered).toHaveLength(1);
  });

  it("drops orphan events for schedule sessions with no active run", async () => {
    const h = createHarness();
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:ghost:1", text: "x" });
    expect(h.delivered).toEqual([]);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("orphan"));
  });
});

describe("concurrent runs of the same task (D5)", () => {
  it("keeps concurrent runs isolated: results are attributed to their own run", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();

    // Two fires of the same task while the first run is still active.
    expect(await h.scheduler.fire("report")).toEqual({ ok: true });
    expect(await h.scheduler.fire("report")).toEqual({ ok: true });

    // Each run got its own run-unique synthetic session id.
    expect(h.dispatched.map((e) => e.clientSessionId)).toEqual([
      "schedule:report:1",
      "schedule:report:1",
      "schedule:report:2",
      "schedule:report:2",
    ]);

    // Run 1 completes: its result is delivered and run 2 is untouched.
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:report:1", text: "first" });
    expect(h.delivered).toEqual([
      { type: "assistant.message", clientSessionId: TARGET, text: '📋 Scheduled task "report":\nfirst' },
    ]);

    // A late event from the ended run 1 is an orphan — it can never be
    // mistaken for run 2's result.
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:report:1", text: "stale" });
    expect(h.delivered).toHaveLength(1);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("orphan"));

    // Run 2 still completes normally with its own result.
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:report:2", text: "second" });
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: '📋 Scheduled task "report":\nsecond',
    });
  });

  it("times out only its own run when concurrent runs overlap", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "report", target: TARGET, timeoutMs: 100 }))],
    });
    await h.scheduler.start();
    expect(await h.scheduler.fire("report")).toEqual({ ok: true });
    expect(await h.scheduler.fire("report")).toEqual({ ok: true });

    // Run 1 completes normally, clearing only its own timer...
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:report:1", text: "ok" });
    expect(h.delivered).toHaveLength(1);

    // ...so run 2's independent timer still fires: it aborts only run 2's
    // session and delivers the timeout notice for run 2.
    await waitFor(() => expect(h.delivered).toHaveLength(2));
    expect(
      h.dispatched.some((e) => e.type === "command.session.stop" && e.clientSessionId === "schedule:report:2"),
    ).toBe(true);
    expect(
      h.dispatched.some((e) => e.type === "command.session.stop" && e.clientSessionId === "schedule:report:1"),
    ).toBe(false);
    expect(h.delivered[1]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: '⏰ Scheduled task "report" timed out.',
    });
  });
});

describe("stop() races (SF-2)", () => {
  it("registers no run and delivers nothing when stop lands during a fire's load await", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();

    // Slow down every subsequent task load so the fire blocks mid-await.
    let releaseLoad: () => void = () => {};
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    h.loadTasks.mockImplementation(async () => {
      await loadGate;
      return [...h.tasks];
    });

    const firePromise = h.scheduler.fire("report"); // blocks on the load gate
    await h.scheduler.stop(); // lands while the fire is awaiting
    releaseLoad();

    const result = await firePromise;
    expect(result).toEqual({ ok: false, reason: "scheduler is not running" });
    expect(h.dispatched).toEqual([]);
    expect(h.delivered).toEqual([]);

    // Nothing was registered after stop: any event is an orphan.
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:report:1", text: "x" });
    expect(h.delivered).toEqual([]);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("orphan"));
  });

  it("stop during the dispatch await leaves no run record and no timer behind", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "report", target: TARGET, timeoutMs: 50 }))],
    });
    await h.scheduler.start();

    // Hold the fire inside its first dispatch (the run is already registered).
    let enteredDispatch: () => void = () => {};
    const dispatchEntered = new Promise<void>((resolve) => {
      enteredDispatch = resolve;
    });
    let releaseDispatch: () => void = () => {};
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      if (event.type === "command.session.new") {
        enteredDispatch();
        await dispatchGate;
      }
      return { ok: true } as const;
    });

    const firePromise = h.scheduler.fire("report");
    await dispatchEntered; // run registered, session.new in flight
    await h.scheduler.stop(); // clears the registered run and its timer
    releaseDispatch();

    expect(await firePromise).toEqual({ ok: true });

    // The run's 50 ms timer was cleared by stop(): long past its timeout
    // there is no stop dispatch and no timeout notice.
    await sleep(200);
    expect(h.dispatched.filter((e) => e.type === "command.session.stop")).toEqual([]);
    expect(h.delivered).toEqual([]);
  });

  it("delivers nothing when a post-stop dispatch resolves { ok:false } with the gateway reason", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "report", target: TARGET, timeoutMs: 50 }))],
    });
    await h.scheduler.start();

    // Hold the fire inside its first dispatch (the run is already registered),
    // then let stop() land before the dispatch resolves the way the real core
    // does after teardown: `{ ok: false, reason: "gateway is not running" }`
    // (the ingress never rejects). Pre-T6 this same post-stop dispatch was a
    // silent no-op; the fire must not treat it as a task failure.
    let enteredDispatch: () => void = () => {};
    const dispatchEntered = new Promise<void>((resolve) => {
      enteredDispatch = resolve;
    });
    let releaseDispatch: () => void = () => {};
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      if (event.type === "command.session.new") {
        enteredDispatch();
        await dispatchGate;
      }
      return { ok: false, reason: "gateway is not running" } as const;
    });

    const firePromise = h.scheduler.fire("report");
    await dispatchEntered; // run registered, session.new in flight
    await h.scheduler.stop();
    releaseDispatch();

    // The failure is reported to the caller but nothing is delivered: a
    // post-stop dispatch failure is not a task failure (no spurious
    // `taskFailed` notice in the target chat).
    expect(await firePromise).toEqual({ ok: false, reason: "gateway is not running" });
    expect(h.delivered).toEqual([]);

    // The run was ended: its 50 ms timer never fires (no stop dispatch, no
    // timeout notice) and any late output is treated as an orphan.
    await sleep(200);
    expect(h.dispatched.filter((e) => e.type === "command.session.stop")).toEqual([]);
    expect(h.delivered).toEqual([]);
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:report:1", text: "x" });
    expect(h.delivered).toEqual([]);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("orphan"));
  });
});

describe("integration with the real task-file loader", () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scheduler-it-"));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("loads a task file from disk, fires it on schedule, and delivers the result", async () => {
    await writeFile(
      path.join(tempRoot, "report.md"),
      `---
schedule: every 30m
directory: ${tempRoot}
channel: test
target: ${TARGET}
---

summarize the logs
`,
      "utf8",
    );

    const clock = new FakeClock();
    const dispatched: ClientOutputEvent[] = [];
    const delivered: ClientInputEvent[] = [];
    const dispatchClientEvent = vi.fn(async (event: ClientOutputEvent) => {
      dispatched.push(event);
      return { ok: true } as const;
    });
    const deliver = vi.fn(async (event: ClientInputEvent) => {
      delivered.push(event);
    });
    const logger: MockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduler = new Scheduler({
      channelName: "test",
      tickMs: 20,
      now: () => clock.now(),
      dispatchClientEvent,
      deliver,
      t: getTranslator("en-US"),
      schedulesRoot: tempRoot,
      logger,
    });
    schedulers.push(scheduler);

    await scheduler.start();
    clock.advance(30 * 60_000);
    await waitFor(() => expect(dispatched).toHaveLength(2));
    expect(dispatched[0]).toMatchObject({
      type: "command.session.new",
      clientSessionId: "schedule:report:1",
      workingDirectory: await realpath(tempRoot),
      workingDirectorySource: "default",
    });
    expect(dispatched[1]).toMatchObject({ type: "user.message", text: "summarize the logs" });

    scheduler.handleOutput({ type: "assistant.message", clientSessionId: "schedule:report:1", text: "done!" });
    expect(delivered).toEqual([
      { type: "assistant.message", clientSessionId: TARGET, text: '📋 Scheduled task "report":\ndone!' },
    ]);
  });

  it("binds an unbound task by writing the target and channel lines, and refuses a rebind", async () => {
    await writeFile(
      path.join(tempRoot, "report.md"),
      "---\nschedule: every 30m\n---\nsummarize\n",
      "utf8",
    );

    const clock = new FakeClock();
    const dispatchClientEvent = vi.fn(async () => ({ ok: true } as const));
    const deliver = vi.fn(async () => {});
    const logger: MockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduler = new Scheduler({
      channelName: "test",
      tickMs: 20,
      now: () => clock.now(),
      dispatchClientEvent,
      deliver,
      t: getTranslator("en-US"),
      schedulesRoot: tempRoot,
      logger,
    });
    schedulers.push(scheduler);

    await scheduler.start(); // initial tick populates the task table

    expect(await scheduler.claimTarget("report", TARGET)).toEqual({ ok: true });
    const content = await readFile(path.join(tempRoot, "report.md"), "utf8");
    // An unbound task is bound with both lines in one atomic write (T2).
    expect(content).toContain(`target: ${TARGET}`);
    expect(content).toContain("channel: test");
    expect(content.match(/target:/g)).toHaveLength(1);
    expect(content.match(/channel:/g)).toHaveLength(1);

    // A bound task is refused: unbinding is a manual file edit, not a command.
    expect(await scheduler.claimTarget("report", "feishu:dm:oc_other")).toEqual({
      ok: false,
      reason: "task already bound",
    });
    const content2 = await readFile(path.join(tempRoot, "report.md"), "utf8");
    expect(content2).toContain(`target: ${TARGET}`);
    expect(content2).not.toContain("feishu:dm:oc_other");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("already bound"));
  });

  it("refuses to bind a task that already has a target or a channel", async () => {
    // Only `target` set: manually bound, already claimed by someone.
    await writeFile(
      path.join(tempRoot, "has-target.md"),
      "---\nschedule: every 30m\ntarget: feishu:dm:oc_someone\n---\nbody\n",
      "utf8",
    );
    // Only `channel` set: owned by another channel, not this one.
    await writeFile(
      path.join(tempRoot, "has-channel.md"),
      "---\nschedule: every 30m\nchannel: other\n---\nbody\n",
      "utf8",
    );

    const clock = new FakeClock();
    const dispatchClientEvent = vi.fn(async () => ({ ok: true } as const));
    const deliver = vi.fn(async () => {});
    const logger: MockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduler = new Scheduler({
      channelName: "test",
      tickMs: 20,
      now: () => clock.now(),
      dispatchClientEvent,
      deliver,
      t: getTranslator("en-US"),
      schedulesRoot: tempRoot,
      logger,
    });
    schedulers.push(scheduler);
    await scheduler.start();

    expect(await scheduler.claimTarget("has-target", TARGET)).toEqual({
      ok: false,
      reason: "task already bound",
    });
    expect(await scheduler.claimTarget("has-channel", TARGET)).toEqual({
      ok: false,
      reason: "task already bound",
    });

    // Nothing was overwritten on disk.
    const targetContent = await readFile(path.join(tempRoot, "has-target.md"), "utf8");
    expect(targetContent).toContain("target: feishu:dm:oc_someone");
    expect(targetContent).not.toContain("channel: test");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("already bound"));
  });

  it("claimTarget reports task not found without a side effect", async () => {
    const clock = new FakeClock();
    const dispatchClientEvent = vi.fn(async () => ({ ok: true } as const));
    const deliver = vi.fn(async () => {});
    const logger: MockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduler = new Scheduler({
      channelName: "test",
      tickMs: 20,
      now: () => clock.now(),
      dispatchClientEvent,
      deliver,
      t: getTranslator("en-US"),
      schedulesRoot: tempRoot,
      logger,
    });
    schedulers.push(scheduler);

    await scheduler.start();
    expect(await scheduler.claimTarget("ghost", TARGET)).toEqual({
      ok: false,
      reason: "task not found",
    });
    // Nothing new was written to the directory.
    expect(await readdir(tempRoot).catch(() => [] as string[])).toEqual([]);
  });

  it("claimTarget finds a file written after the last tick via an immediate load", async () => {
    const clock = new FakeClock();
    const dispatchClientEvent = vi.fn(async () => ({ ok: true } as const));
    const deliver = vi.fn(async () => {});
    const logger: MockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduler = new Scheduler({
      channelName: "test",
      tickMs: 20,
      now: () => clock.now(),
      dispatchClientEvent,
      deliver,
      t: getTranslator("en-US"),
      schedulesRoot: tempRoot,
      logger,
    });
    schedulers.push(scheduler);

    await scheduler.start(); // empty directory at start: task table has nothing

    // The file appears after the last tick...
    await writeFile(
      path.join(tempRoot, "late.md"),
      "---\nschedule: daily 09:00\n---\nBody.\n",
      "utf8",
    );
    // ...and claimTarget finds it through the immediate-load fallback.
    expect(await scheduler.claimTarget("late", TARGET)).toEqual({ ok: true });
    const content = await readFile(path.join(tempRoot, "late.md"), "utf8");
    expect(content).toContain(`target: ${TARGET}`);
  });
});
