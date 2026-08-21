import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientInputEvent, ClientOutputEvent, OutboundAttachment } from "../../types";
import { getTranslator } from "../../i18n";
import type { Logger } from "../../core/logger";
import {
  DONE_MARKER,
  buildProbeMessage,
  buildTaskPrompt,
  sanitizeSessionId,
} from "../run-completion";
import { readRunHistory, type RunHistoryRecord } from "../run-completion/history";
import * as historyModule from "../run-completion/history";
import { DEFAULT_TIMEOUT_MS, type LoadedTask, type ScheduleTask } from "./task-file";
import {
  Scheduler,
  parseSyntheticSessionId,
  syntheticSessionId,
} from "./scheduler";

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
    scheduleRaw: "scheduleRaw" in overrides ? overrides.scheduleRaw : "every 30m",
    schedule: overrides.schedule ?? { type: "every", intervalMs: 30 * 60_000 },
    directory: overrides.directory,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    silenceMs: overrides.silenceMs ?? 10 * 60_000,
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
  /** Isolated run-outputs dir for this harness's accumulators (cleaned up). */
  outputsDir: string;
  /** Isolated run-history root for this harness's JSONL index (cleaned up). */
  historyRoot: string;
  /** Expected synthetic run id for the nth fire of a task (clock-derived). */
  runId: (task: string, seq: number) => string;
}

const schedulers: Scheduler[] = [];
let outSeq = 0;
const outDirs: string[] = [];

/** Absolute path a run's accumulation file lands at (session id -> file). */
function runOutputPath(outputsDir: string, sessionId: string): string {
  return path.join(outputsDir, `${sanitizeSessionId(sessionId)}.md`);
}
function completedSuffix(h: Harness, task: string, sessionId: string): string {
  return `*Scheduled task "${task}" completed · full output: ${runOutputPath(h.outputsDir, sessionId)}*`;
}
function failedSuffix(h: Harness, task: string, sessionId: string): string {
  return `*Scheduled task "${task}" failed · full output: ${runOutputPath(h.outputsDir, sessionId)}*`;
}
function timedOutSuffix(h: Harness, task: string, sessionId: string): string {
  return `*Scheduled task "${task}" timed out · full output: ${runOutputPath(h.outputsDir, sessionId)}*`;
}
function noOutputSuffix(h: Harness, task: string, sessionId: string): string {
  return `*Scheduled task "${task}" finished with no output · full output: ${runOutputPath(h.outputsDir, sessionId)}*`;
}

function createHarness(options: { tasks?: LoadedTask[]; validateTarget?: (id: string) => boolean } = {}): Harness {
  const clock = new FakeClock();
  const dispatched: ClientOutputEvent[] = [];
  const delivered: ClientInputEvent[] = [];
  // Isolated per-harness outputs dir: the accumulator writes here lazily (no
  // need for it to pre-exist) and it is cleaned up in afterEach.
  const outputsDir = path.join(os.tmpdir(), `agent-bridge-sched-runout-${(outSeq += 1)}`);
  outDirs.push(outputsDir);
  const historyRoot = path.join(os.tmpdir(), `agent-bridge-sched-history-${(outSeq += 1)}`);
  outDirs.push(historyRoot);
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
    outputsDir,
    historyRoot,
    ...(options.validateTarget !== undefined ? { validateTarget: options.validateTarget } : {}),
  });
  schedulers.push(scheduler);
  return {
    clock,
    dispatched,
    delivered,
    dispatchClientEvent,
    deliver,
    loadTasks,
    logger,
    tasks,
    scheduler,
    outputsDir,
    historyRoot,
    // Run-history spec D4: ids are `schedule:<task>:<yyyymmdd-hhmmss>-<seq>`
    // derived from the fake clock's current LOCAL time. Test bodies advance
    // the clock between fires, so the timestamp is captured at call time.
    runId: (task: string, seq: number) => syntheticSessionId(task, seq, clock.now()),
  };
}

afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) {
    await scheduler.stop();
  }
  for (const dir of outDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
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
      clientSessionId: h.runId("report", 1),
      workingDirectory: await realpath(process.cwd()),
      workingDirectorySource: "default",
    });
    expect(h.dispatched[1]).toEqual({
      type: "user.message",
      clientSessionId: h.runId("report", 1),
      text: buildTaskPrompt("summarize", ""),
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
    expect(h.dispatched[1]).toEqual({
      type: "user.message",
      clientSessionId: h.runId("report", 1),
      text: buildTaskPrompt("v1", ""),
    });

    h.tasks[0] = makeLoaded(makeTask({ name: "report", target: TARGET, prompt: "v2" }));
    h.clock.advance(30 * 60_000);
    await waitFor(() => expect(h.dispatched).toHaveLength(4));
    expect(h.dispatched[3]).toEqual({
      type: "user.message",
      clientSessionId: h.runId("report", 2),
      text: buildTaskPrompt("v2", ""),
    });
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
      clientSessionId: h.runId("fresh", 1),
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
    expect(h.dispatched.every((event) => event.clientSessionId === h.runId("mine", 1))).toBe(true);
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
    expect(h.dispatched[0]).toMatchObject({ type: "command.session.new", clientSessionId: h.runId("legacy", 1) });
  });

  it("fire and runNow share the same success path", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "ok", target: TARGET, prompt: "hello" }))] });
    await h.scheduler.start();
    const result = await h.scheduler.runNow("ok");
    expect(result).toEqual({ ok: true });
    expect(h.dispatched).toEqual([
      {
        type: "command.session.new",
        clientSessionId: h.runId("ok", 1),
        workingDirectory: await realpath(process.cwd()),
        workingDirectorySource: "default",
      },
      { type: "user.message", clientSessionId: h.runId("ok", 1), text: buildTaskPrompt("hello", "") },
    ]);

    // A run was registered: its completion signal (DONE marker) is honored.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("ok", 1),
      text: `done\n${DONE_MARKER}`,
    });
    expect(h.delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: `done\n\n${completedSuffix(h, "ok", h.runId("ok", 1))}`,
      },
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
      clientSessionId: h.runId("pinned", 1),
      workingDirectory: await realpath(process.cwd()),
      workingDirectorySource: "default",
      model: "azure-openai-responses/gpt-5.6-terra",
    });
    expect(h.dispatched[1]).toEqual({
      type: "user.message",
      clientSessionId: h.runId("pinned", 1),
      text: buildTaskPrompt("do the thing", ""),
    });
  });

  it("leaves the model field absent when the task has no pinned model", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "plain", target: TARGET }))] });
    await h.scheduler.start();
    expect(await h.scheduler.fire("plain")).toEqual({ ok: true });
    expect("model" in h.dispatched[0]!).toBe(false);
    expect(h.dispatched[0]).toEqual({
      type: "command.session.new",
      clientSessionId: h.runId("plain", 1),
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
        text: `boom: model not available\n\n${failedSuffix(h, "report", h.runId("report", 1))}`,
      },
    ]);

    // The run has ended: a late completion is an orphan and delivers nothing.
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: h.runId("report", 1), text: "late" });
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
        text: `boom: prompt rejected\n\n${failedSuffix(h, "report", h.runId("report", 1))}`,
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
    expect(h.dispatched[2]).toEqual({ type: "command.session.stop", clientSessionId: h.runId("slow", 1) });
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: timedOutSuffix(h, "slow", h.runId("slow", 1)),
    });

    // The run has ended: a late completion is an orphan and delivers nothing.
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: h.runId("slow", 1), text: "too late" });
    expect(h.delivered).toHaveLength(1);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("orphan"));
  });

  it("delivers only the timeout notice (no inlined partial transcript) referencing the kept file", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "slow", target: TARGET, timeoutMs: 100 }))],
    });
    await h.scheduler.start();
    await h.scheduler.runNow("slow");

    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("slow", 1),
      text: "partial work",
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: timedOutSuffix(h, "slow", h.runId("slow", 1)),
    });
    // The partial transcript is NOT inlined.
    expect(h.delivered[0]!.text).not.toContain("partial work");
    // The accumulation file (with the partial work) is still on disk.
    await expect(stat(runOutputPath(h.outputsDir, h.runId("slow", 1)))).resolves.toBeDefined();
  });
});

