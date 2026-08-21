import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientInputEvent, ClientOutputEvent, OutboundAttachment } from "../../types";
import { getTranslator } from "../../i18n";
import type { Logger } from "../../core/logger";
import {
  bindQueue,
  insertQueueTask,
  listQueueTasks,
  setQueueTaskState,
} from "./queue-file";
import { buildProbeMessage, buildTaskPrompt, DONE_MARKER, sanitizeSessionId } from "../run-completion";
import { readRunHistory, type RunHistoryRecord } from "../run-completion/history";
import { QueueController } from "./controller";

const TARGET = "feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 2000): Promise<void> {
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

type MockLogger = {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

interface Harness {
  dispatched: ClientOutputEvent[];
  delivered: ClientInputEvent[];
  dispatchClientEvent: ReturnType<typeof vi.fn>;
  deliver: ReturnType<typeof vi.fn>;
  logger: MockLogger;
  root: string;
  controller: QueueController;
  /** Isolated run-history root for this harness's JSONL index (cleaned up with root). */
  historyRoot: string;
}

/** Absolute path a queue run's accumulation file lands at. */
function runOutputPath(h: Harness, sessionId: string): string {
  return path.join(h.root, "run-outputs", `${sanitizeSessionId(sessionId)}.md`);
}

/** Reads the harness's history JSONL, one record per finished run. */
function history(h: Harness): Promise<RunHistoryRecord[]> {
  return readRunHistory("queue", h.historyRoot);
}
function completedSuffix(h: Harness, queue: string, sessionId: string): string {
  return `*Queue "${queue}" task completed · full output: ${runOutputPath(h, sessionId)}*`;
}
function failedSuffix(h: Harness, queue: string, sessionId: string): string {
  return `*Queue "${queue}" task failed · full output: ${runOutputPath(h, sessionId)}*`;
}
function timedOutSuffix(h: Harness, queue: string, sessionId: string): string {
  return `*Queue "${queue}" task timed out · full output: ${runOutputPath(h, sessionId)}*`;
}

const controllers: QueueController[] = [];
const tempRoots: string[] = [];

async function createHarness(
  options: { root?: string; tickMs?: number; runTimeoutMs?: number } = {},
): Promise<Harness> {
  const root = options.root ?? (await mkdtemp(path.join(os.tmpdir(), "queue-ctl-")));
  if (options.root === undefined) tempRoots.push(root);
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
  const logger: MockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const historyRoot = path.join(root, "run-history");
  const controller = new QueueController({
    channelName: "test",
    tickMs: options.tickMs ?? 20,
    runTimeoutMs: options.runTimeoutMs ?? 5_000,
    queuesRoot: root,
    dispatchClientEvent,
    deliver,
    t: getTranslator("en-US"),
    // Isolated run-outputs dir under the temp root (cleaned up with it).
    outputsDir: path.join(root, "run-outputs"),
    historyRoot,
    logger,
  });
  controllers.push(controller);
  return { dispatched, delivered, dispatchClientEvent, deliver, logger, root, controller, historyRoot };
}

/**
 * Writes a queue definition (defaults: channel "test", workers 1, no model,
 * no target, no body) plus one task file per prompt, returning the task ids
 * in insertion (FIFO) order.
 */
async function seedQueue(
  root: string,
  name: string,
  options: { channel?: string; workers?: number; model?: string; target?: string; body?: string; silence?: string },
  prompts: string[],
): Promise<string[]> {
  // `queue add` no longer writes `channel` (T1): an owned queue must have a
  // `channel` line, so it is written directly here (default "test"). An
  // explicit `{ channel: undefined }` omits the line to model a channel-less
  // (unbound) queue.
  const channel = "channel" in options ? options.channel : "test";
  const frontMatter = [
    "---",
    ...(channel !== undefined ? [`channel: ${channel}`] : []),
    `workers: ${options.workers ?? 1}`,
    ...(options.model !== undefined ? [`model: ${options.model}`] : []),
    ...(options.silence !== undefined ? [`silence: ${options.silence}`] : []),
    ...(options.target !== undefined ? [`target: ${options.target}`] : []),
    "---",
    "",
  ];
  await writeFile(path.join(root, `${name}.md`), [...frontMatter, options.body ?? ""].join("\n"), "utf8");
  const ids: string[] = [];
  for (const prompt of prompts) {
    ids.push(await insertQueueTask(name, prompt, root));
  }
  return ids;
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    await controller.stop();
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("capacity and FIFO (D2)", () => {
  it("fires at most `workers` tasks per tick: capacity = workers - inFlight", async () => {
    const h = await createHarness();
    await seedQueue(h.root, "q", { workers: 2, target: TARGET }, ["a", "b", "c", "d"]);
    await h.controller.start();

    await waitFor(() => expect(h.dispatched).toHaveLength(4));
    expect(h.dispatched.filter((e) => e.type === "user.message").map((e) => e.text)).toEqual([
      buildTaskPrompt("", "a"),
      buildTaskPrompt("", "b"),
    ]);
    const tasks = await listQueueTasks("q", h.root);
    expect(tasks.filter((t) => t.state === "running")).toHaveLength(2);
    expect(tasks.filter((t) => t.state === "pending")).toHaveLength(2);

    // The two in-flight runs keep the capacity at zero: no further fires.
    await sleep(60);
    expect(h.dispatched).toHaveLength(4);
  });

  it("consumes tasks strictly in FIFO order", async () => {
    const h = await createHarness();
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a", "b", "c"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));
    expect(h.dispatched[1]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: buildTaskPrompt("", "a"),
    });

    h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: `ok1\n${DONE_MARKER}`,
    });
    await waitFor(() => expect(h.dispatched).toHaveLength(4));
    expect(h.dispatched[3]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${ids[1]}`,
      text: buildTaskPrompt("", "b"),
    });

    h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[1]}`,
      text: `ok2\n${DONE_MARKER}`,
    });
    await waitFor(() => expect(h.dispatched).toHaveLength(6));
    expect(h.dispatched[5]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${ids[2]}`,
      text: buildTaskPrompt("", "c"),
    });
  });
});

describe("fire (D2)", () => {
  it("dispatches the exact synthetic event sequence with the pinned model and composed prompt", async () => {
    const h = await createHarness();
    const [id] = await seedQueue(
      h.root,
      "q",
      { target: TARGET, model: "azure-openai-responses/gpt-5.6-terra", body: "Shared context." },
      ["task a"],
    );
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    expect(h.dispatched[0]).toEqual({
      type: "command.session.new",
      clientSessionId: `queue:q:${id}`,
      workingDirectory: process.cwd(),
      workingDirectorySource: "default",
      model: "azure-openai-responses/gpt-5.6-terra",
    });
    expect(h.dispatched[1]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${id}`,
      text: buildTaskPrompt("Shared context.", "task a"),
    });
  });

  it("leaves the model field absent and uses the bare prompt when the queue pins neither", async () => {
    const h = await createHarness();
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["task a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    expect("model" in h.dispatched[0]!).toBe(false);
    expect(h.dispatched[0]).toEqual({
      type: "command.session.new",
      clientSessionId: `queue:q:${id}`,
      workingDirectory: process.cwd(),
      workingDirectorySource: "default",
    });
    expect(h.dispatched[1]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${id}`,
      text: buildTaskPrompt("", "task a"),
    });
  });
});

describe("completion (D2)", () => {
  it("delivers the completed result, deletes the task file, and frees the slot", async () => {
    const h = await createHarness();
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a", "b"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: `result A\n${DONE_MARKER}`,
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `result A\n\n${completedSuffix(h, "q", `queue:q:${ids[0]}`)}`,
    });
    await waitFor(async () => {
      const tasks = await listQueueTasks("q", h.root);
      expect(tasks.some((t) => t.id === ids[0])).toBe(false);
    });
    // The accumulation file is still on disk after delivery.
    await expect(stat(runOutputPath(h, `queue:q:${ids[0]}`))).resolves.toBeDefined();

    // The run ended and the slot freed: the next tick fires task b.
    await waitFor(() => expect(h.dispatched).toHaveLength(4));
    expect(h.dispatched[3]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${ids[1]}`,
      text: buildTaskPrompt("", "b"),
    });

    // The run has ended: a second completion is an orphan and delivers nothing.
    h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: `again\n${DONE_MARKER}`,
    });
    expect(h.delivered).toHaveLength(1);
  });

  it("passes non-empty attachments through to the delivered completion and omits the field when there are none", async () => {
    const h = await createHarness();
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a", "b"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    // Completion with attachments: carried over verbatim into the delivered
    // `assistant.message` (same contract as the scheduler).
    const attachments = [
      { kind: "file" as const, filePath: "/tmp/queue-out.txt", fileName: "queue-out.txt" },
    ];
    h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: `result A\n${DONE_MARKER}`,
      attachments,
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `result A\n\n${completedSuffix(h, "q", `queue:q:${ids[0]}`)}`,
      attachments,
    });

    // The run ended and the slot freed: the next tick fires task b.
    await waitFor(() => expect(h.dispatched).toHaveLength(4));

    // Completion without attachments: the delivered event carries no
    // `attachments` field at all.
    h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[1]}`,
      text: `result B\n${DONE_MARKER}`,
    });
    await waitFor(() => expect(h.delivered).toHaveLength(2));
    expect(h.delivered[1]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `result B\n\n${completedSuffix(h, "q", `queue:q:${ids[1]}`)}`,
    });
    expect("attachments" in h.delivered[1]!).toBe(false);
  });
});

describe("fail-and-drop (D2, decided)", () => {
  it("fails the task when session.new dispatch reports { ok: false }: no user.message, notice + file deleted", async () => {
    const h = await createHarness();
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["a"]);
    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      h.dispatched.push(event);
      if (event.type === "command.session.new") {
        return { ok: false, reason: "boom: model not available" } as const;
      }
      return { ok: true } as const;
    });
    await h.controller.start();

    await waitFor(() => expect(h.delivered).toHaveLength(1));
    // Only session.new was dispatched — there is no path to auto-create a
    // model-less session.
    expect(h.dispatched).toHaveLength(1);
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `boom: model not available\n\n${failedSuffix(h, "q", `queue:q:${id}`)}`,
    });
    await waitFor(async () => expect(await listQueueTasks("q", h.root)).toHaveLength(0));

    // The run has ended: a late completion is an orphan.
    h.controller.handleOutput({ type: "assistant.message", clientSessionId: `queue:q:${id}`, text: "late" });
    expect(h.delivered).toHaveLength(1);
  });

  it("fails the task when user.message dispatch reports { ok: false } with the same handling", async () => {
    const h = await createHarness();
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["a"]);
    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      h.dispatched.push(event);
      if (event.type === "user.message") {
        return { ok: false, reason: "boom: prompt rejected" } as const;
      }
      return { ok: true } as const;
    });
    await h.controller.start();

    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.dispatched).toHaveLength(2);
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `boom: prompt rejected\n\n${failedSuffix(h, "q", `queue:q:${id}`)}`,
    });
    await waitFor(async () => expect(await listQueueTasks("q", h.root)).toHaveLength(0));
  });

  it("delivers a failure notice on a terminal error event and drops the task", async () => {
    const h = await createHarness();
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    h.controller.handleOutput({
      type: "error",
      clientSessionId: `queue:q:${id}`,
      kind: "agent.run.failed",
      detail: "boom",
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `boom\n\n${failedSuffix(h, "q", `queue:q:${id}`)}`,
    });
    await waitFor(async () => expect(await listQueueTasks("q", h.root)).toHaveLength(0));
    // The partial transcript is NOT inlined.
    expect(h.delivered[0]!.text).not.toContain("partial work");

    // The run has ended: a second error is an orphan.
    h.controller.handleOutput({ type: "error", clientSessionId: `queue:q:${id}`, kind: "agent.run.failed" });
    expect(h.delivered).toHaveLength(1);
  });

  it("times out a long-running task: abort dispatch, failure notice, task dropped", async () => {
    const h = await createHarness({ runTimeoutMs: 50 });
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.dispatched[2]).toEqual({ type: "command.session.stop", clientSessionId: `queue:q:${id}` });
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: timedOutSuffix(h, "q", `queue:q:${id}`),
    });
    await waitFor(async () => expect(await listQueueTasks("q", h.root)).toHaveLength(0));
  });
});

describe("unbound and foreign queues (D2)", () => {
  it("never consumes an unbound queue; the backlog drains once a target is set", async () => {
    const h = await createHarness();
    await seedQueue(h.root, "q", {}, ["a", "b"]);
    await h.controller.start();

    await sleep(60);
    expect(h.dispatched).toEqual([]);
    expect(h.delivered).toEqual([]);
    const tasks = await listQueueTasks("q", h.root);
    expect(tasks.every((t) => t.state === "pending")).toBe(true);

    // `/queue-here` binds a chat; the next tick picks up the target and the
    // backlog drains automatically.
    expect(await bindQueue("q", "test", TARGET, h.root)).toEqual({ ok: true });
    await waitFor(() => expect(h.dispatched).toHaveLength(2));
    expect(h.dispatched[1]).toEqual({
      type: "user.message",
      clientSessionId: expect.stringMatching(/^queue:q:/),
      text: buildTaskPrompt("", "a"),
    });
  });

  it("never touches queues owned by another channel, including their running tasks", async () => {
    const h = await createHarness();
    const [id] = await seedQueue(h.root, "q", { channel: "other", target: TARGET }, ["a"]);
    // Simulate a task left in flight at shutdown of the owning channel.
    await setQueueTaskState("q", id, "running", h.root);
    await h.controller.start();

    await sleep(60);
    expect(h.dispatched).toEqual([]);
    expect(h.delivered).toEqual([]);
    const tasks = await listQueueTasks("q", h.root);
    expect(tasks).toHaveLength(1);
    // Not consumed, and not reset to pending either: foreign queues are out
    // of scope for this controller (including the at-least-once restart).
    expect(tasks[0]!.state).toBe("running");
  });

  it("skips channel-less queues: owned by no controller, never consumed (T1)", async () => {
    const h = await createHarness();
    // `queue add` writes no channel; a channel-less queue (even with a target
    // set by a stale file) is skipped by the ownership check
    // (`definition.channel !== this.channel`).
    const [id] = await seedQueue(h.root, "q", { channel: undefined, target: TARGET }, ["a"]);
    // Leave a task in flight at shutdown to confirm the restart reset also
    // skips channel-less queues.
    await setQueueTaskState("q", id, "running", h.root);
    await h.controller.start();

    await sleep(60);
    expect(h.dispatched).toEqual([]);
    expect(h.delivered).toEqual([]);
    const tasks = await listQueueTasks("q", h.root);
    expect(tasks).toHaveLength(1);
    // Not consumed and not reset: the channel-less queue is out of scope for
    // every controller.
    expect(tasks[0]!.state).toBe("running");
  });
});

describe("restart and reload (D2)", () => {
  it("re-enqueues running tasks on restart (at-least-once) and re-fires them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "queue-ctl-restart-"));
    tempRoots.push(root);
    const [id] = await seedQueue(root, "q", { target: TARGET }, ["a"]);

    const h1 = await createHarness({ root });
    await h1.controller.start();
    await waitFor(() => expect(h1.dispatched).toHaveLength(2));
    expect((await listQueueTasks("q", root))[0]!.state).toBe("running");

    // Stop with the task still in flight: the task file stays `running`.
    await h1.controller.stop();
    expect((await listQueueTasks("q", root))[0]!.state).toBe("running");

    // The next controller resets it to pending on start and re-fires it.
    const h2 = await createHarness({ root });
    await h2.controller.start();
    await waitFor(() => expect(h2.dispatched).toHaveLength(2));
    expect(h2.dispatched[1]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${id}`,
      text: buildTaskPrompt("", "a"),
    });
  });

  it("picks up definition edits on the next tick (workers 1 → 2 takes effect)", async () => {
    const h = await createHarness();
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a", "b", "c"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));
    expect(h.dispatched[1]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: buildTaskPrompt("", "a"),
    });
    expect((await listQueueTasks("q", h.root)).filter((t) => t.state === "running")).toHaveLength(1);

    // Edit the definition file: workers 1 → 2. The next tick reloads it.
    await writeFile(
      path.join(h.root, "q.md"),
      `---\nchannel: test\nworkers: 2\ntarget: ${TARGET}\n---\n\n`,
      "utf8",
    );
    await waitFor(() => expect(h.dispatched).toHaveLength(4));
    expect(h.dispatched[3]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${ids[1]}`,
      text: buildTaskPrompt("", "b"),
    });
    expect((await listQueueTasks("q", h.root)).filter((t) => t.state === "running")).toHaveLength(2);
  });
});

describe("stop() races (SF-2)", () => {
  it("delivers nothing when a post-stop dispatch resolves { ok: false } with the gateway reason", async () => {
    const h = await createHarness({ runTimeoutMs: 50 });
    await seedQueue(h.root, "q", { target: TARGET }, ["a"]);

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
      h.dispatched.push(event);
      if (event.type === "command.session.new") {
        enteredDispatch();
        await dispatchGate;
      }
      return { ok: false, reason: "gateway is not running" } as const;
    });

    const startPromise = h.controller.start(); // the initial tick blocks in session.new
    await dispatchEntered; // run registered, session.new in flight
    await h.controller.stop();
    releaseDispatch();
    await startPromise;

    // No delivery: a post-stop dispatch failure is not a task failure (no
    // spurious task-failed notice in the target chat).
    expect(h.delivered).toEqual([]);

    // S1 regression: no run-history line either — the task file stays
    // `running` for the at-least-once re-run at the next start, which writes
    // its own line. Consistent with the scheduler's same-scenario behavior.
    expect(await history(h)).toEqual([]);

    // The task file stays `running` (not deleted — the gateway-down race is
    // not a failure): the next start re-enqueues it (at-least-once).
    const tasks = await listQueueTasks("q", h.root);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.state).toBe("running");

    // The run's 50 ms timer was cleared by stop(): no stop dispatch, no
    // timeout notice.
    await sleep(200);
    expect(h.dispatched.filter((e) => e.type === "command.session.stop")).toEqual([]);
    expect(h.delivered).toEqual([]);
  });

  it("writes no fire-failed history line when stop lands during #registerRun's header write and the dispatch fails", async () => {
    // S1 regression, second entry: stop() can also land while #registerRun
    // is awaiting its header write. #fire then holds a LOCAL record that is
    // no longer in the run registry (stop cleared it) and still dispatches;
    // the post-stop dispatch resolves { ok: false, reason: "gateway is not
    // running" }. #failFire must skip the history line for that run too.
    const h = await createHarness({ runTimeoutMs: 50 });
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["a"]);

    // Gate the accumulator's header write so #registerRun blocks mid-await.
    let releaseHeader!: () => void;
    const headerGate = new Promise<void>((resolve) => {
      releaseHeader = resolve;
    });
    let headerEnteredResolve!: () => void;
    const headerEntered = new Promise<void>((resolve) => {
      headerEnteredResolve = resolve;
    });
    const { createRunAccumulator } = await import("../run-completion");
    const accumulatorSpy = vi
      .spyOn(await import("../run-completion"), "createRunAccumulator")
      .mockImplementation((...args: Parameters<typeof createRunAccumulator>) => {
        const accumulator = createRunAccumulator(...args);
        const originalWriteHeader = accumulator.writeHeader.bind(accumulator);
        return Object.create(accumulator, {
          writeHeader: {
            value: async (...headerArgs: Parameters<typeof accumulator.writeHeader>) => {
              headerEnteredResolve();
              await headerGate;
              return originalWriteHeader(...headerArgs);
            },
          },
        });
      });

    // The (post-stop) dispatch resolves the gateway-down reason.
    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      h.dispatched.push(event);
      return { ok: false, reason: "gateway is not running" } as const;
    });

    const startPromise = h.controller.start(); // the initial tick blocks in the header write
    await headerEntered; // run registered, header write in flight
    await h.controller.stop(); // clears the registry while the write is pending
    releaseHeader();
    await startPromise;
    accumulatorSpy.mockRestore();

    // The dispatch was attempted (with the stale local record) and failed —
    // but that post-stop failure writes no history line, deletes nothing
    // and delivers nothing: the task file stays `running` for the next start.
    expect(h.dispatched).toHaveLength(1);
    expect(h.delivered).toEqual([]);
    expect(await history(h)).toEqual([]);
    const tasks = await listQueueTasks("q", h.root);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.state).toBe("running");
  });
});

describe("handleOutput routing (D3)", () => {
  it("discards intermediate events and keeps the run alive", async () => {
    const h = await createHarness();
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    h.controller.handleOutput({ type: "assistant.thinking", clientSessionId: `queue:q:${id}`, text: "thinking..." });
    h.controller.handleOutput({
      type: "agent.status.info",
      clientSessionId: `queue:q:${id}`,
      status: { sessionId: "s1" },
    });
    expect(h.delivered).toEqual([]);

    h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${id}`,
      text: `final\n${DONE_MARKER}`,
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `final\n\n${completedSuffix(h, "q", `queue:q:${id}`)}`,
    });
  });

  it("drops orphan output for queue sessions with no active run", async () => {
    const h = await createHarness();
    h.controller.handleOutput({ type: "assistant.message", clientSessionId: "queue:q:1-2ab3", text: "x" });
    expect(h.delivered).toEqual([]);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("orphan"));
  });
});

