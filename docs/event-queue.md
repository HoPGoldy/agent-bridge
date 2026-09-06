# Event Queues

Event queues let you run a stream of agent prompts without touching a chat manually. A queue has a name, a worker count (max concurrency) and an optional pinned model; tasks are inserted from the CLI, stored as plain files, and consumed FIFO by a per-channel controller. The queue's results — and failure notices — are delivered into a chat you bind with `/queue-here`.

A queue file has two parts that matter: the **definition** (front matter: worker count, optional model, delivery target, and the owning channel — written only when the queue is bound) and the **body** — a shared context that is appended to **every** task prompt of the queue. If you want every task to start with "You are reviewing PRs in this repo, be terse", put that in the body once instead of repeating it in each task.

Like scheduled tasks, a queue run is **isolated**: it never touches the target chat's own agent session. You can keep chatting in that chat before, during, and after a run and nothing about your session changes. The chat is only used as a delivery address.

## Quick start

1. Create the queue with the CLI wizard:

   ```bash
   agent-bridge queue add
   ```

   The wizard asks, in order (identical to the `schedule add` wizard except the workers step; all prompts are localized):

   - a queue name (lowercase letters, digits and hyphens only, e.g. `build-report`; invalid or already-taken names are re-asked),
   - a worker count (default `1` — how many tasks may run at the same time),
   - a timeout (prefilled `5h`; blank = the built-in default — no `timeout:` line is written),
   - a silence window (prefilled `30m`; blank = the built-in default — no `silence:` line is written),
   - an optional model (blank = the channel agent config's default model — no `model:` line; it is not validated — the CLI can't reach provider model lists, so an invalid value only surfaces when a task runs, see [How a task runs](#how-a-task-runs)),
   - an optional working directory (blank = the bridge process cwd — no `directory:` line; validated at fire time, not here; see [Fields](#fields)),
   - an optional shared-context body (blank = an empty body; see step 2).

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
silence: 30m               # optional; silence window before a probe (same syntax as timeout, default 30m)
timeout: 1h                # optional; wall-clock run limit (same syntax and 5h default as scheduled tasks)
model: azure-openai-responses/gpt-5.6-terra   # optional; blank/absent = channel default model
directory: ~/project/my-repo  # optional; working directory for every run (any task-level override of the same parameter beats it)
channel: feishu-dev        # owning channel; ABSENT until /queue-here writes it
target: feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc   # written by /queue-here
enabled: true              # optional; `false` disables the queue (see below)
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
| `silence` | no | `30m` | Silence window before a probe is sent into a run: same duration syntax as `timeout`. After this many minutes with no observable run activity, the controller asks the run whether it is finished (see [Completion](#completion)). An invalid value fails validation and the queue is skipped with a log. |
| `timeout` | no | `5h` | Max wall-clock duration of a run (`90s` / `10m` / `1h`): same duration syntax and 5-hour default as a scheduled task's `timeout`. Unattended runs may legitimately take hours and the timeout is destructive (abort + dead-letter), so the default errs long. The value is captured when a task fires, so an edit affects runs fired after the edit, not in-flight ones. An invalid value fails validation and the queue is skipped with a log. |
| `model` | no | — | Optional per-queue agent model override for every run of the queue (same override plumbing as scheduled tasks' per-task model). Blank or absent = the channel agent config's model. Parsing only checks for a non-empty string; validity is enforced at fire time — an invalid model fails the session creation, which dead-letters the task (see [Failure: dead-letter and retry](#failure-dead-letter-and-retry)). |
| `directory` | no | bridge process cwd | Working directory for every run of the queue (`~` and relative paths are resolved at fire time; same semantics as a scheduled task's `directory`). Validated at fire time: an invalid value stalls the queue's non-override tasks (they stay pending, warn log only — like an unbound queue) until the file is fixed; override tasks still fire. |
| `target` | no | — | Delivery address: the destination chat's clientSessionId, written by `/queue-here <name>` sent in that chat. Without it the queue is never consumed — tasks pile up until a chat is bound. |
| `enabled` | no | `true` | `false` (case-insensitive) disables the queue: the controller never consumes it — pending tasks pile up untouched (in-flight runs are unaffected and finish normally). Any other value or absence means enabled. Re-enabling drains the backlog automatically on the next tick. Toggle with `agent-bridge queue enable|disable <queue-name>` or by editing the file. |

**Task-level overrides.** Every run parameter can also be set per task (see [Task files](#task-files)): a task's own `directory:` / `model:` / `timeout:` / `silence:` beats the queue definition's same-named field. The unified resolution chain is **task level > queue level > built-in default** — with one exception: `model` ends at the channel agent config's model (there is no built-in default model). `queue insert` writes these lines when you pass `--directory` / `--model` / `--timeout` / `--silence`.

`queue add` writes the front matter with `workers` (default `1`), `timeout` and `silence` (each only when a non-blank value was entered — the prefills are the built-in defaults), `model` and `directory` (only if you entered a non-empty one), plus the body (the shared context; empty when left blank) — **no `channel`, no `target`, no `enabled`**: a fresh queue is unbound and ownerless until `/queue-here` writes both lines in one atomic edit.

## Task files

A task is one Markdown file per prompt:

```markdown
---
state: pending             # pending | running | failed
enqueuedAt: 2026-08-19T08:00:00.000Z
directory: ~/project/other-repo   # optional; overrides the queue's `directory:` for this task
model: azure-openai-responses/gpt-5.6-terra   # optional; overrides the queue's `model:` for this task (absent = the queue's, then the channel default)
timeout: 30m               # optional; task-level wall-clock run limit (overrides the queue's `timeout:`; absent = the queue's, then the 5h default)
silence: 5m                # optional; task-level silence-probe window (overrides the queue's `silence:`; absent = the queue's, then the default)
failedAt: 2026-08-19T09:05:00.000Z   # failed tasks only; ISO timestamp of the failure
reason: boom: model not available    # failed tasks only; why the run failed
agentSessionId: pi-coding-agent:1234 # failed tasks only; present when the agent session was created
---

The task prompt.
```

- The task id (the file name without `.md`) is `<enqueueMs>-<random4>` — a monotonic millisecond timestamp plus four random hex digits, e.g. `1755658800000-3f2a`. Because the id's prefix is monotonic, **lexicographic file-name order is the FIFO order**.
- `queue insert` writes `state: pending` plus any task-level overrides you passed (`directory:` / `model:` / `timeout:` / `silence:`, each only when the corresponding flag is given); the controller flips it to `running` when it starts the task and deletes the file when the task completes. A task that fails (runtime error, dispatch failure, timeout) is **kept** with `state: failed` plus the dead-letter trace fields (`failedAt`, `reason`, and `agentSessionId` when the session was created) — see [Failure: dead-letter and retry](#failure-dead-letter-and-retry).
- Tasks are plain files, so external programs can enqueue by writing a file with the same shape, and management (clear, reorder) is done by editing files with AI. To remove a whole queue (definition **and** its pending tasks), use `agent-bridge queue remove <queue-name>`.

## CLI

| Command | What it does |
| --- | --- |
| `agent-bridge queue add` | Interactive wizard: queue name (slug-validated and globally unique), workers (default `1`), timeout and silence (prefilled `5h` / `30m`; blank = the built-in default — the line is not written), optional model, optional working directory and an optional shared-context body — **no channel step**. Writes `queues/<name>.md` (without `channel`/`target`) and prints the file path, the `/queue-here` targeting instruction, and the `queue insert` usage. |
| `agent-bridge queue insert <queue-name> --prompt "..."` | Validates the queue exists (and `--timeout` / `--silence` against the shared duration grammar — a bad value errors out before anything is written) and appends a task file (`queues/<queue-name>.tasks/<id>.md`). `--directory <path>` sets a task-level working directory, `--model <model>` a task-level model, `--timeout <duration>` (e.g. `10m`) a task-level run limit and `--silence <duration>` a task-level probe window — each overrides the queue's same-named field for this task (see [Fields](#fields); directory and model are validated at fire time, not here). Prints `Inserted task <id> into queue "<name>".` If the queue has no `target`, prints a warning that tasks wait until `/queue-here` binds a chat. Insert always succeeds regardless of binding or whether the channel is running — the task is durable the moment the file lands. |
| `agent-bridge queue list` | Table of every queue: Name, Channel, Workers, Model, Enabled (`yes`/`no`), Bound (`yes`/`no`), Pending count, Running count. |
| `agent-bridge queue enable <queue-name>` | Set `enabled: true` in the queue file (atomic single-line edit). Consumption resumes on the next tick and the pending backlog drains automatically. Errors on an unknown queue or an invalid name. |
| `agent-bridge queue disable <queue-name>` | Set `enabled: false` — the controller stops consuming the queue; pending tasks pile up untouched and in-flight runs are unaffected. Errors on an unknown queue or an invalid name. |
| `agent-bridge queue remove <queue-name>` | Delete the queue definition file **and** its `<queue-name>.tasks/` directory recursively — pending tasks die with the queue, no prompts. Errors on an unknown queue or an invalid name. |
| `agent-bridge queue history <queue-name>` | Newest-first table of the queue's finished runs (Time, Name, Outcome, Duration, Reason, File) from the run-history index. |
| `agent-bridge queue retry <queue-name> <task-id>` | Re-queue a failed (dead-lettered) task: only a `state: failed` task can be retried. One atomic write flips `state:` back to `pending` and clears the `failedAt` / `reason` / `agentSessionId` lines; the controller consumes it on its next tick. Errors on a missing task, an invalid name/id, or a task that is not failed. |

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

1. On its tick the controller reloads the queue definitions and, for every bound queue (`target` set), reconciles stranded running files (see [Failure: dead-letter and retry](#failure-dead-letter-and-retry)), computes **capacity = workers − inFlight**, takes the oldest `pending` tasks up to that capacity, marks them `running`, and fires each.
2. **Fire** injects two synthetic events through the same ingress path ordinary chat messages use: a `command.session.new` whose working directory resolves task `directory:` → queue `directory:` → bridge process cwd (validated at fire time; the canonical path is sent) and the resolved `model` — task `model:` → queue `model:` → the channel agent config's model, so a task-level override rides the same event into the agent-session creation — followed by a `user.message` whose text is `<queue body>\n\n<task prompt>` (the bare prompt when the body is empty), wrapped with the fixed completion-protocol instruction block. Both carry a synthetic, run-unique client session id of the form `queue:<queue-name>:<task-id>`.
3. Each run carries a timeout timer set from the unified chain task `timeout:` → queue `timeout:` → 5h default (same as scheduled tasks) and a silence probe on the task `silence:` → queue `silence:` → default window. A run ends by completing, failing, or timing out.

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

### Failure: dead-letter and retry

A task fails for exactly one of four reasons. The run ends and **one** failure notice goes to the target chat — but the task file is **kept** (dead-letter, spec D2/T02): it is flipped to the terminal `state: failed` with `failedAt` (ISO timestamp), `reason`, and `agentSessionId` when the agent session was actually created. Failed tasks are never consumed automatically — they wait for an explicit `queue retry`.

- **Invalid task-level `directory:`** — the only remaining fail-and-drop path. The task file's own `directory:` fails validation at fire time (e.g. the path does not exist), before anything is dispatched: no agent session exists to trace, so the task file is deleted and the target chat receives `❌ Queue "<name>" task could not start: <detail>`. Fix the configuration and insert again. The rest of the queue is unaffected. (An invalid queue-level `directory:` is different: it is a configuration error, so tasks without their own `directory:` simply stay pending with a warn log until the definition is fixed — see [Fields](#fields).)

- **Session-creation failure** — the synthetic `session.new` (or the follow-up `user.message`) reports a failure, e.g. an invalid/unavailable `model`. The run ends immediately, the task is dead-lettered (with `agentSessionId` only when the session itself had been created), and the target chat receives the real reason, then `Agent session: <id>` (when one exists), then the italic one-liner `*Queue "<name>" task failed · full output: <path>*`. There is no fallback to the channel default model — the follow-up prompt is never sent, so the task cannot silently run on the wrong model. (A bad model is the usual cause; treat the `model` field as "pin it and verify the first task succeeded on the intended model".)
- **Runtime error** — a terminal `error` event during the run dead-letters the task and delivers the same notice format — the error reason first, then the agent-session line, then the italic one-liner. The partial transcript is **not** inlined; it stays in the kept accumulation file the suffix references.
- **Timeout** — the run exceeds its wall-clock limit (the queue's `timeout` front matter, 5-hour default): the controller tears down the run's agent session — the agent process is terminated (SIGTERM, then SIGKILL if it does not exit), not merely turn-aborted, so a timed-out agent cannot keep running headless — writes the history line, dead-letters the task file (`reason: timed out after Xms`), and delivers the notice (`timed out after Xms`, the agent-session line when a session exists, then the italic one-liner). The partial transcript is **not** inlined; it stays in the kept accumulation file. The cleanup chain is deliberately ordered so it cannot be wedged by a hung bridge→agent dispatch: local steps (history, dead-letter write) happen first, the release is dispatched **without waiting for it** to finish, and an unexpected failure anywhere just logs an error instead of silently abandoning what is left to do. Known limitation: processes the agent spawned outside its own process group (e.g. workers launched via tmux) are not killed by the teardown.

**Re-running a failed task:** `agent-bridge queue retry <queue-name> <task-id>` — only a `state: failed` task can be retried. The command performs one atomic write: `state:` goes back to `pending` and the `failedAt` / `reason` / `agentSessionId` lines are removed, leaving a file that looks freshly enqueued (the original `enqueuedAt` is kept). The controller then consumes it on its next tick like any pending task — retry only flips the state, nothing runs inside the CLI. Alternatively, edit the task file by hand (set `state: pending`, delete the three failure lines).

### Zombie running files: logged, kept for the restart reset

If a cleanup chain ever dies between removing the run from memory and its final file write (e.g. a permanently hanging dispatch stalled the chain, or the dead-letter write itself failed), the task file can stay `running` with no live run. Every tick reconciles each owned, enabled, bound queue: such a file is **logged** (`... is stranded running with no active run; leaving it for the next start's reset ...`) and **kept** — under dead-letter semantics deleting it would destroy the very record the failure trace exists to preserve. It is never silently re-queued here either: the next channel start's at-least-once reset (see below) is what re-queues it, or you can delete/fix the file by hand.

Two protections keep this reconciliation away from healthy work:

- A run that ended less than two ticks ago is skipped — its normal cleanup chain may simply still be mid-flight (ticks and run timers are independent, so they can interleave).
- Files stranded `running` by a channel stop are untouched: they belong to the next start's at-least-once reset (see below).

Queues that are not consumed right now (disabled, unbound, or owned by another channel) are skipped too, as are `pending` and `failed` files — the reconciliation only ever looks at stranded `running` files.

### Restart semantics: at-least-once

The controller starts and stops with the channel. On stop, in-flight runs are simply forgotten; their task files stay `running`. On the next start, every `running` task is reset to `pending` and re-fired — a task in flight at shutdown is re-executed (at-least-once). No notice is sent for the interruption, and nothing is delivered after stop. `failed` tasks are untouched by the restart reset: they only ever come back via `queue retry`.

### Concurrency and ordering

With `workers: 1` tasks run strictly one at a time, oldest first. With `workers > 1`, up to `workers` tasks run concurrently and results are delivered in **completion order** — a later-inserted task may finish (and be delivered) before an earlier one. That is expected behavior, not a bug; FIFO order applies to *starting* tasks, not to delivering results.

### Unbound queues pile up

A queue with no `target` (and no `channel`) is never consumed: it belongs to no controller, tasks accumulate (each `queue insert` succeeds, with a warning), and `queue list` shows `Bound: no` and `Channel: -`. Once `/queue-here` binds a chat — writing both the channel and the target — the backlog drains automatically: the controller picks up the oldest pending tasks on the next tick.

### Disabled queues pause, tasks pile up

`agent-bridge queue disable <queue-name>` (or setting `enabled: false` in the file, e.g. by asking the agent to edit it) pauses consumption: the controller skips the queue entirely — pending tasks stay `pending` and untouched, in-flight runs are unaffected and deliver normally. `queue list` shows `Enabled: no`. `agent-bridge queue enable <queue-name>` (or editing the file back) resumes on the next tick and drains the backlog automatically. Disabling is a persistent switch: it survives restarts and never auto-re-enables.

### Hot reload: edits are picked up within 30 seconds

The controller reloads queue definitions on every tick, so:

- **Edited body (shared context)** → used for every task fired after the next tick.
- **Edited front matter** (`workers`, `silence`, `model`, `target`, `enabled`) → effective on the next tick; no channel restart needed.
- **New or deleted task files** → appear/disappear on the next tick. Deleting a task file mid-run does not interrupt the in-flight run.
- There is no file-system watching; 30 s polling is cheap and predictable.

## Troubleshooting

**I inserted a task but nothing arrived — did I bind the queue?**
Run `agent-bridge queue list` — the `Bound` column shows `no` for unbound queues (and the `Channel` column shows `-`), and `Pending` shows the waiting tasks. Send `/queue-here <queue-name>` *in the destination chat* (the channel is set to that chat's channel at bind time). If the queue is already bound to another chat, remove the `target` line from its file first.

**The task failed with a model error.**
The `model` field is not validated at insert time — an invalid or unavailable model fails at session creation, which dead-letters the task with the adapter's error detail in the failure notice. Fix the `model` line in the queue file (or remove it to use the channel default), then run `agent-bridge queue retry <queue-name> <task-id>` — the task re-enters the queue and runs on the next tick.

**The target chat was deleted IM-side.**
Delivery goes through the normal egress path, so a deleted chat fails like any other send failure: it is logged by the bridge (the task run itself has already completed or timed out). Fix the `target` line and the next task delivers normally.

**The queue was unbound when I inserted tasks, and now it's bound — nothing ran?**
Backlog drains on the next tick after binding, up to the queue's worker capacity per tick (a new task can start as soon as a worker slot frees up, checked every 30 s). A 1-worker queue with a long backlog drains one run at a time.

**A task ran twice after a restart.**
That's by design: tasks in flight at shutdown are re-enqueued and re-run (at-least-once). If your task is not idempotent, give it a durable marker (e.g. "write `last-run.md` when done, skip if it exists").

**Still stuck?**
Check in order: is the queue listed by `queue list` (invalid `workers`/`silence` definitions are skipped with a log; an unbound queue shows `Channel: -`)? Is `Bound` `yes`? Is the owning channel running? Was the change recent (front matter and task files take effect on the next 30 s tick)? Check the bridge's logs — load skips, fire failures and delivery errors are logged under the `[queue]` scope.
