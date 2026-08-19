# Event Queue (Agent Task Queue) — design spec

Status: implemented (T1–T5, branch `feat/event-queue`). Grill decisions:
`docs/grill-context/qa-log.md` (2026-08-19 section). The user-facing
documentation is `docs/event-queue.md`; implementation drift found during the
docs pass (T6) is reflected inline below.

## Overview

A task queue that runs agent prompts through the existing agent pipeline.
A queue has a name, a worker count (max concurrency) and a worker model.
Tasks (currently: just a `prompt`) are inserted via the CLI, persisted as
files, and consumed FIFO by a per-channel controller. Results and failures
are delivered to the chat bound with `/queue-here`.

Architecture deliberately mirrors scheduled tasks (`scheduled-tasks-spec.md`):
a file-based definition, a per-channel controller with a tick loop, synthetic
`session.new` + `user.message` injection through the core ingress, output
divert back to the controller, and fail-fast failure delivery. The per-task
model override plumbing (`scheduled-task-model-spec.md`) is reused wholesale:
the queue's `model` is simply the session-creation override.

## D1 — Storage

All state lives under `~/.config/agent-bridge/queues/`.

**Queue definition** — `queues/<name>.md`:

```markdown
---
channel: feishu-dev        # owning channel; written by `queue add`
workers: 2                 # max concurrent tasks; integer >= 1, default 1
silence: 10m               # optional; silence window before a probe (same syntax as timeout, default 10m)
model: provider/model-id   # optional; blank/absent = channel default model
target: chat:xxx           # delivery address; written by /queue-here
---

Shared context appended to every task prompt of this queue.
```

**Task** — `queues/<name>.tasks/<taskId>.md` (one file per task):

```markdown
---
state: pending             # pending | running
enqueuedAt: 2026-08-19T08:00:00.000Z
---

The task prompt.
```

`taskId` = `<enqueueMs>-<random4>`; lexicographic filename order is the FIFO
order. Tasks are plain files: external programs can enqueue by writing a file;
management (clear, reorder, remove) is done by editing files with AI.

## D2 — Queue controller (per channel)

`src/modules/queue/`, started by `channel-runner` next to the scheduler. The
controller only manages queues whose `channel` equals its channel name (same
ownership rule as the scheduler).

- **Start**: scan owned task directories; every `state: running` task is
  reset to `pending` (at-least-once: a task in flight at shutdown is
  re-executed; no notice is sent for the interruption).
- **Tick** (30s default): reload queue definitions; for each queue with a
  non-empty `target`: capacity = `workers - inFlight(queue)`; take the oldest
  `pending` tasks up to capacity, mark them `running`, and fire each.
- **Unbound queue** (empty `target`): never consumed; tasks pile up until
  `/queue-here` binds a chat, then the backlog drains automatically.
- **Fire**: register a run under the synthetic client session id
  `queue:<queueName>:<taskId>`; `dispatchClientEvent` a `session.new`
  (carrying `model` when the queue pins one), check the `IngressResult`;
  on `ok` dispatch `user.message` with `<queue body>\n\n<task prompt>\n\n<completion-protocol block>` (the body is empty when blank; the fixed protocol block is the T4 DONE-marker instruction).
  A run carries a timeout timer (same 10-minute default as scheduled tasks)
  and a silence probe (`silence` front matter, default 10m).
- **Completion (three-layer protocol, T4)**: the old "first
  `assistant.message` ends the run" semantics is gone. Every `assistant.message`
  is accumulated into a per-run file under `run-outputs/`; a run completes only
  when the agent appends `BRIDGE_TASK_STATUS_DONE` as the last line of its
  final message. The controller then delivers ONE message to the queue's
  `target` chat (queue + task identified in the notice) carrying the FULL
  accumulated transcript — including the silence-probe Q&A — deletes the task
  file and ends the run. After `silence` minutes without any run event the
  controller sends a probe `user.message` into the session asking whether the
  task is finished; the probe is accumulated like any other message. The worker
  slot is held until DONE/failure/timeout (WAITING, decided), so with
  `workers: 1` a second task cannot fire between the first message and DONE.
  With `workers > 1` results are delivered in completion order (may be out of
  FIFO order) — documented, not enforced.
