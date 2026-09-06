# Event Queue (Agent Task Queue) — design spec

Status: implemented (T1–T5, branch `feat/event-queue`). Grill decisions:
the 2026-08-19 grill session. The user-facing
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
channel: feishu-dev        # owning channel; ABSENT until /queue-here writes it
workers: 2                 # max concurrent tasks; integer >= 1, default 1
silence: 30m               # optional; silence window before a probe (same syntax as timeout, default 30m)
timeout: 1h                # optional; wall-clock run limit (same syntax and 5h default as scheduled tasks)
model: provider/model-id   # optional; blank/absent = channel default model
directory: ~/project/foo   # optional; working directory for the queue's runs (fire-time validated; any task-level override of the same parameter beats it)
target: chat:xxx           # delivery address; written by /queue-here
enabled: true              # optional; `false` = persistent disable switch
---

Shared context appended to every task prompt of this queue.
```

**Task** — `queues/<name>.tasks/<taskId>.md` (one file per task):

```markdown
---
state: pending             # pending | running | failed
enqueuedAt: 2026-08-19T08:00:00.000Z
directory: /srv/work       # optional; task-level working directory (overrides the queue's `directory:`)
model: provider/model-id   # optional; task-level model override (overrides the queue's `model:`; absent = the queue's, then the channel default)
timeout: 30m               # optional; task-level wall-clock run limit (overrides the queue's `timeout:`; same syntax, absent = the queue's, then the 5h default)
silence: 5m                # optional; task-level silence-probe window (overrides the queue's `silence:`; same syntax, absent = the queue's, then the default)
failedAt: 2026-08-19T09:00:00.000Z   # dead-letter only (failed tasks); ISO timestamp of the failure
reason: boom: model not available    # dead-letter only; human-readable failure reason
agentSessionId: pi-coding-agent:1234 # dead-letter only; present when the agent session was created
---

