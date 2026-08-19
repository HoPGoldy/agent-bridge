import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientInputEvent, ClientOutputEvent } from "../../types";
import { getTranslator } from "../../i18n";
import type { Logger } from "../../core/logger";
import {
  insertQueueTask,
  listQueueTasks,
  setQueueTarget,
  setQueueTaskState,
  writeQueueDefinition,
} from "./queue-file";
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
  const controller = new QueueController({
    channelName: "test",
    tickMs: options.tickMs ?? 20,
    runTimeoutMs: options.runTimeoutMs ?? 5_000,
    queuesRoot: root,
    dispatchClientEvent,
    deliver,
    t: getTranslator("en-US"),
    logger,
  });
  controllers.push(controller);
  return { dispatched, delivered, dispatchClientEvent, deliver, logger, root, controller };
}

/**
 * Writes a queue definition (defaults: channel "test", workers 1, no model,
 * no target, no body) plus one task file per prompt, returning the task ids
 * in insertion (FIFO) order.
 */
async function seedQueue(
  root: string,
  name: string,
  options: { channel?: string; workers?: number; model?: string; target?: string; body?: string },
  prompts: string[],
): Promise<string[]> {
  await writeQueueDefinition(
    {
      name,
      channel: options.channel ?? "test",
      workers: options.workers,
      model: options.model,
      body: options.body,
    },
    root,
  );
  if (options.target !== undefined) {
    const result = await setQueueTarget(name, options.target, root);
    if (!result.ok) throw new Error(result.reason);
  }
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
      "a",
      "b",
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
      text: "a",
    });

    h.controller.handleOutput({ type: "assistant.message", clientSessionId: `queue:q:${ids[0]}`, text: "ok1" });
    await waitFor(() => expect(h.dispatched).toHaveLength(4));
    expect(h.dispatched[3]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${ids[1]}`,
      text: "b",
    });

    h.controller.handleOutput({ type: "assistant.message", clientSessionId: `queue:q:${ids[1]}`, text: "ok2" });
    await waitFor(() => expect(h.dispatched).toHaveLength(6));
    expect(h.dispatched[5]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${ids[2]}`,
      text: "c",
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
      text: "Shared context.\n\ntask a",
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
      text: "task a",
    });
  });
});

describe("completion (D2)", () => {
  it("delivers the completed result, deletes the task file, and frees the slot", async () => {
    const h = await createHarness();
    const ids = await seedQueue(h.root, "q", { workers: 1, target: TARGET }, ["a", "b"]);
    await h.controller.start();
    await waitFor(() => expect(h.dispatched).toHaveLength(2));

    h.controller.handleOutput({ type: "assistant.message", clientSessionId: `queue:q:${ids[0]}`, text: "result A" });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `✅ Queue "q" · task ${ids[0]} completed:\nresult A`,
    });
    await waitFor(async () => {
      const tasks = await listQueueTasks("q", h.root);
      expect(tasks.some((t) => t.id === ids[0])).toBe(false);
    });

    // The run ended and the slot freed: the next tick fires task b.
    await waitFor(() => expect(h.dispatched).toHaveLength(4));
    expect(h.dispatched[3]).toEqual({
      type: "user.message",
      clientSessionId: `queue:q:${ids[1]}`,
      text: "b",
    });

    // The run has ended: a second completion is an orphan and delivers nothing.
    h.controller.handleOutput({ type: "assistant.message", clientSessionId: `queue:q:${ids[0]}`, text: "again" });
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
      text: "result A",
      attachments,
    });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `✅ Queue "q" · task ${ids[0]} completed:\nresult A`,
      attachments,
    });

    // The run ended and the slot freed: the next tick fires task b.
    await waitFor(() => expect(h.dispatched).toHaveLength(4));

    // Completion without attachments: the delivered event carries no
    // `attachments` field at all.
    h.controller.handleOutput({ type: "assistant.message", clientSessionId: `queue:q:${ids[1]}`, text: "result B" });
    await waitFor(() => expect(h.delivered).toHaveLength(2));
    expect(h.delivered[1]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `✅ Queue "q" · task ${ids[1]} completed:\nresult B`,
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
      text: `❌ Queue "q" · task ${id} failed: boom: model not available`,
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
      text: `❌ Queue "q" · task ${id} failed: boom: prompt rejected`,
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
      text: `❌ Queue "q" · task ${id} failed: boom`,
    });
    await waitFor(async () => expect(await listQueueTasks("q", h.root)).toHaveLength(0));

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
      text: `⏰ Queue "q" · task ${id} timed out.`,
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
    expect(await setQueueTarget("q", TARGET, h.root)).toEqual({ ok: true });
    await waitFor(() => expect(h.dispatched).toHaveLength(2));
    expect(h.dispatched[1]).toEqual({
      type: "user.message",
      clientSessionId: expect.stringMatching(/^queue:q:/),
      text: "a",
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
      text: "a",
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
      text: "a",
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
      text: "b",
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
    // spurious `taskFailed` notice in the target chat).
    expect(h.delivered).toEqual([]);

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

    h.controller.handleOutput({ type: "assistant.message", clientSessionId: `queue:q:${id}`, text: "final" });
    await waitFor(() => expect(h.delivered).toHaveLength(1));
    expect(h.delivered[0]).toEqual({
      type: "assistant.message",
      clientSessionId: TARGET,
      text: `✅ Queue "q" · task ${id} completed:\nfinal`,
    });
  });

  it("drops orphan output for queue sessions with no active run", async () => {
    const h = await createHarness();
    h.controller.handleOutput({ type: "assistant.message", clientSessionId: "queue:q:1-2ab3", text: "x" });
    expect(h.delivered).toEqual([]);
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining("orphan"));
  });
});