- **Failure (fail-and-drop, decided)**: any failed synthetic dispatch
  (`IngressResult.ok === false` for either `session.new` or the follow-up
  `user.message`), a runtime `error` event, or a timeout → end the run,
  deliver a failure notice to `target`, delete the task file, end the run.
  No retry, no head-of-line blocking; to re-run, insert again. The failure
  notice carries the real reason (`❌ Queue "<queue>" · task <taskId>
  failed: <reason>`) for dispatch failures and runtime errors; a timeout
  delivers a dedicated timeout notice (`⏰ Queue "<queue>" · task <taskId>
  timed out.`). Stop-race (SF-2): a synthetic dispatch in flight across a
  `stop()` resolves `{ ok: false, reason: "gateway is not running" }` — that
  is not a task failure; nothing is delivered and the task file stays
  `running` so the next start re-enqueues it (at-least-once).
- **Stop**: in-flight runs are forgotten; their task files stay `running`
  and are re-enqueued at the next start. No delivery after stop (same
  contract as the scheduler).

## D3 — Core changes

The synthetic-session handling added for `schedule:*` generalizes to
`queue:*`:

- divert predicate: agent output for `queue:*` client session ids is handed
  to the queue controller's output callback (same D2-divert mechanism);
- orphan guard: a `user.message` for an unbound `queue:*` id is logged and
  dropped, never auto-creates a session;
- bindings for `queue:*` ids are memory-only (never persisted to
  `session-bindings/<channel>.json`);
- `session.new` creation failures for `queue:*` ids surface only through the
  `IngressResult` (nothing is delivered to the IM adapter, which could not
  resolve the id anyway).

Chat sessions and `schedule:*` behavior are unchanged.

## D4 — Commands

**CLI** (i18n, same patterns as `schedule add/list`):

- `agent-bridge queue add` — wizard: queue name (unique; invalid/existing
  name re-asked), channel select, workers (default 1), model (optional,
  blank = channel default). Writes `queues/<name>.md` with an empty body
  (the body is the shared context, set by editing the file). Success message
  points to editing the file for the shared context, `/queue-here` and
  `queue insert`.
- `agent-bridge queue insert <name> --prompt "..."` — validates the queue
  exists, appends a task file. If the queue has no `target`, prints a
  warning that tasks wait until `/queue-here` binds a chat (decided).
  Insert always succeeds regardless of binding or whether the channel is
  running — the task is durable the moment the file lands.
- `agent-bridge queue list` — table: name, channel, workers, model,
  bound (target), pending count, running count.

**IM**:

- `/queue-here <name>` — binds the current chat as the queue's `target`
  (written into the queue file). Refuses when: queue does not exist, queue
  belongs to a different channel, queue already bound (rebind = edit the
  file with AI). Success message in the chat's language.

No IM insert command in this version (decided).

## D5 — Out of scope (this version)

IM insert; queue remove/clear commands (AI edits files); pause/resume;
per-task model override at insert time; task priorities or delayed tasks;
result delivery ordering guarantees under concurrency.

## D6 — Testing

- queue-file module: parse/validate definition (channel required, workers >=
  1, model optional); insert task (id/FIFO ordering, state field);
  state transitions; body+prompt composition.
- controller (mirror scheduler tests): capacity = workers - inFlight; FIFO
  order; completion delivery + task file deleted; failure notice + drop on
  dispatch failure / error event / timeout; unbound queue not consumed;
  restart re-enqueues running tasks; definitions reloaded on tick; no
  delivery after stop.
- gateway-core: `queue:*` divert, orphan guard, memory-only binding,
  IngressResult-only failure; `schedule:*` and chat paths unchanged.
- CLI: add wizard (validation, file written), insert (warning when
  unbound), list counts.
- i18n: new keys in both `en-US` and `zh-CN`.