// The probe is a real timer (createSilenceProbe uses setTimeout); these tests
// use a tiny `silenceMs` so the window elapses within the waitFor budget.
describe("silence probe (T3, layer 2)", () => {
  it("dispatches a probing user.message into the run session after silence", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "report", target: TARGET, silenceMs: 50 }))],
    });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    // Initial fire dispatches the task prompt; after 50 ms of silence the
    // probe dispatches a probing user.message (silentMinutes=1 for <1min).
    await waitFor(() =>
      expect(
        h.dispatched.some((e) => e.type === "user.message" && e.text === buildProbeMessage(1)),
      ).toBe(true),
    );
  });

  it("accumulates the probe answer, keeps the run alive, and delivers once on a later DONE", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "report", target: TARGET, silenceMs: 50 }))],
    });
    await h.scheduler.start();
    const probeCount = () =>
      h.dispatched.filter((e) => e.type === "user.message" && e.text.startsWith("You have been silent")).length;

    await h.scheduler.runNow("report");
    await waitFor(() => expect(probeCount()).toBe(1));

    // Probe answer WITHOUT DONE: accumulated, run continues, no delivery.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: "still working",
    });
    expect(h.delivered).toEqual([]);

    // DONE after the probe: delivered exactly once — the LAST assistant
    // message only (the probe answer is dropped from the delivery, but the
    // kept accumulation file still holds the full transcript).
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: `done now\n${DONE_MARKER}`,
    });
    expect(h.delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: `done now\n\n${completedSuffix(h, "report", h.runId("report", 1))}`,
      },
    ]);
  });

  it("peeks: activity resets the silence window so the probe does not fire", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "report", target: TARGET, silenceMs: 200 }))],
    });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    // Keep poking every ~30 ms; each poke resets the 200 ms window, so the
    // silence threshold never elapses while activity is ongoing.
    for (let i = 0; i < 5; i++) {
      await sleep(30);
      await h.scheduler.handleOutput({
        type: "assistant.thinking",
        clientSessionId: h.runId("report", 1),
        text: "...",
      });
    }
    // No probe was dispatched during the sustained-activity period.
    expect(h.dispatched.some((e) => e.text === buildProbeMessage(1))).toBe(false);
  });
});

describe("stop() mid-run (T3)", () => {
  it("stop mid-run keeps the accumulation file without delivering (T2)", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: "partial work",
    });
    await h.scheduler.stop();
    expect(h.delivered).toEqual([]);
    // The partial transcript stays readable on disk (decision: no dispose()).
    await expect(stat(runOutputPath(h.outputsDir, h.runId("report", 1)))).resolves.toBeDefined();

    // A late completion after stop is an orphan: nothing delivered.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: `x\n${DONE_MARKER}`,
    });
    expect(h.delivered).toEqual([]);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("orphan"));
  });
});