describe("stale-fire guard (stop → start fast re-run of the same taskId)", () => {
  it("a stale fire's #failFire writes no history and never ends the NEW run registered under the same id", async () => {
    // Queue run ids are `queue:<queue>:<taskId>` and restart-stable, so a
    // stop() → start() of the SAME controller can re-fire the SAME taskId
    // and register a NEW record under the SAME id (a fresh record object).
    // When the STALE fire's dispatch then resolves a failure, #failFire's
    // identity check must reject it: no history line, no #endRun of the new
    // run, no task delete, no delivery. With the old `registered !==
    // undefined` guard the id-keyed #endRun would take the NEW run down and
    // the stale fire would write a phantom fire-failed line (the controller
    // is started again by then, so the #started guard does not save it).
    const h = await createHarness();
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["a"]);
    const sessionId = `queue:q:${id}`;

    // Gate each session.new so the fires can be ordered precisely: the
    // stale (first) fire stays in flight across stop()/start(), and the new
    // fire stays in flight until the stale failure has been handled.
    let releaseStaleFire!: () => void;
    const staleFireGate = new Promise<void>((resolve) => {
      releaseStaleFire = resolve;
    });
    let staleFireEntered!: () => void;
    const staleFireEnteredPromise = new Promise<void>((resolve) => {
      staleFireEntered = resolve;
    });
    let releaseNewFire!: () => void;
    const newFireGate = new Promise<void>((resolve) => {
      releaseNewFire = resolve;
    });
    let newFireEntered!: () => void;
    const newFireEnteredPromise = new Promise<void>((resolve) => {
      newFireEntered = resolve;
    });
    let stale = true;
    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      h.dispatched.push(event);
      if (event.type === "command.session.new") {
        if (stale) {
          stale = false;
          staleFireEntered();
          await staleFireGate;
          return { ok: false, reason: "boom: stale fire" } as const;
        }
        newFireEntered();
        await newFireGate;
      }
      return { ok: true } as const;
    });

    const startPromise1 = h.controller.start(); // the initial tick blocks in session.new
    await staleFireEnteredPromise; // run 1 registered, its dispatch in flight
    await h.controller.stop(); // clears the registry (run 1 forgotten, #started=false)

    // Start the SAME controller again: the `running` task is reset to
    // pending and re-fired — a NEW record lands under the SAME sessionId.
    const startPromise2 = h.controller.start();
    await newFireEnteredPromise; // NEW run registered under the same id

    // Release the STALE fire's dispatch: its failure resolution reaches
    // #failFire while the NEW run is registered under the same id.
    releaseStaleFire();
    await startPromise1;

    // The identity check rejected the stale fire: no history line...
    expect(await history(h)).toEqual([]);
    // ...nothing delivered to the target chat...
    expect(h.delivered).toEqual([]);
    // ...and the task file was NOT deleted by the stale fire's fail-and-drop.
    const tasks = await listQueueTasks("q", h.root);
    expect(tasks).toHaveLength(1);

    // The NEW run survived the stale failure: let its session.new resolve,
    // wait for its user.message dispatch, then DONE the run — the normal
    // completion path must deliver and write exactly one `completed` line
    // (with the old guard the run would be an orphan: no delivery).
    releaseNewFire();
    await startPromise2;
    await waitFor(() =>
      expect(h.dispatched.filter((e) => e.type === "user.message")).toHaveLength(1),
    );
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: sessionId,
      text: `fresh result\n${DONE_MARKER}`,
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `fresh result\n\n${completedSuffix(h, "q", sessionId)}`,
    });
    expect(await history(h)).toHaveLength(1);
    expect((await history(h))[0]).toMatchObject({ runId: sessionId, outcome: "completed" });
  });
});


