# Event Queues

Event queues let you run a stream of agent prompts without touching a chat manually. A queue has a name, a worker count (max concurrency) and an optional pinned model; tasks are inserted from the CLI, stored as plain files, and consumed FIFO by a per-channel controller. The queue's results — and failure notices — are delivered into a chat you bind with `/queue-here`.

A queue file has two parts that matter: the **definition** (front matter: owning channel, worker count, optional model, delivery target) and the **body** — a shared context that is appended to **every** task prompt of the queue. If you want every task to start with "You are reviewing PRs in this repo, be terse", put that in the body once instead of repeating it in each task.

Like scheduled tasks, a queue run is **isolated**: it never touches the target chat's own agent session. You can keep chatting in that chat before, during, and after a run and nothing about your session changes. The chat is only used as a delivery address.

## Quick start

1. Create the queue with the CLI wizard:

   ```bash
   agent-bridge queue add
   ```

   The wizard asks, in order:

   - a queue name (lowercase letters, digits and hyphens only, e.g. `build-report`; invalid or already-taken names are re-asked),
   - the owning channel (a queue belongs to exactly one channel; only that channel's controller consumes it),
   - a worker count (default `1` — how many tasks may run at the same time),
   - an optional model (blank = the channel agent config's default model; it is not validated — the CLI can't reach provider model lists, so an invalid value only surfaces when a task runs, see [How a task runs](#how-a-task-runs)).

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

   The bridge writes that chat's session id into the queue file's `target` line and replies `Queue "build-report" is now bound to this chat — pending tasks will start draining on the next tick.`

5. Wait for the next tick (up to 30 s) — the controller picks up the pending tasks and starts running them. Each result (or failure/timeout notice) arrives in the bound chat, prefixed with a one-line header naming the queue and task:

   ```text
   ✅ Queue "build-report" · task 1755658800000-3f2a completed:
   <the agent's result>
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
channel: feishu-dev        # owning channel; required
workers: 2                 # max concurrent tasks; integer >= 1, default 1
model: azure-openai-responses/gpt-5.6-terra   # optional; blank/absent = channel default model
target: feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc   # written by /queue-here
---

You are the release bot. Always answer in one short paragraph.
```

- **Front matter** is a flat `key: value` subset (no YAML): one key per line, values are bare strings (surrounding single or double quotes are stripped), lines starting with `#` and blank lines are ignored, unknown keys produce a warning. A file that does not start with a `---` line has no front matter and the whole file is treated as the body — such a queue has no `channel` and is skipped.
- **The body** (everything after the closing `---`, trimmed) is the shared context appended to every task prompt of this queue. It may be empty.

### Fields

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `channel` | yes | — | Owning channel config name, written by `queue add`. Only that channel's controller consumes the queue (and its tasks). Missing → the queue is skipped with a log. |
| `workers` | no | `1` | Max concurrent tasks, integer >= 1. On each tick the controller starts up to `workers - inFlight` new tasks. |
| `model` | no | — | Optional per-queue agent model override for every run of the queue (same override plumbing as scheduled tasks' per-task model). Blank or absent = the channel agent config's model. Parsing only checks for a non-empty string; validity is enforced at fire time — an invalid model fails the session creation, which fails the task (see [Failure: fail-and-drop](#failure-fail-and-drop)). |
| `target` | no | — | Delivery address: the destination chat's clientSessionId, written by `/queue-here <name>` sent in that chat. Without it the queue is never consumed — tasks pile up until a chat is bound. |

`queue add` writes the front matter with `channel`, `workers` (default `1`) and `model` (only if you entered a non-empty one), plus an empty body. It does not write `target` — that line is meant to be set with `/queue-here <name>` (or edited by hand; see [Changing the destination chat](#changing-the-destination-chat)).

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
- Tasks are plain files, so external programs can enqueue by writing a file with the same shape, and management (clear, reorder, remove) is done by editing files with AI — there are no `queue remove`/`queue clear` commands in this version.

## CLI

| Command | What it does |
| --- | --- |
| `agent-bridge queue add` | Interactive wizard: queue name (slug-validated and globally unique), channel select, workers (default `1`), optional model. Writes `queues/<name>.md` and prints the file path, the `/queue-here` targeting instruction, and the `queue insert` usage. |
| `agent-bridge queue insert <queue-name> --prompt "..."` | Validates the queue exists and appends a task file (`queues/<queue-name>.tasks/<id>.md`). Prints `Inserted task <id> into queue "<name>".` If the queue has no `target`, prints a warning that tasks wait until `/queue-here` binds a chat. Insert always succeeds regardless of binding or whether the channel is running — the task is durable the moment the file lands. |
| `agent-bridge queue list` | Table of every queue: Name, Channel, Workers, Model, Bound (`yes`/`no`), Pending count, Running count. |

## `/queue-here <queue-name>`

Bind this chat as a queue's delivery target — send it **in the chat that should receive the results**:

```text
/queue-here build-report
```

- The queue name is normalized to lowercase, so `/queue-here BuildReport` binds the `buildreport` queue. A name that doesn't match `[a-z0-9-]+` gets a usage hint.
- On success the chat's `clientSessionId` is written into the queue file's `target` line and the chat receives `Queue "build-report" is now bound to this chat — pending tasks will start draining on the next tick.`
- Refused with a localized reply when:
  - the queue does not exist — `Queue "build-report" was not found.`
  - the queue belongs to a **different channel** — `Queue "build-report" belongs to channel "wecom-main".` (a queue can only deliver into a chat of its owning channel)
  - the queue is **already bound** — `Queue "build-report" is already bound to a chat. To rebind, edit the queue file with AI.`

### Changing the destination chat

A bound queue cannot be rebound with `/queue-here`. To move it to another chat, edit the queue file: remove the `target` line (unbind), then send `/queue-here <queue-name>` in the new chat; or paste the new chat's session id into the `target` line by hand. To copy a chat's session id: send `/st` in that chat and copy the **Chat session ID** line. Either change is effective on the next 30 s tick — no channel restart needed.

## How a task runs

The per-channel queue controller runs next to the scheduler and only consumes queues whose `channel` matches its channel. Each task runs in a **fresh, fully isolated agent session**:

1. On its tick the controller reloads the queue definitions and, for every bound queue (`target` set), computes **capacity = workers − inFlight**, takes the oldest `pending` tasks up to that capacity, marks them `running`, and fires each.
2. **Fire** injects two synthetic events through the same ingress path ordinary chat messages use: a `command.session.new` with the bridge process's working directory and the queue's pinned `model` (when it has one) — the override rides the same event into the agent-session creation, so only this queue's runs use it — followed by a `user.message` whose text is `<queue body>\n\n<task prompt>` (the bare prompt when the body is empty). Both carry a synthetic, run-unique client session id of the form `queue:<queue-name>:<task-id>`.
3. Each run carries a timeout timer — the same 10-minute default as scheduled tasks. The run ends by completing, failing, or timing out.

### Completion

The run's final `assistant.message` is diverted to the controller, which delivers the result to the queue's `target` chat as a normal `assistant.message` prefixed with a one-line header (`✅ Queue "<name>" · task <id> completed:`), deletes the task file, and ends the run. Attachments, chunking and formatting behave exactly like a normal agent reply.

### Failure: fail-and-drop

A task fails for exactly one of three reasons, and in every case the task file is deleted and the run ends — **no retry, no head-of-line blocking**. To re-run a failed task, insert it again.

- **Session-creation failure** — the synthetic `session.new` (or the follow-up `user.message`) reports a failure, e.g. an invalid/unavailable `model`. The run ends immediately, the target chat receives `❌ Queue "<name>" · task <id> failed: <the adapter's error detail>`, and the task is dropped. There is no fallback to the channel default model — the follow-up prompt is never sent, so the task cannot silently run on the wrong model. (A bad model is the usual cause; treat the `model` field as "pin it and verify the first task succeeded on the intended model".)
- **Runtime error** — a terminal `error` event during the run delivers the same `❌ Queue "<name>" · task <id> failed: <reason>` notice and drops the task.
- **Timeout** — the run exceeds the 10-minute default timeout: the controller aborts that run's session and delivers `⏰ Queue "<name>" · task <id> timed out.` to the target chat.

### Restart semantics: at-least-once

The controller starts and stops with the channel. On stop, in-flight runs are simply forgotten; their task files stay `running`. On the next start, every `running` task is reset to `pending` and re-fired — a task in flight at shutdown is re-executed (at-least-once). No notice is sent for the interruption, and nothing is delivered after stop.

### Concurrency and ordering

With `workers: 1` tasks run strictly one at a time, oldest first. With `workers > 1`, up to `workers` tasks run concurrently and results are delivered in **completion order** — a later-inserted task may finish (and be delivered) before an earlier one. That is expected behavior, not a bug; FIFO order applies to *starting* tasks, not to delivering results.

### Unbound queues pile up

A queue with no `target` is never consumed: tasks accumulate (each `queue insert` succeeds, with a warning). Once `/queue-here` binds a chat, the backlog drains automatically — the controller picks up the oldest pending tasks on the next tick.

### Hot reload: edits are picked up within 30 seconds

The controller reloads queue definitions on every tick, so:

- **Edited body (shared context)** → used for every task fired after the next tick.
- **Edited front matter** (`workers`, `model`, `target`) → effective on the next tick; no channel restart needed.
- **New or deleted task files** → appear/disappear on the next tick. Deleting a task file mid-run does not interrupt the in-flight run.
- There is no file-system watching; 30 s polling is cheap and predictable.

## Troubleshooting

**I inserted a task but nothing arrived — did I bind the queue?**
Run `agent-bridge queue list` — the `Bound` column shows `no` for unbound queues, and `Pending` shows the waiting tasks. Send `/queue-here <queue-name>` *in the destination chat* (which must belong to the queue's owning channel). If the queue is already bound to another chat, remove the `target` line from its file first.

**The task failed with a model error.**
The `model` field is not validated at insert time — an invalid or unavailable model fails at session creation, which fails the task with the adapter's error detail in the failure notice. Fix the `model` line (or remove it to use the channel default) and insert the task again.

**The target chat was deleted IM-side.**
Delivery goes through the normal egress path, so a deleted chat fails like any other send failure: it is logged by the bridge (the task run itself has already completed or timed out). Fix the `target` line and the next task delivers normally.

**The queue was unbound when I inserted tasks, and now it's bound — nothing ran?**
Backlog drains on the next tick after binding, up to the queue's worker capacity per tick (a new task can start as soon as a worker slot frees up, checked every 30 s). A 1-worker queue with a long backlog drains one run at a time.

**A task ran twice after a restart.**
That's by design: tasks in flight at shutdown are re-enqueued and re-run (at-least-once). If your task is not idempotent, give it a durable marker (e.g. "write `last-run.md` when done, skip if it exists").

**Still stuck?**
Check in order: is the queue listed by `queue list` (invalid `channel`/`workers` definitions are skipped with a log)? Is `Bound` `yes`? Is the owning channel running? Was the change recent (front matter and task files take effect on the next 30 s tick)? Check the bridge's logs — load skips, fire failures and delivery errors are logged under the `[queue]` scope.
