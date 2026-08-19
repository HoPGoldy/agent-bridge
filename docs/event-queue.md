# Event Queues

Event queues let you run a stream of agent prompts without touching a chat manually. A queue has a name, a worker count (max concurrency) and an optional pinned model; tasks are inserted from the CLI, stored as plain files, and consumed FIFO by a per-channel controller. The queue's results — and failure notices — are delivered into a chat you bind with `/queue-here`.

A queue file has two parts that matter: the **definition** (front matter: worker count, optional model, delivery target, and the owning channel — written only when the queue is bound) and the **body** — a shared context that is appended to **every** task prompt of the queue. If you want every task to start with "You are reviewing PRs in this repo, be terse", put that in the body once instead of repeating it in each task.

Like scheduled tasks, a queue run is **isolated**: it never touches the target chat's own agent session. You can keep chatting in that chat before, during, and after a run and nothing about your session changes. The chat is only used as a delivery address.

## Quick start

1. Create the queue with the CLI wizard:

   ```bash
   agent-bridge queue add
   ```

   The wizard asks, in order:

   - a queue name (lowercase letters, digits and hyphens only, e.g. `build-report`; invalid or already-taken names are re-asked),
   - a worker count (default `1` — how many tasks may run at the same time),
   - an optional model (blank = the channel agent config's default model; it is not validated — the CLI can't reach provider model lists, so an invalid value only surfaces when a task runs, see [How a task runs](#how-a-task-runs)).

   There is **no channel step** — a queue is created unbound and ownerless. The channel is only assigned later, when `/queue-here` binds a chat.

   It writes the queue file and prints three pointers: edit the file to set the shared context, send `/queue-here <name>` in chat to bind a chat, and insert tasks with `queue insert`.

2. Edit the queue file to set the shared context (see [Queue file format](#queue-file-format)). The wizard writes an empty body — everything in the body is prepended to every task prompt.

3. Insert tasks:

   ```bash
   agent-bridge queue insert build-report --prompt "Summarize today's build failures"
   ```

   The task is durable the moment the file lands — it is kept even if the channel is stopped or the queue is not yet bound.

4. Bind the queue to a chat with `/queue-here`. Send this **in the chat that should receive the results**:

   ```text
   /queue-here build-report
   ```

   The bridge writes that chat's session id into the queue file's `target` line **and** the current channel's config name into the `channel` line (one atomic write) and replies `Queue "build-report" is now bound to this chat.`

5. Wait for the next tick (up to 30 s) — the controller picks up the pending tasks and starts running them. Each result (or failure/timeout notice) is delivered **content first, then a trailing italic one-liner** naming the queue and its kept transcript file:

   ```text
   <the run's last assistant message>

   *Queue "build-report" task completed · full output: ~/.config/agent-bridge/run-outputs/queue_build-report_1755658800000-3f2a.md*
   ```

   If the queue already had tasks queued while unbound, the backlog drains automatically once the chat is bound.

## Queue file format

Queues live under `~/.config/agent-bridge/queues/`:

```
~/.config/agent-bridge/queues/<queue-name>.md              # queue definition
~/.config/agent-bridge/queues/<queue-name>.tasks/<id>.md   # one file per task
```

A queue definition is front matter plus a body:

```markdown
---
workers: 2                 # max concurrent tasks; integer >= 1, default 1
silence: 10m               # optional; silence window before a probe (same syntax as timeout, default 10m)
model: azure-openai-responses/gpt-5.6-terra   # optional; blank/absent = channel default model
channel: feishu-dev        # owning channel; ABSENT until /queue-here writes it
target: feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc   # written by /queue-here
---

You are the release bot. Always answer in one short paragraph.
```

- **Front matter** is a flat `key: value` subset (no YAML): one key per line, values are bare strings (surrounding single or double quotes are stripped), lines starting with `#` and blank lines are ignored, unknown keys produce a warning. A file that does not start with a `---` line has no front matter and the whole file is treated as the body.
- **The body** (everything after the closing `---`, trimmed) is the shared context appended to every task prompt of this queue. It may be empty.

### Fields

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `channel` | no (absent until bound) | — | Owning channel config name, written by `/queue-here` at bind time together with `target`. Only that channel's controller consumes the queue (and its tasks). A queue without `channel` is owned by no controller and is never consumed — `queue add` does not write it. |
| `workers` | no | `1` | Max concurrent tasks, integer >= 1. On each tick the controller starts up to `workers - inFlight` new tasks. |
| `silence` | no | `10m` | Silence window before a probe is sent into a run: same duration syntax as `timeout`. After this many minutes with no observable run activity, the controller asks the run whether it is finished (see [Completion](#completion)). An invalid value fails validation and the queue is skipped with a log. |
| `model` | no | — | Optional per-queue agent model override for every run of the queue (same override plumbing as scheduled tasks' per-task model). Blank or absent = the channel agent config's model. Parsing only checks for a non-empty string; validity is enforced at fire time — an invalid model fails the session creation, which fails the task (see [Failure: fail-and-drop](#failure-fail-and-drop)). |
| `target` | no | — | Delivery address: the destination chat's clientSessionId, written by `/queue-here <name>` sent in that chat. Without it the queue is never consumed — tasks pile up until a chat is bound. |

`queue add` writes the front matter with `workers` (default `1`) and `model` (only if you entered a non-empty one), plus an empty body — **no `channel`, no `target`**: a fresh queue is unbound and ownerless until `/queue-here` writes both lines in one atomic edit. It does not offer a `silence` prompt — that field is set (and tuned) by editing the file, defaulting to `10m`.

## Task files

A task is one Markdown file per prompt:

```markdown
---
state: pending             # pending | running
enqueuedAt: 2026-08-19T08:00:00.000Z
---

The task prompt.
```

- The task id (the file name without `.md`) is `<enqueueMs>-<random4>` — a monotonic millisecond timestamp plus four random hex digits, e.g. `1755658800000-3f2a`. Because the id's prefix is monotonic, **lexicographic file-name order is the FIFO order**.
- `queue insert` writes `state: pending`; the controller flips it to `running` when it starts the task and deletes the file when the task completes, fails, or times out.
- Tasks are plain files, so external programs can enqueue by writing a file with the same shape, and management (clear, reorder) is done by editing files with AI. To remove a whole queue (definition **and** its pending tasks), use `agent-bridge queue remove <queue-name>`.

## CLI

| Command | What it does |
| --- | --- |
| `agent-bridge queue add` | Interactive wizard: queue name (slug-validated and globally unique), workers (default `1`), optional model — **no channel step**. Writes `queues/<name>.md` (without `channel`/`target`) and prints the file path, the `/queue-here` targeting instruction, and the `queue insert` usage. |
| `agent-bridge queue insert <queue-name> --prompt "..."` | Validates the queue exists and appends a task file (`queues/<queue-name>.tasks/<id>.md`). Prints `Inserted task <id> into queue "<name>".` If the queue has no `target`, prints a warning that tasks wait until `/queue-here` binds a chat. Insert always succeeds regardless of binding or whether the channel is running — the task is durable the moment the file lands. |
| `agent-bridge queue list` | Table of every queue: Name, Channel, Workers, Model, Bound (`yes`/`no`), Pending count, Running count. |
| `agent-bridge queue remove <queue-name>` | Delete the queue definition file **and** its `<queue-name>.tasks/` directory recursively — pending tasks die with the queue, no prompts. Errors on an unknown queue or an invalid name. |

## `/queue-here <queue-name>`

Bind this chat as a queue's delivery target — send it **in the chat that should receive the results**:

```text
/queue-here build-report
```

- The queue name is normalized to lowercase, so `/queue-here BuildReport` binds the `buildreport` queue. A name that doesn't match `[a-z0-9-]+` gets a usage hint.
- On success the chat's `clientSessionId` is written into the queue file's `target` line **and** the current channel's config name into the `channel` line — one atomic write — and the chat receives `Queue "build-report" is now bound to this chat.`
- Refused with a localized reply when:
  - the queue does not exist — `Queue "build-report" was not found.`
  - the queue is **already bound** — `Queue "build-report" is already bound to a chat. To rebind, edit the queue file with AI.`

There is no "belongs to a different channel" refusal: the `channel` is always written as the current channel at bind time, so a queue can be bound from (and moved to) any chat — a stale `channel` line from an older file is simply overwritten. A queue with no `channel` is unbound: it belongs to no controller and is never consumed until `/queue-here` binds it.

### Changing the destination chat

A bound queue cannot be rebound with `/queue-here`. To move it to another chat, edit the queue file: remove the `target` line (unbind — removing the `channel` line too is optional but keeps the file tidy), then send `/queue-here <queue-name>` in the new chat; or paste the new chat's session id into the `target` line by hand. To copy a chat's session id: send `/st` in that chat and copy the **Chat session ID** line. Either change is effective on the next 30 s tick — no channel restart needed.

## How a task runs

The per-channel queue controller runs next to the scheduler and only consumes queues whose `channel` matches its channel. Each task runs in a **fresh, fully isolated agent session**:

1. On its tick the controller reloads the queue definitions and, for every bound queue (`target` set), computes **capacity = workers − inFlight**, takes the oldest `pending` tasks up to that capacity, marks them `running`, and fires each.
2. **Fire** injects two synthetic events through the same ingress path ordinary chat messages use: a `command.session.new` with the bridge process's working directory and the queue's pinned `model` (when it has one) — the override rides the same event into the agent-session creation, so only this queue's runs use it — followed by a `user.message` whose text is `<queue body>\n\n<task prompt>` (the bare prompt when the body is empty), wrapped with the fixed completion-protocol instruction block. Both carry a synthetic, run-unique client session id of the form `queue:<queue-name>:<task-id>`.
3. Each run carries a timeout timer — the same 10-minute default as scheduled tasks — and a silence probe (`silence` front matter, default `10m`). A run ends by completing, failing, or timing out.

### Completion

Assistant output no longer completes a task on its own: **a task completes only when the agent signals it is done.** Each task prompt is wrapped with a fixed completion-protocol instruction block, and every assistant message during the run is accumulated into a per-run local file under `run-outputs/` (shared with scheduled tasks; see `docs/scheduled-tasks.md`). The agent finishes its final `assistant.message` with the marker line `BRIDGE_TASK_STATUS_DONE` as its last line; the controller then delivers **only that last message** to the queue's `target` chat exactly once, as a normal `assistant.message` — **content first, then a trailing italic one-liner** naming the queue and its kept transcript file (no prefix header, no task id):

```text
<the run's last assistant message>

*Queue "<name>" task completed · full output: ~/.config/agent-bridge/run-outputs/queue_<queue>_<task-id>.md*
```

The task file is then deleted and the run ends. Attachments and formatting from every accumulated message still go with the delivery; the **full transcript stays in the accumulation file** at `run-outputs/<run-id>.md` (kept after delivery — it is the pointer the suffix references) and is *not* inlined. A marker in an intermediate (non-last) line is *not* a completion signal.

**Waiting on async work.** The protocol block tells the agent to work until the task is fully complete, including async follow-ups (background jobs, sub-agents, external callbacks), and to append `BRIDGE_TASK_STATUS_DONE` only when it truly is. So a task waiting on asynchronous callbacks should simply **not emit DONE until they return** — the run stays alive and keeps accumulating.

**The silence probe.** After `silence` minutes without any observable run activity, the controller sends a probe message into the run session asking whether the task is finished (reply DONE, or keep working / keep waiting for async callbacks). Any run event — an assistant message, tool progress, or a probe answer — resets the silence window. The probe Q&A is accumulated and included in the delivered transcript. An unanswered probe is harmless: the wall-clock timeout remains the only cap.

**The worker slot is held until the run ends.** A run holds its worker slot until DONE, failure or timeout — not just until its first message. With `workers: 1`, a second task cannot fire between the first assistant message and the DONE marker; with `workers > 1`, capacity (`workers − inFlight`) is computed against in-flight runs, so waiting tasks do not consume extra concurrency.

### Failure: fail-and-drop

A task fails for exactly one of three reasons, and in every case the task file is deleted and the run ends — **no retry, no head-of-line blocking**. To re-run a failed task, insert it again.

- **Session-creation failure** — the synthetic `session.new` (or the follow-up `user.message`) reports a failure, e.g. an invalid/unavailable `model`. The run ends immediately, the target chat receives the real reason followed by the italic one-liner (e.g. `<the adapter's error detail>

*Queue "<name>" task failed*`), and the task is dropped. There is no fallback to the channel default model — the follow-up prompt is never sent, so the task cannot silently run on the wrong model. (A bad model is the usual cause; treat the `model` field as "pin it and verify the first task succeeded on the intended model".)
- **Runtime error** — a terminal `error` event during the run delivers the same format — the error reason first, then the italic one-liner `*Queue "<name>" task failed · full output: <path>*` — and drops the task. The partial transcript is **not** inlined; it stays in the kept accumulation file the suffix references.
- **Timeout** — the run exceeds the 10-minute default timeout: the controller aborts that run's session and delivers the italic one-liner `*Queue "<name>" task timed out · full output: <path>*`. The partial transcript is **not** inlined; it stays in the kept accumulation file.

### Restart semantics: at-least-once

The controller starts and stops with the channel. On stop, in-flight runs are simply forgotten; their task files stay `running`. On the next start, every `running` task is reset to `pending` and re-fired — a task in flight at shutdown is re-executed (at-least-once). No notice is sent for the interruption, and nothing is delivered after stop.

### Concurrency and ordering

With `workers: 1` tasks run strictly one at a time, oldest first. With `workers > 1`, up to `workers` tasks run concurrently and results are delivered in **completion order** — a later-inserted task may finish (and be delivered) before an earlier one. That is expected behavior, not a bug; FIFO order applies to *starting* tasks, not to delivering results.

### Unbound queues pile up

A queue with no `target` (and no `channel`) is never consumed: it belongs to no controller, tasks accumulate (each `queue insert` succeeds, with a warning), and `queue list` shows `Bound: no` and `Channel: -`. Once `/queue-here` binds a chat — writing both the channel and the target — the backlog drains automatically: the controller picks up the oldest pending tasks on the next tick.

### Hot reload: edits are picked up within 30 seconds

The controller reloads queue definitions on every tick, so:

- **Edited body (shared context)** → used for every task fired after the next tick.
- **Edited front matter** (`workers`, `silence`, `model`, `target`) → effective on the next tick; no channel restart needed.
- **New or deleted task files** → appear/disappear on the next tick. Deleting a task file mid-run does not interrupt the in-flight run.
- There is no file-system watching; 30 s polling is cheap and predictable.

## Troubleshooting

**I inserted a task but nothing arrived — did I bind the queue?**
Run `agent-bridge queue list` — the `Bound` column shows `no` for unbound queues (and the `Channel` column shows `-`), and `Pending` shows the waiting tasks. Send `/queue-here <queue-name>` *in the destination chat* (the channel is set to that chat's channel at bind time). If the queue is already bound to another chat, remove the `target` line from its file first.

**The task failed with a model error.**
The `model` field is not validated at insert time — an invalid or unavailable model fails at session creation, which fails the task with the adapter's error detail in the failure notice. Fix the `model` line (or remove it to use the channel default) and insert the task again.

**The target chat was deleted IM-side.**
Delivery goes through the normal egress path, so a deleted chat fails like any other send failure: it is logged by the bridge (the task run itself has already completed or timed out). Fix the `target` line and the next task delivers normally.

**The queue was unbound when I inserted tasks, and now it's bound — nothing ran?**
Backlog drains on the next tick after binding, up to the queue's worker capacity per tick (a new task can start as soon as a worker slot frees up, checked every 30 s). A 1-worker queue with a long backlog drains one run at a time.

**A task ran twice after a restart.**
That's by design: tasks in flight at shutdown are re-enqueued and re-run (at-least-once). If your task is not idempotent, give it a durable marker (e.g. "write `last-run.md` when done, skip if it exists").

**Still stuck?**
Check in order: is the queue listed by `queue list` (invalid `workers`/`silence` definitions are skipped with a log; an unbound queue shows `Channel: -`)? Is `Bound` `yes`? Is the owning channel running? Was the change recent (front matter and task files take effect on the next 30 s tick)? Check the bridge's logs — load skips, fire failures and delivery errors are logged under the `[queue]` scope.