describe("three-layer completion (T4)", () => {
  it("accumulates assistant messages and delivers them once only on DONE, marker stripped", async () => {
    const h = await createHarness();
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    // First message (no marker): accumulated, run NOT ended, nothing delivered.
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: "step one",
    });
    expect(h.delivered).toEqual([]);

    // Second message (no marker): still nothing delivered.
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: "step two",
    });
    expect(h.delivered).toEqual([]);

    // DONE: a single delivery carrying ONLY the last message, marker stripped
    // (the earlier steps live in the kept accumulation file), and the task
    // file deleted.
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: `step three\n${DONE_MARKER}`,
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `step three\n\n${completedSuffix(h, "q", `queue:q:${ids[0]}`)}`,
    });
    expect(h.delivered[0]!.text).not.toContain(DONE_MARKER);
    expect(h.delivered[0]!.text).not.toContain("step one");
    await waitFor(async () => {
      const tasks = await listQueueTasks("q", h.root);
      expect(tasks.some((t) => t.id === ids[0])).toBe(false);
    });

    // The run ended: a second completion is an orphan.
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: `again\n${DONE_MARKER}`,
    });
    expect(h.delivered).toHaveLength(1);
  });

  it("holds the slot until DONE: with workers=1 the second task must not fire after the first message", async () => {
    const h = await createHarness();
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a", "b"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    // First assistant message WITHOUT the DONE marker: accumulated, the run
    // stays alive and the worker slot is still held.
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: "working...",
    });
    // Several ticks pass: task b must NOT fire (the slot is held until DONE).
    await sleep(80);
    expect(h.dispatched).toHaveLength(2);
    expect(h.delivered).toEqual([]);

    // DONE frees the slot: the next tick fires task b.
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: `done\n${DONE_MARKER}`,
    });
    await waitFor(() => expect(h.dispatched).toHaveLength(4));
    expect(h.dispatched[3]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${ids[1]}`,
      text: buildTaskPrompt("", "b"),
    });
  });

  it("merges attachments from every accumulated message onto the final delivery", async () => {
    const h = await createHarness();
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    const a1: OutboundAttachment[] = [{ kind: "file", filePath: "/tmp/a.txt", fileName: "a.txt" }];
    const a2: OutboundAttachment[] = [{ kind: "file", filePath: "/tmp/b.txt", fileName: "b.txt" }];
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: "first",
      attachments: a1,
    });
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: `second\n${DONE_MARKER}`,
      attachments: a2,
    });
    // Only the last message is delivered as text; attachments from BOTH
    // messages still travel with it.
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `second\n\n${completedSuffix(h, "q", `queue:q:${ids[0]}`)}`,
      attachments: [...a1, ...a2],
    });
  });

  it("a bare message without DONE does not end the run; a DONE-only message delivers empty output", async () => {
    const h = await createHarness();
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    // Whitespace-only, no marker: accumulated but the run stays alive.
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: "   ",
    });
    expect(h.delivered).toEqual([]);

    // DONE-only: empty last message → the completed suffix alone (with the
    // kept file reference) instead of silence.
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: DONE_MARKER,
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: completedSuffix(h, "q", `queue:q:${ids[0]}`),
    });
  });

  it("carries attachments from earlier messages on a DONE-only (empty last message) delivery", async () => {
    const h = await createHarness();
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    // Early message with an attachment (accumulated; no delivery yet).
    const a1: OutboundAttachment[] = [{ kind: "file", filePath: "/tmp/a.txt", fileName: "a.txt" }];
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: "first",
      attachments: a1,
    });
    expect(h.delivered).toEqual([]);

    // DONE-only: empty last message → the completed suffix is the text, but
    // the attachment collected earlier still travels with the delivery.
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: DONE_MARKER,
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: completedSuffix(h, "q", `queue:q:${ids[0]}`),
      attachments: a1,
    });
  });
});

describe("failure/timeout ordering (T2: reason only, no inlined transcript)", () => {
  it("delivers a failure notice with accumulated partial content on a terminal error", async () => {
    const h = await createHarness();
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: "partial work",
    });
    expect(h.delivered).toEqual([]);

    await h.controller.handleOutput({
      type: "error",
      clientSessionId: `queue:q:${ids[0]}`,
      kind: "agent.run.failed",
      detail: "boom",
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `boom\n\n${failedSuffix(h, "q", `queue:q:${ids[0]}`)}`,
    });
    // The partial transcript is NOT inlined.
    expect(h.delivered[0]!.text).not.toContain("partial work");
    await waitFor(async () => expect(await listQueueTasks("q", h.root)).toHaveLength(0));
  });

  it("times out with accumulated partial content delivered alongside the timeout notice", async () => {
    const h = await createHarness({ runTimeoutMs: 80 });
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: "partial work",
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: timedOutSuffix(h, "q", `queue:q:${ids[0]}`),
    });
    // The partial transcript is NOT inlined.
    expect(h.delivered[0]!.text).not.toContain("partial work");
    await waitFor(async () => expect(await listQueueTasks("q", h.root)).toHaveLength(0));
  });
});

describe("silence probe (T4, layer 2)", () => {
  it("dispatches a probing user.message into the run session after silence", async () => {
    const h = await createHarness();
    const ids = await seedQueue(
      h.root,
      "q",
      { workers: 1, target: TARGET, silence: "1s" },
      ["a"],
    );
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    // After ~1 s of silence the probe dispatches a probing user.message
    // (silentMinutes=1 for a sub-minute window).
    await waitFor(() =>
      expect(
        h.dispatched.some((e) => e.type === "user.message" && e.text === buildProbeMessage(1)),
      ).toBe(true),
    );
  });

  it("accumulates the probe answer, keeps the run alive, and delivers once on a later DONE", async () => {
    const h = await createHarness();
    const ids = await seedQueue(
      h.root,
      "q",
      { workers: 1, target: TARGET, silence: "1s" },
      ["a"],
    );
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    const probeCount = () =>
      h.dispatched.filter(
        (e) => e.type === "user.message" && e.text.startsWith("You have been silent"),
      ).length;
    await waitFor(() => expect(probeCount()).toBe(1));

    // Probe answer WITHOUT DONE: accumulated, run continues, no delivery.
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: "still working",
    });
    expect(h.delivered).toEqual([]);

    // DONE after the probe: delivered exactly once — the LAST message only.
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: `done now\n${DONE_MARKER}`,
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `done now\n\n${completedSuffix(h, "q", `queue:q:${ids[0]}`)}`,
    });
  });
});

describe("run history (run-history spec D2/D3/D5/D6)", () => {
  it("writes one completed line at DONE with runId/ts/ms/channel/agent/file", async () => {
    const h = await createHarness();
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["a"]);
    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      h.dispatched.push(event);
      if (event.type === "command.session.new") {
        return { ok: true, agentSessionId: "pi-coding-agent:3333-4444" };
      }
      return { ok: true } as const;
    });
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${id}`,
      text: `done\n${DONE_MARKER}`,
    });
    await waitFor(async () => expect(await history(h)).toHaveLength(1));

    const [record] = await history(h);
    expect(record!.runId).toBe(`queue:q:${id}`);
    expect(record!.outcome).toBe("completed");
    expect("reason" in record!).toBe(false);
    expect(record!.channel).toBe("test");
    expect(record!.agent).toBe("pi-coding-agent:3333-4444");
    expect(record!.file).toBe(runOutputPath(h, `queue:q:${id}`));
    expect(typeof record!.ts).toBe("string");
    expect(typeof record!.ms).toBe("number");
  });

  it("writes a failed line with the error detail as reason", async () => {
    const h = await createHarness();
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    h.controller.handleOutput({
      type: "error",
      clientSessionId: `queue:q:${id}`,
      kind: "agent.run.failed",
      detail: "boom",
    });
    await waitFor(async () => expect(await history(h)).toHaveLength(1));
    expect((await history(h))[0]).toMatchObject({
      runId: `queue:q:${id}`,
      outcome: "failed",
      reason: "boom",
      channel: "test",
    });
  });

  it("writes a timeout line with a `timed out after Xms` reason", async () => {
    const h = await createHarness({ runTimeoutMs: 50 });
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    await waitFor(async () => expect(await history(h)).toHaveLength(1));
    expect((await history(h))[0]).toMatchObject({
      runId: `queue:q:${id}`,
      outcome: "timeout",
      reason: "timed out after 50ms",
      channel: "test",
    });
  });

  it("writes a fire-failed line with the dispatch failure reason; agent present when session.new succeeded", async () => {
    const h = await createHarness();
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["a"]);
    // session.new succeeds (returning an agentSessionId), user.message fails.
    h.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      h.dispatched.push(event);
      if (event.type === "user.message") {
        return { ok: false, reason: "boom: prompt rejected" };
      }
      return { ok: true, agentSessionId: "pi-coding-agent:5555-6666" };
    });
    await h.controller.start();

    await waitFor(async () => expect(await history(h)).toHaveLength(1));
    expect((await history(h))[0]).toMatchObject({
      runId: `queue:q:${id}`,
      outcome: "fire-failed",
      reason: "boom: prompt rejected",
      agent: "pi-coding-agent:5555-6666",
    });

    // session.new itself fails: no agent field on the line.
    const h2 = await createHarness();
    const [id2] = await seedQueue(h2.root, "q", { target: TARGET }, ["a"]);
    h2.dispatchClientEvent.mockImplementation(async (event: ClientOutputEvent) => {
      h2.dispatched.push(event);
      if (event.type === "command.session.new") {
        return { ok: false, reason: "boom: model not available" };
      }
      return { ok: true } as const;
    });
    await h2.controller.start();
    await waitFor(async () => expect(await history(h2)).toHaveLength(1));
    const [record2] = await history(h2);
    expect(record2).toMatchObject({
      runId: `queue:q:${id2}`,
      outcome: "fire-failed",
      reason: "boom: model not available",
    });
    expect("agent" in record2!).toBe(false);
  });

  it("writes nothing for skipped queues (unbound/foreign) and stop()-cleared runs", async () => {
    const h = await createHarness();
    // Unbound (no target) and foreign (other channel) queues are never fired.
    await seedQueue(h.root, "unbound", {}, ["a"]);
    await seedQueue(h.root, "foreign", { channel: "other", target: TARGET }, ["a"]);
    await h.controller.start();
    await sleep(80);
    expect(await history(h)).toEqual([]);

    // A stop()-cleared in-flight run writes nothing either (spec Non-Goals).
    const h2 = await createHarness();
    const [id] = await seedQueue(h2.root, "q", { target: TARGET }, ["a"]);
    await h2.controller.start();
    await waitFor(() => expect(h2.dispatched).toHaveLength(2));
    await h2.controller.stop();
    expect(await history(h2)).toEqual([]);
    expect(id).toBeDefined();
  });

  it("writes the header with the RAW prompt (queue body + task prompt) and no protocol block", async () => {
    const h = await createHarness();
    const [id] = await seedQueue(
      h.root,
      "q",
      { target: TARGET, body: "Shared context.\nSecond line." },
      ["task prompt body"],
    );
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${id}`,
      text: "assistant output",
    });

    const content = await readFile(runOutputPath(h, `queue:q:${id}`), "utf8");
    const lines = content.split("\n");
    // Front matter: runId/channel/target/queue/taskId/startedAt, then the prompt.
    expect(lines.slice(0, 7)).toEqual([
      "---",
      `runId: queue:q:${id}`,
      "channel: test",
      `target: ${TARGET}`,
      "queue: q",
      `taskId: ${id}`,
      `startedAt: ${new Date(lines[6]!.slice(11)).toISOString()}`,
    ]);
    // The RAW prompt (body + task prompt), NOT buildTaskPrompt's wrapping.
    expect(content).toContain("# Prompt\n\nShared context.\nSecond line.\n\ntask prompt body\n\n---\n");
    expect(content).not.toContain(DONE_MARKER);
    expect(content).not.toContain("Task completion protocol");
    expect(content.endsWith("assistant output\n\n")).toBe(true);
  });

  it("header with an empty queue body holds the bare task prompt", async () => {
    const h = await createHarness();
    const [id] = await seedQueue(h.root, "q", { target: TARGET }, ["just the task"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));
    const content = await readFile(runOutputPath(h, `queue:q:${id}`), "utf8");
    expect(content).toContain("# Prompt\n\njust the task\n\n---\n\n");
  });
});

describe("stop() mid-run (T4)", () => {
  it("stop mid-run keeps the accumulation file and delivers nothing (T2)", async () => {
    const h = await createHarness();
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: "partial work",
    });
    await h.controller.stop();
    expect(h.delivered).toEqual([]);

    // A late completion after stop is an orphan: nothing delivered.
    await h.controller.handleOutput({
      type: "assistant.message",
      clientSessionId: `queue:q:${ids[0]}`,
      text: `x\n${DONE_MARKER}`,
    });
    expect(h.delivered).toEqual([]);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("orphan"));

    // The task file stays `running` (restart re-enqueues it unchanged).
    const tasks = await listQueueTasks("q", h.root);
    expect(tasks.some((t) => t.id === ids[0] && t.state === "running")).toBe(true);
  });
});