The task prompt.
```

`taskId` = `<enqueueMs>-<random4>`; lexicographic filename order is the FIFO
order. Tasks are plain files: external programs can enqueue by writing a file;
management (clear, reorder, remove) is done by editing files with AI. A failed
task keeps its file (`state: failed`, with `failedAt` / `reason` and — when the
session was created — `agentSessionId`) until it is re-queued with `queue
retry` or removed by hand.

**Task-level run parameters (T03):** every run parameter has a task-level
override (`directory:` / `model:` / `timeout:` / `silence:`), all following one
unified resolution chain — task level > queue definition level > built-in
default. `model` is the one exception: its chain ends at the channel agent
config's model (no built-in default participates). `queue insert` writes each
line only when the corresponding `--directory` / `--model` / `--timeout` /
`--silence` flag is given.

## D2 — Queue controller (per channel)

`src/modules/queue/`, started by `channel-runner` next to the scheduler. The
controller only manages queues whose `channel` equals its channel name (same
ownership rule as the scheduler).

- **Start**: scan owned task directories; every `state: running` task is
  reset to `pending` (at-least-once: a task in flight at shutdown is
  re-executed; no notice is sent for the interruption). `failed` tasks are
  untouched — only `queue retry` re-queues them.
- **Tick** (30s default): reload queue definitions; for each queue with a
  non-empty `target` and `enabled: true` (only the exact value `false`
  disables): capacity = `workers - inFlight(queue)`; take the oldest
  `pending` tasks up to capacity, mark them `running`, and fire each.
- **Unbound queue** (empty `target`): never consumed; tasks pile up until
  `/queue-here` binds a chat, then the backlog drains automatically.
- **Fire**: register a run under the synthetic client session id
  `queue:<queueName>:<taskId>`; resolve the working directory (task
  `directory:` > queue `directory:` > bridge process cwd — both levels are
  validated at fire time, scheduler-D6 style: an invalid queue-level value
  stalls the queue's non-override tasks with a warn log, an invalid
  task-level value drops just that task with a `❌ Queue "<queue>" task
  could not start: <detail>` notice); `dispatchClientEvent` a `session.new`
  (carrying the canonical directory and `model` when one is pinned), check the `IngressResult`;
  on `ok` dispatch `user.message` with `<queue body>\n\n<task prompt>\n\n<completion-protocol block>` (the body is empty when blank; the fixed protocol block is the T4 DONE-marker instruction).
  Every run parameter resolves through one unified override chain — task
  level > queue definition level > built-in default (T03): the model is
  `task.model ?? definition.model` (absent → the channel agent config's
  model), the wall-clock timer is set from `task.timeoutMs ??
  definition.timeoutMs` (5-hour default, same as scheduled tasks) and the
  silence probe window from `task.silenceMs ?? definition.silenceMs`
  (same syntax and default as the definition's `silence`).
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
- **Failure (dead-letter terminal state, spec D2/T02)**: any failed synthetic
  dispatch (`IngressResult.ok === false` for either `session.new` or the
  follow-up `user.message`), a runtime `error` event, or a timeout → end the
  run, deliver ONE failure notice to `target`, and flip the task file to the
  `failed` terminal state — the file is KEPT, with `failedAt` (ISO timestamp),
  `reason`, and `agentSessionId` when the agent session was actually created
  (written in one atomic edit). The notice carries the real reason and the
  agent session id (when one exists) so the failure can be traced on the agent
  side.
  A timeout additionally tears down the run's agent session via
  `command.session.release` (process terminated, not just turn-aborted — a
  timed-out agent cannot revive on queued probe messages) and dead-letters the
  task the same way (`reason: timed out after Xms`). The timeout chain
  itself is hang/throw-hardened (timeout teardown spec D3): the whole body
  sits in one top-level try/catch (the timer callback is a floating promise —
  no silent breakage), local fs steps first (history line, dead-letter write)
  and remote steps last, with the release dispatch fired and NOT awaited
  (`void #dispatchSafe(...)`) so a permanently hung dispatch cannot block the
  local cleanup.
  The only remaining fail-and-drop path is the pre-session configuration
  error: a task-level `directory:` that fails validation before anything is
  dispatched — no session exists to trace, so the task file is deleted and
  the notice says the session could not start (`❌ Queue "<queue>" task could
  not start: <detail>`); the user fixes the configuration and inserts again.
  Re-queueing a dead-lettered task is explicit:
  `agent-bridge queue retry <queue> <taskId>` flips `state:` back to `pending`
  (clearing `failedAt`/`reason`/`agentSessionId`) and the next tick consumes
  it like any pending task; only `failed` tasks can be retried.
  Tick consumption only picks `pending` tasks (a `failed` file is never
  consumed automatically), and the startup recovery resets only `running` →
  `pending` — `failed` files survive restarts untouched.
  No head-of-line blocking. Stop-race (SF-2): a synthetic dispatch in flight
  across a `stop()` resolves `{ ok: false, reason: "gateway is not running" }`
  — that is not a task failure; nothing is delivered and the task file stays
  `running` so the next start re-enqueues it (at-least-once).
- **Stop**: in-flight runs are forgotten; their task files stay `running`
  and are re-enqueued at the next start. No delivery after stop (same
  contract as the scheduler).