describe("handleOutput / three-layer completion (T3)", () => {
  it("accumulates two assistant messages and delivers them once only on DONE, marker stripped", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    // First message (no marker): accumulated, run NOT ended, nothing delivered.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: "step one",
    });
    expect(h.delivered).toEqual([]);

    // Second message: still no delivery.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: "step two",
    });
    expect(h.delivered).toEqual([]);

    // DONE: a single delivery carrying ONLY the last message, marker stripped
    // (the earlier steps live in the kept accumulation file).
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: `step three\n${DONE_MARKER}`,
    });
    expect(h.delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: `step three\n\n${completedSuffix(h, "report", h.runId("report", 1))}`,
      },
    ]);
    expect(h.delivered[0]!.text).not.toContain(DONE_MARKER);
    expect(h.delivered[0]!.text).not.toContain("step one");

    // The run ended: a second completion is an orphan.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: `again\n${DONE_MARKER}`,
    });
    expect(h.delivered).toHaveLength(1);
  });

  it("merges attachments from every accumulated message onto the final delivery", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    const a1: OutboundAttachment[] = [{ kind: "file", filePath: "/tmp/a.txt", fileName: "a.txt" }];
    const a2: OutboundAttachment[] = [{ kind: "file", filePath: "/tmp/b.txt", fileName: "b.txt" }];
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: "first",
      attachments: a1,
    });
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: `second\n${DONE_MARKER}`,
      attachments: a2,
    });
    // Only the last message is delivered as text, but attachments from BOTH
    // messages still travel with it.
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `second\n\n${completedSuffix(h, "report", h.runId("report", 1))}`,
      attachments: [...a1, ...a2],
    });
  });

  it("delivers a no-output notice when the run ends with empty accumulation", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "quiet", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("quiet");

    // Only the marker: the curated content is empty, so no-output is delivered.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("quiet", 1),
      text: DONE_MARKER,
    });
    expect(h.delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: noOutputSuffix(h, "quiet", h.runId("quiet", 1)),
      },
    ]);
    // Even a no-output delivery keeps the (empty/whitespace) accumulation file.
    await expect(stat(runOutputPath(h.outputsDir, h.runId("quiet", 1)))).resolves.toBeDefined();
  });

  it("carries attachments from earlier messages on a no-output (empty last message) delivery", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    // Early message with an attachment (accumulated; no delivery yet).
    const a1: OutboundAttachment[] = [{ kind: "file", filePath: "/tmp/a.txt", fileName: "a.txt" }];
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: "first",
      attachments: a1,
    });
    expect(h.delivered).toEqual([]);

    // Empty last message (DONE only): the no-output suffix is the text, but
    // the attachment collected earlier still travels with the delivery.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: DONE_MARKER,
    });
    expect(h.delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: noOutputSuffix(h, "report", h.runId("report", 1)),
        attachments: a1,
      },
    ]);
    // The kept accumulation file exists even with an empty last message.
    await expect(stat(runOutputPath(h.outputsDir, h.runId("report", 1)))).resolves.toBeDefined();
  });

  it("a bare message without DONE does not end the run", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    // Whitespace-only, no marker: accumulated but the run stays alive.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: "   ",
    });
    expect(h.delivered).toEqual([]);
    // Still alive: a DONE-only message delivers (empty) accumulated content.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: DONE_MARKER,
    });
    expect(h.delivered).toHaveLength(1);
  });

  it("delivers only the reason (not the partial transcript) on a terminal error (T2)", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: "partial work",
    });
    await h.scheduler.handleOutput({
      type: "error",
      clientSessionId: h.runId("report", 1),
      kind: "agent.run.failed",
      detail: "boom",
    });
    expect(h.delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: `boom\n\n${failedSuffix(h, "report", h.runId("report", 1))}`,
      },
    ]);
    // The partial transcript is NOT inlined.
    expect(h.delivered[0]!.text).not.toContain("partial work");

    // The run ended: a second error is an orphan.
    await h.scheduler.handleOutput({ type: "error", clientSessionId: h.runId("report", 1), kind: "agent.run.failed" });
    expect(h.delivered).toHaveLength(1);
  });

  it("delivers only the failure notice when there is no partial content", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    await h.scheduler.handleOutput({
      type: "error",
      clientSessionId: h.runId("report", 1),
      kind: "agent.run.failed",
      detail: "boom",
    });
    expect(h.delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: `boom\n\n${failedSuffix(h, "report", h.runId("report", 1))}`,
      },
    ]);
  });

  it("treats intermediate events as activity (no run end) and ignores non-schedule sessions", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");

    await h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: TARGET, text: "user's chat reply" });
    await h.scheduler.handleOutput({ type: "assistant.thinking", clientSessionId: h.runId("report", 1), text: "thinking..." });
    await h.scheduler.handleOutput({
      type: "agent.status.info",
      clientSessionId: h.runId("report", 1),
      status: { sessionId: "s1" },
    });
    expect(h.delivered).toEqual([]);

    // The run is still alive after the intermediate events.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: `final\n${DONE_MARKER}`,
    });
    expect(h.delivered).toHaveLength(1);
  });

  it("drops orphan events for schedule sessions with no active run", async () => {
    const h = createHarness();
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: syntheticSessionId("ghost", 1, h.clock.now()),
      text: "x",
    });
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

    // Each run got its own run-unique synthetic session id (same-second
    // fires: both timestamps are the fake clock's current time, only the
    // seq suffix differs — run-history spec D4).
    expect(h.dispatched.map((e) => e.clientSessionId)).toEqual([
      h.runId("report", 1),
      h.runId("report", 1),
      h.runId("report", 2),
      h.runId("report", 2),
    ]);

    // Run 1 completes: its result is delivered and run 2 is untouched.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: `first\n${DONE_MARKER}`,
    });
    expect(h.delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: `first\n\n${completedSuffix(h, "report", h.runId("report", 1))}`,
      },
    ]);

    // A late event from the ended run 1 is an orphan — it can never be
    // mistaken for run 2's result.
    await h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: h.runId("report", 1), text: "stale" });
    expect(h.delivered).toHaveLength(1);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("orphan"));

    // Run 2 still completes normally with its own result.
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 2),
      text: `second\n${DONE_MARKER}`,
    });
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `second\n\n${completedSuffix(h, "report", h.runId("report", 2))}`,
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
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: `ok\n${DONE_MARKER}`,
    });
    expect(h.delivered).toHaveLength(1);

    // ...so run 2's independent timer still fires: it aborts only run 2's
    // session and delivers the timeout notice for run 2.
    await waitFor(() => expect(h.delivered).toHaveLength(2));
    expect(
      h.dispatched.some((e) => e.type === "command.session.stop" && e.clientSessionId === h.runId("report", 2)),
    ).toBe(true);
    expect(
      h.dispatched.some((e) => e.type === "command.session.stop" && e.clientSessionId === h.runId("report", 1)),
    ).toBe(false);
    expect(h.delivered[1]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: timedOutSuffix(h, "report", h.runId("report", 2)),
    });
  });
});

describe("run history (run-history spec D2/D3/D5/D6)", () => {
  /** Reads the harness's history JSONL, one record per finished run. */
  async function history(h: Harness): Promise<RunHistoryRecord[]> {
    return readRunHistory("schedule", h.historyRoot);
  }

  it("writes one completed line at DONE with runId/ts/ms/channel/agent/file", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET, prompt: "summarize" }))] });
    await h.scheduler.start();
    const runId = h.runId("report", 1);

    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      h.dispatched.push(event);
      if (event.type === "command.session.new") {
        return { ok: true, agentSessionId: "pi-coding-agent:a8b7c75f-0000-0000-0000-1" };
      }
      return { ok: true } as const;
    });
    await h.scheduler.runNow("report");

    h.clock.advance(252_000);
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: runId,
      text: `done\n${DONE_MARKER}`,
    });

    const startedAt = 1_700_000_000_000; // fake clock's epoch
    expect(await history(h)).toEqual([
      {
        runId,
        ts: new Date(startedAt).toISOString(),
        ms: 252_000,
        outcome: "completed",
        channel: "test",
        agent: "pi-coding-agent:a8b7c75f-0000-0000-0000-1",
        file: runOutputPath(h.outputsDir, runId),
      },
    ]);
  });

  it("writes a failed line with the error detail as reason (fallback text when absent)", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");
    await h.scheduler.handleOutput({
      type: "error",
      clientSessionId: h.runId("report", 1),
      kind: "agent.run.failed",
      detail: "boom",
    });
    const [record] = await history(h);
    expect(record).toMatchObject({
      runId: h.runId("report", 1),
      outcome: "failed",
      reason: "boom",
      channel: "test",
    });
    expect("agent" in record!).toBe(false); // fake dispatch returns no agentSessionId

    // No detail on the event: a fallback reason is still recorded.
    const h2 = createHarness({ tasks: [makeLoaded(makeTask({ name: "quiet", target: TARGET }))] });
    await h2.scheduler.start();
    await h2.scheduler.runNow("quiet");
    await h2.scheduler.handleOutput({
      type: "error",
      clientSessionId: h2.runId("quiet", 1),
      kind: "agent.run.failed",
    });
    const [record2] = await history(h2);
    expect(record2).toMatchObject({ outcome: "failed", reason: "agent run failed" });
  });

  it("writes a timeout line with a `timed out after Xms` reason", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "slow", target: TARGET, timeoutMs: 100 }))],
    });
    await h.scheduler.start();
    await h.scheduler.runNow("slow");
    await waitFor(async () => expect(await history(h)).toHaveLength(1));
    const [record] = await history(h);
    expect(record).toMatchObject({
      runId: h.runId("slow", 1),
      outcome: "timeout",
      reason: "timed out after 100ms",
      channel: "test",
    });
    expect(typeof record!.ms).toBe("number");
    expect(record!.file).toBe(runOutputPath(h.outputsDir, h.runId("slow", 1)));
  });

  it("writes a fire-failed line with the dispatch failure reason", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      h.dispatched.push(event);
      if (event.type === "command.session.new") {
        return { ok: false, reason: "boom: model not available" };
      }
      return { ok: true } as const;
    });
    await h.scheduler.fire("report");

    expect(await history(h)).toHaveLength(1);
    const [record] = await history(h);
    expect(record).toMatchObject({
      runId: h.runId("report", 1),
      outcome: "fire-failed",
      reason: "boom: model not available",
      channel: "test",
    });
    expect("agent" in record!).toBe(false); // session.new failed: no agentSessionId
  });

  it("keeps the agent field on a fire-failed line when session.new succeeded but user.message failed", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      h.dispatched.push(event);
      if (event.type === "user.message") {
        return { ok: false, reason: "boom: prompt rejected" };
      }
      return { ok: true, agentSessionId: "pi-coding-agent:1111-2222" };
    });
    await h.scheduler.fire("report");
    const [record] = await history(h);
    expect(record).toMatchObject({
      outcome: "fire-failed",
      reason: "boom: prompt rejected",
      agent: "pi-coding-agent:1111-2222",
    });
  });

  it("a back-to-back DONE arriving during the error path's history write is an orphan: exactly one line, one delivery", async () => {
    // B1 regression: #handleError used to await #writeHistory BEFORE
    // #endRun, so while that await window was open the run was still in the
    // registry and a back-to-back DONE message walked the full completion
    // path — a second history line, a double delivery. The interleaving is
    // reproduced deterministically: the error handling blocks inside the
    // history append (gated), the DONE message arrives then, the gate opens.
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");
    const runId = h.runId("report", 1);

    // Gate the run-history append so the error path pauses mid-write: the
    // spy signals that it entered and waits for an explicit release, so the
    // DONE message below is guaranteed to arrive while write is pending.
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let historyEnteredResolve!: () => void;
    const historyEntered = new Promise<void>((resolve) => {
      historyEnteredResolve = resolve;
    });
    const originalAppend = historyModule.appendRunHistory;
    const historySpy = vi
      .spyOn(historyModule, "appendRunHistory")
      .mockImplementation(async (...args: Parameters<typeof originalAppend>) => {
        historyEnteredResolve();
        await historyGate;
        return originalAppend(...args);
      });

    // 1. The error event starts its run-end path and blocks in the history write.
    const errorPromise = h.scheduler.handleOutput({
      type: "error",
      clientSessionId: runId,
      kind: "agent.run.failed",
      detail: "boom",
    });
    await historyEntered;

    // 2. While that write is still pending, a back-to-back DONE message for
    //    the same run arrives: the run must already be gone from the registry,
    //    so this is an orphan — handled synchronously, no completion path, no
    //    second history append. (With the old ordering the DONE walked the
    //    full completion path and started a second append.)
    const donePromise = h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: runId,
      text: `late done\n${DONE_MARKER}`,
    });
    await sleep(50); // let the orphan path (or, if buggy, the completion path) run
    expect(historySpy).toHaveBeenCalledTimes(1);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("orphan"));

    // 3. Release the paused write and let both paths settle.
    releaseHistory();
    await errorPromise;
    await donePromise;
    historySpy.mockRestore();

    expect(await history(h)).toHaveLength(1);
    expect((await history(h))[0]).toMatchObject({ runId, outcome: "failed", reason: "boom" });
    // Exactly one delivery: the failure notice. The orphan DONE delivered nothing.
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toMatchObject({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: expect.stringContaining("boom"),
    });
    expect(h.delivered.filter((e) => (e as { text?: string }).text?.includes("late done"))).toEqual([]);
  });

  it("writes no line for pre-fire validation refusals and none for stop()-cleared runs", async () => {
    const h = createHarness({
      tasks: [
        makeLoaded(makeTask({ name: "disabled", target: TARGET, enabled: false })),
        makeLoaded(makeTask({ name: "empty", target: TARGET, prompt: "   " })),
        makeLoaded(makeTask({ name: "no-target" })),
        makeLoaded(makeTask({ name: "theirs", channel: "other", target: TARGET })),
        makeLoaded(
          makeTask({ name: "baddir", directory: `/definitely/not/real-${Date.now()}`, target: TARGET }),
        ),
      ],
    });
    await h.scheduler.start();
    await h.scheduler.fire("disabled");
    await h.scheduler.fire("empty");
    await h.scheduler.fire("no-target");
    await h.scheduler.fire("theirs");
    await h.scheduler.fire("baddir");
    await h.scheduler.fire("missing");
    expect(await history(h)).toEqual([]);

    // A stop()-cleared in-flight run writes nothing either (spec Non-Goals).
    const h2 = createHarness({ tasks: [makeLoaded(makeTask({ name: "live", target: TARGET }))] });
    await h2.scheduler.start();
    await h2.scheduler.runNow("live");
    await h2.scheduler.stop();
    expect(await history(h2)).toEqual([]);
  });

  it("writes exactly one line per run, not per message", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    await h.scheduler.runNow("report");
    await h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: h.runId("report", 1), text: "one" });
    await h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: h.runId("report", 1), text: "two" });
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: h.runId("report", 1),
      text: `three\n${DONE_MARKER}`,
    });
    const records = await history(h);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "completed", runId: h.runId("report", 1) });
  });

  it("records the trigger in the header: tick fires vs /schedule-run fires", async () => {
    const task = makeLoaded(
      makeTask({ name: "trig", target: TARGET, scheduleRaw: "every 30m", prompt: "the full task body\nsecond line" }),
    );
    const h = createHarness({ tasks: [task] });
    await h.scheduler.start();
    h.clock.advance(30 * 60_000); // due: the tick fires
    const tickRunId = h.runId("trig", 1); // id derived from the (advanced) clock
    await waitFor(() => expect(h.dispatched).toHaveLength(2));
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: tickRunId,
      text: DONE_MARKER,
    });

    await h.scheduler.runNow("trig"); // manual: run-now
    const runNowId = h.runId("trig", 2);
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: runNowId,
      text: DONE_MARKER,
    });

    const tickHeader = await readFile(runOutputPath(h.outputsDir, tickRunId), "utf8");
    expect(tickHeader).toContain("trigger: tick\n");
    const runNowHeader = await readFile(runOutputPath(h.outputsDir, runNowId), "utf8");
    expect(runNowHeader).toContain("trigger: run-now\n");
  });

  it("writes the header with front matter and the prompt's full text before any message", async () => {
    const h = createHarness({
      tasks: [
        makeLoaded(
          makeTask({
            name: "report",
            target: TARGET,
            scheduleRaw: "daily 09:00",
            directory: os.tmpdir(),
            prompt: "first line of the task body\n\nsecond paragraph",
          }),
        ),
      ],
    });
    await h.scheduler.start();
    const runId = h.runId("report", 1);
    await h.scheduler.runNow("report");
    await h.scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: runId,
      text: "assistant output",
    });

    const content = await readFile(runOutputPath(h.outputsDir, runId), "utf8");
    const expectedHeader = [
      "---",
      `runId: ${runId}`,
      "channel: test",
      `target: ${TARGET}`,
      "trigger: run-now",
      "schedule: daily 09:00",
      `directory: ${os.tmpdir()}`,
      `startedAt: ${new Date(1_700_000_000_000).toISOString()}`,
      "---",
      "# Prompt",
      "",
      "first line of the task body",
      "",
      "second paragraph",
      "",
      "---",
      "",
    ].join("\n");
    expect(content.startsWith(expectedHeader)).toBe(true);
    expect(content.endsWith("assistant output\n\n")).toBe(true);
  });

  it("omits optional header lines (agent/schedule/directory) when unknown or unset", async () => {
    const h = createHarness({
      tasks: [makeLoaded(makeTask({ name: "minimal", target: TARGET, scheduleRaw: undefined }))],
    });
    await h.scheduler.start();
    await h.scheduler.runNow("minimal");
    const content = await readFile(runOutputPath(h.outputsDir, h.runId("minimal", 1)), "utf8");
    expect(content).not.toContain("agent:"); // unknown until session.new, header written once
    // Check the front-matter lines specifically (runId itself contains "schedule:").
    const frontMatter = content.split("---")[1]!;
    expect(frontMatter).not.toMatch(/^schedule: /m);
    expect(frontMatter).not.toMatch(/^directory: /m);
    expect(frontMatter).not.toMatch(/^agent: /m);
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
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: h.runId("report", 1), text: "x" });
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
    // task-failed notice in the target chat).
    expect(await firePromise).toEqual({ ok: false, reason: "gateway is not running" });
    expect(h.delivered).toEqual([]);

    // S1 (asserting the existing behavior to pin module parity): no
    // fire-failed history line either — post-stop dispatch failures are not
    // task failures. The scheduler's #failFire re-gets the record, finds it
    // gone (stop cleared the registry) and skips the write; the queue
    // controller's #failFire mirrors this.
    expect(await readRunHistory("schedule", h.historyRoot)).toEqual([]);

    // The run was ended: its 50 ms timer never fires (no stop dispatch, no
    // timeout notice) and any late output is treated as an orphan.
    await sleep(200);
    expect(h.dispatched.filter((e) => e.type === "command.session.stop")).toEqual([]);
    expect(h.delivered).toEqual([]);
    h.scheduler.handleOutput({ type: "assistant.message", clientSessionId: h.runId("report", 1), text: "x" });
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
      outputsDir: path.join(tempRoot, "run-outputs"),
      // Same isolation as the harness above (run-history spec D2): keep the
      // JSONL index under the temp root so the test never appends to the
      // real ~/.config/agent-bridge/run-history/schedule.jsonl.
      historyRoot: path.join(tempRoot, "run-history"),
      logger,
    });
    schedulers.push(scheduler);

    await scheduler.start();
    clock.advance(30 * 60_000);
    const runId = syntheticSessionId("report", 1, clock.now());
    await waitFor(() => expect(dispatched).toHaveLength(2));
    expect(dispatched[0]).toMatchObject({
      type: "command.session.new",
      clientSessionId: runId,
      workingDirectory: await realpath(tempRoot),
      workingDirectorySource: "default",
    });
    expect(dispatched[1]).toMatchObject({
      type: "user.message",
      text: buildTaskPrompt("summarize the logs", ""),
    });

    await scheduler.handleOutput({
      type: "assistant.message",
      clientSessionId: runId,
      text: `done!\n${DONE_MARKER}`,
    });
    const reportOut = runOutputPath(path.join(tempRoot, "run-outputs"), runId);
    expect(delivered).toEqual([
      {
        type: "assistant.message",
        clientSessionId: TARGET,
        text: `done!\n\n*Scheduled task "report" completed · full output: ${reportOut}*`,
      },
    ]);
    // The accumulation file is still on disk after delivery.
    await expect(stat(reportOut)).resolves.toBeDefined();
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
      outputsDir: path.join(tempRoot, "run-outputs"),
      // Same isolation as the harness above (run-history spec D2): keep the
      // JSONL index under the temp root so the test never appends to the
      // real ~/.config/agent-bridge/run-history/schedule.jsonl.
      historyRoot: path.join(tempRoot, "run-history"),
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
      outputsDir: path.join(tempRoot, "run-outputs"),
      historyRoot: path.join(tempRoot, "run-history"),
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
      outputsDir: path.join(tempRoot, "run-outputs"),
      historyRoot: path.join(tempRoot, "run-history"),
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
      outputsDir: path.join(tempRoot, "run-outputs"),
      historyRoot: path.join(tempRoot, "run-history"),
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