- **Zombie-task self-heal (timeout teardown spec D4, amended by dead-letter
  T02)**: when a cleanup chain dies midway (e.g. the timeout chain hung after
  the registry removal), the task file would stay `running` forever — with
  `workers: 1` this fakes occupancy until a bridge restart. The reconciliation
  keeps files (never deletes): a leftover `running` file with no live run is
  logged and left for the next start's at-least-once reset or manual/AI
  cleanup — deleting it under dead-letter semantics would destroy the very
  trace the terminal state exists to keep. It is deliberately never reset to
  `pending` here (a mid-session zombie proves the run terminated without
  finishing; re-running risks duplicate side effects). Race safety against an
  interleaving healthy cleanup chain (ticks and run timers are independent
  chains): runs record a tombstone timestamp when they end
  (`#endRun`/`#handleTimeout`; runs cleared by `stop()` get none — those files
  belong to the next start's at-least-once reset), and the reconciliation
  skips runs ended within the last 2×tickMs. Tombstones are pruned every tick.
  Ownership filtering matches fire: disabled/unbound/foreign queues are
  untouched; `failed` files are never touched by the reconciliation.

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

- `agent-bridge queue add` — wizard (identical to the `schedule add` wizard
  except step 2; all prompts are localized): queue name (unique;
  invalid/existing name re-asked), workers (default 1), timeout (prefilled
  `5h`; blank = the built-in default — no `timeout:` line), silence (prefilled
  `30m`; blank = the built-in default — no `silence:` line), model (optional,
  blank = channel default, no `model:` line), working directory (optional,
  blank = bridge process cwd, no `directory:` line) and an optional
  shared-context body (blank = an empty body). Writes `queues/<name>.md`
  (key order: workers, timeout, silence, model, directory — each line only
  when a non-blank value was entered). Success message points to editing the
  file for the shared context, `/queue-here` and `queue insert`.
- `agent-bridge queue insert <name> --prompt "..." [--directory <path>] [--model <model>] [--timeout <duration>] [--silence <duration>]` — validates the queue
  exists (and the `--timeout` / `--silence` durations against the shared
  grammar, erroring out before anything is written), appends a task file. Each
  flag lands as the task-level override of that run parameter (T03). If the queue has no
  `target`, prints a
  warning that tasks wait until `/queue-here` binds a chat (decided).
  Insert always succeeds regardless of binding or whether the channel is
  running — the task is durable the moment the file lands.
- `agent-bridge queue list` — table: name, channel, workers, model,
  enabled, bound (target), pending count, running count.
- `agent-bridge queue enable|disable <queue-name>` — toggles the
  definition's persistent `enabled` front matter (atomic single-line edit,
  same rules as the bind edit). Disabling pauses consumption: pending tasks
  pile up untouched, in-flight runs are unaffected; enabling resumes and the
  backlog drains on the next tick. Decided: no IM command for this (the
  low-frequency-management-via-AI-file-edits principle; the CLI toggle and
  file edits both ride the 30 s hot reload).
- `agent-bridge queue retry <queue-name> <task-id>` — re-queues a
  dead-lettered task (spec D2/T02): only a `state: failed` task can be
  retried; the atomic single write flips `state:` back to `pending` and
  clears the `failedAt` / `reason` / `agentSessionId` lines. Consumption is
  the controller's next tick — retry is only a state flip, nothing fires
  here. Errors on a missing task, an invalid name/id, or a non-`failed`
  state.

**IM**:

- `/queue-here <name>` — binds the current chat as the queue's `target`
  (written into the queue file). Refuses when: queue does not exist, queue
  belongs to a different channel, queue already bound (rebind = edit the
  file with AI). Success message in the chat's language.

No IM insert command in this version (decided).

## D5 — Out of scope (this version)

IM insert; queue remove/clear commands (AI edits files); task priorities or delayed tasks;
result delivery ordering guarantees under concurrency. (Task-level run-parameter
overrides at insert time were originally listed here — the model/directory/timeout/silence
flags have since been implemented; see D1/D4. A whole-queue
persistent disable switch — originally listed here as "pause/resume" — has
also been implemented; see D4.)

## D6 — Testing

- queue-file module: parse/validate definition (channel required, workers >=
  1, model optional); insert task (id/FIFO ordering, state field);
  state transitions; body+prompt composition.
- controller (mirror scheduler tests): capacity = workers - inFlight; FIFO
  order; completion delivery + task file deleted; runtime failures
  (dispatch failure / error event / timeout) dead-letter the task (state
  failed + failedAt/reason/agentSessionId kept, notice with the agent
  session id); an invalid task-level `directory:` still deletes the file
  with a "could not start" notice; unbound queue not consumed; restart
  re-enqueues running tasks (failed untouched); tick never consumes failed;
  definitions reloaded on tick; no delivery after stop.
- gateway-core: `queue:*` divert, orphan guard, memory-only binding,
  IngressResult-only failure; `schedule:*` and chat paths unchanged.
- CLI: add wizard (validation, file written), insert (warning when
  unbound), list counts.
- i18n: new keys in both `en-US` and `zh-CN`.
- CLI: `queue add` writes `timeout:`/`silence:` only when a non-blank value
  was entered; the optional shared-context body lands in the file body (T06).