describe("synthetic session ids (run-history spec D4)", () => {
  it("builds schedule:<task>:<yyyymmdd-hhmmss>-<seq> from the clock's LOCAL time", () => {
    // Local-time components, so the test is timezone-independent by
    // construction: build the date from local fields and assert those.
    const now = new Date(2026, 7, 9, 7, 5, 3); // Aug 9 2026 07:05:03 LOCAL
    expect(syntheticSessionId("daily-report", 3, now)).toBe(
      "schedule:daily-report:20260809-070503-3",
    );
  });

  it("pads every field, so single-digit components still form 8+6 digits", () => {
    const now = new Date(2027, 0, 1, 0, 0, 0); // Jan 1 2027 00:00:00 LOCAL
    expect(syntheticSessionId("t", 12, now)).toBe("schedule:t:20270101-000000-12");
  });

  it("parses a well-formed id back into task name and seq", () => {
    expect(parseSyntheticSessionId("schedule:daily-report:20260809-070503-3")).toEqual({
      taskName: "daily-report",
      runSeq: 3,
    });
    // A task name containing a colon still parses: the LAST colon bounds
    // the timestamped segment.
    expect(parseSyntheticSessionId("schedule:weird:name:20260809-070503-42")).toEqual({
      taskName: "weird:name",
      runSeq: 42,
    });
  });

  it("round-trips every id the scheduler can produce", () => {
    const now = new Date(2026, 11, 31, 23, 59, 59);
    for (const task of ["report", "a:b", "daily-report"]) {
      for (const seq of [1, 2, 999]) {
        const id = syntheticSessionId(task, seq, now);
        expect(parseSyntheticSessionId(id)).toEqual({ taskName: task, runSeq: seq });
      }
    }
  });

  it("rejects legacy and malformed ids", () => {
    // The legacy bare-seq format (pre run-history D4) is no longer valid.
    expect(parseSyntheticSessionId("schedule:report:1")).toBeNull();
    expect(parseSyntheticSessionId("schedule:report:20260809-0705-3")).toBeNull(); // 4-digit time
    expect(parseSyntheticSessionId("schedule:report:202689-070503-3")).toBeNull(); // 6-digit date
    expect(parseSyntheticSessionId("schedule:report:20260809-070503-0")).toBeNull(); // seq 0
    expect(parseSyntheticSessionId("schedule:report:20260809-070503-x")).toBeNull(); // non-numeric seq
    expect(parseSyntheticSessionId("schedule:20260809-070503-3")).toBeNull(); // no task name
    expect(parseSyntheticSessionId("queue:build:20260809-070503-3")).toBeNull(); // wrong prefix
    expect(parseSyntheticSessionId("report:20260809-070503-3")).toBeNull(); // no prefix
  });

  it("derives fire ids from the injected now(): ids differ across clock advances", async () => {
    const h = createHarness({ tasks: [makeLoaded(makeTask({ name: "report", target: TARGET }))] });
    await h.scheduler.start();
    const before = h.runId("report", 1);
    h.clock.advance(61_000); // next local-time second
    const clockAtFire = h.clock.now();
    expect(await h.scheduler.fire("report")).toEqual({ ok: true });
    const after = syntheticSessionId("report", 1, clockAtFire);
    expect(after).not.toBe(before);
    // The fired run (this scheduler's first) carried the clock-derived id.
    expect(h.dispatched.map((e) => e.clientSessionId)).toEqual([after, after]);
    // Both ids parse back to the task with their own seq.
    expect(parseSyntheticSessionId(before)?.runSeq).toBe(1);
    expect(parseSyntheticSessionId(after)?.runSeq).toBe(1);
    expect(parseSyntheticSessionId(after)?.taskName).toBe("report");
  });
});
