# Scheduled Tasks

Scheduled tasks let you run an agent on a recurring schedule without touching a chat manually.

A task is a Markdown file that declares **when** to run (a schedule string), **where** to run (a working directory), **how long** a run may take (a timeout), **which channel owns it** (a channel field), **where to send the result** (a target chat), and—optionally—**which agent model** to run (a model field). When the schedule fires, the bridge creates a **fresh, fully independent agent session**, sends the task's prompt into it, and delivers the agent's final answer — or a failure/timeout notice — into the target chat as an ordinary message. The run's **full transcript is kept in a local file** under `run-outputs/` (shared with event queues) and every delivered message references that file, so you can always read the whole run.

The most important property is **isolation**: a task run never touches the target chat's own agent session. You can keep chatting in that chat before, during, and after a run and nothing about your session changes. The chat is only used as a delivery address.

## Quick start

1. Create the task with the CLI wizard:

   ```bash
   agent-bridge schedule add
   ```

   The wizard asks, in order:

   - a task name (lowercase letters, digits and hyphens only, e.g. `daily-report`; names are globally unique — there is no channel selection),
   - a schedule string (validated against the grammar below, re-prompted on error, with examples shown),
   - an optional working directory (blank = the bridge process's current directory),
   - a timeout (default `10m`),
   - an optional model (blank = the channel agent config's default model; it is not validated — the CLI can't reach provider model lists, so an invalid value only surfaces when the task runs; see [How a run works](#how-a-run-works) for the exact failure behavior).

   It writes a task file with an example prompt body, prints the file path, and prints the targeting instruction.

2. Edit the task file to set the real prompt (see [Task file format](#task-file-format)).

3. Point the task at the destination chat with `/schedule-here`. Send this **in the chat that should receive the result**:

   ```text
   /schedule-here daily-report
   ```

   The adapter binds that chat as the task's delivery target: it writes the chat's client session id into the task file's `target` line and this channel's config name into the `channel` line, then replies `Task "daily-report" will send its results to this chat.` No copying or manual editing is needed. (A task that is already bound — its file has a `target` or `channel` line — is refused; see [Changing the destination chat](#changing-the-destination-chat) to move it.)

4. Verify it end-to-end immediately instead of waiting for the schedule:

   ```text
   /schedule-run daily-report
   ```

   in any chat of the channel. The task runs now — through the exact same path as a scheduled fire — and the result lands in the target chat.

### Changing the destination chat

A bound task cannot be rebound with `/schedule-here` (it is refused with `Task "daily-report" is already bound to a chat.`), so moving a task to another chat is a two-step operation: unbind it first — remove the `target` and `channel` lines from the front matter (ask the AI in its current bound chat to edit the file, or edit by hand — there is no `/schedule-unbind` command) — then send `/schedule-here <task-name>` in the new chat. If you prefer to edit by hand instead, change the `target` line to the new chat's session id (and the `channel` line if the new chat belongs to a different channel). To copy a chat's session id:

1. Send `/st` in the chat that should receive the result. The status reply includes a **Chat session ID** line:

   ```text
   Chat session ID: `feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc`
   ```

2. Paste that value into the `target` field of the task file.

Either change is effective on the next 30 s tick — no channel restart needed.

## Task file format

Tasks live in a single flat directory shared by all channels:

```
~/.config/agent-bridge/schedules/<task-name>.md
```

Task names are **globally unique** across all channels: the file name (without `.md`) is the task's key and must match `[a-z0-9-]+` (lowercase letters, digits and hyphens). The owning channel is recorded in the front-matter `channel` field (see below), not in the directory layout. Files whose names are not valid task names are skipped with a warning. Legacy per-channel subdirectories (`schedules/<channel>/`) are no longer read and are not migrated.

The file is front matter plus a prompt body:

```markdown
---
schedule: daily 09:00
directory: ~/reports
timeout: 30m
silence: 10m
enabled: true
channel: feishu-dev
target: feishu:dm:oc_6f9d408e630098e6dd06bb071d6b60fc
model: azure-openai-responses/gpt-5.6-terra
---

Read the logs in the current directory and produce a summary of
yesterday's errors.
```

- **Front matter** is a flat `key: value` subset (no YAML): one key per line, values are bare strings (surrounding single or double quotes are stripped), lines starting with `#` and blank lines are ignored. Unknown keys produce a warning. A line that is not `key: value` is ignored with a warning.
- **The body** (everything after the closing `---`, trimmed) is the prompt sent to the agent on every fire. It must be non-empty.
- A file that does not start with a `---` line has no front matter and the whole file is treated as the body — such a task has no schedule and never fires (it is listed with an error, see below).

### Fields

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `schedule` | yes | — | Schedule grammar string (see below). Missing or invalid → the task is listed with an error and never fires. |
| `directory` | no | bridge process cwd | Working directory of the new session. `~` is expanded, relative paths resolve against the bridge process cwd, and the path is canonicalized (`realpath`) and checked at fire time — it must exist, be a directory, and be readable. An invalid directory prevents the fire and an error is sent to the target chat. |
| `timeout` | no | `10m` | Max run duration: `<n>s`, `<n>m` or `<n>h` (e.g. `90s`, `10m`, `1h`). The run is killed when exceeded and the target chat receives a timeout notice. An invalid value is listed as an error and the default is used. |
| `silence` | no | `10m` | Silence window before a probe is sent into the run: same duration syntax as `timeout`. After this many minutes with no observable run activity, the scheduler asks the run whether it is finished (see [A run completes on DONE or ends by timing out](#a-run-completes-on-done-or-ends-by-timing-out)). An invalid value is listed as an error and the default is used. |
| `enabled` | no | `true` | `false` (case-insensitive) pauses the task without deleting the file. Any other value or absence means enabled. |
| `target` | no | — | Delivery address: the destination chat's clientSessionId. The recommended way to set it initially is `/schedule-here <task-name>` sent in the destination chat; the manual way is to copy the **Chat session ID** line from `/st` in that chat (see [Changing the destination chat](#changing-the-destination-chat)). Required for delivery — without it (or when it fails validation, e.g. a typo or a chat from another channel) the fire is skipped, the skip is logged, and `schedule list` shows `Target: no`. |
| `channel` | no | — | Owning channel config name, written by `/schedule-here <task-name>` together with `target`. Each channel's scheduler fires on schedule only tasks whose `channel` matches that channel; a task with no `channel` line never fires on schedule (but can still be triggered manually with `/schedule-run`, see below). |
| `model` | no | — | Optional per-task agent model override. Only this task's own runs use it — the channel's chat sessions are unaffected on pi, and on opencode chat `/new` only gains the same availability check against the channel config model (see the per-task model design spec, `docs/scheduled-task-model-spec.md`). Precedence: task `model` > channel agent config's `model` > env/adapter default. Blank or absent = the channel agent config's model. Parsing only checks for a non-empty string; validity is enforced at fire time by the adapter: **pi** passes it to the pi process as `--model` at spawn (an invalid model makes the process fail at startup), **opencode** runs its availability check against the effective (override-first) model and refuses to create a session. Applies to scheduled fires and `/schedule-run` alike, since both share one fire path. |

`schedule add` writes the front matter with `schedule`, `directory` (only if you entered one), `timeout` and `model` (only if you entered a non-empty one), plus the example prompt body. It does not write `enabled` (absent means enabled), `target` or `channel` — the `target` and `channel` lines are meant to be set with `/schedule-here <task-name>` (or, for later manual edits, pasted from the `/st` output), and the body is meant to be replaced with your real prompt. The wizard does not offer a `silence` prompt — that field is set (and tuned) by editing the file, defaulting to `10m`.

## Schedule grammar

Four forms, in the **local timezone of the bridge process**, with **minute granularity**. Parsing is case-insensitive and tolerates surrounding whitespace.

```
every <n><unit>          unit: m (minutes), h (hours) or d (days); n >= 1
daily HH:MM              every day at the given wall-clock time
weekly <day> HH:MM       day: mon, tue, wed, thu, fri, sat, sun (case-insensitive)
monthly <day-of-month> HH:MM   1..31; short months clamp to their last day
```

Examples:

```text
every 5m
every 2h
every 1d
daily 09:00
weekly mon 09:00
monthly 15 09:00
```

Semantics:

- `every <n><unit>` repeats every `n` units. The first fire is scheduled one interval after the scheduler picks the task up — at channel start for tasks that already exist, otherwise at the next reload tick — not at a fixed clock time.
- `daily` / `weekly` / `monthly` fire at the next occurrence of the given local wall-clock time. `monthly 31` in a short month clamps to that month's last day (e.g. February 28 or 29).
- `HH:MM` accepts hour `0–23` and minute `0–59`.
- Invalid strings are rejected at `schedule add` time (you are re-prompted, with examples shown), and a task whose loaded schedule is invalid is listed with an error and never fires.

## How a run works

### Each fire creates a fresh, isolated session

On every fire the scheduler injects two synthetic events through the same ingress path ordinary chat messages use:

1. a `command.session.new` with the task's working directory (validated; the operator-configured path is trusted, like the cwd fallback) and, when the task has a `model` field, that model — the override rides the same event into the agent-session creation, so only this task's run uses it;
2. a `user.message` with the task's prompt — the whole file body is the task's prompt, wrapped with a fixed completion-protocol instruction block (see [A run completes on DONE or ends by timing out](#a-run-completes-on-done-or-ends-by-timing-out)).

Both carry a synthetic, run-unique client session id of the form `schedule:<task-name>:<run-seq>`. The core treats it like any other session, with two deliberate exceptions:

- **Bindings are memory-only**: `schedule:*` bindings are never written to the channel state file (a unique id per run would grow the file forever, and ephemeral runs have no resume semantics anyway).
- **No confirmation**: the usual "Started a new session" reply is suppressed for task runs — it would be mistaken for the task result.

Because the synthetic id never collides with a real chat's clientSessionId, the target chat's own session binding is never touched. Event queues reuse this exact synthetic-session machinery under `queue:<queue>:<taskId>` ids (same divert, memory-only bindings and orphan guard; see `docs/event-queue.md`).

### A run completes on DONE or ends by timing out

Assistant output no longer ends a run on its own: **a run completes only when the agent signals it is done.** Each fire wraps the task's prompt with a fixed completion-protocol instruction block, and every assistant message during the run is accumulated into a per-run local file under `run-outputs/` (shared with event queues; see `docs/event-queue.md`). A run ends for exactly one of two reasons:

1. **Completion (the DONE marker)** — the agent finishes its final `assistant.message` with the marker line `BRIDGE_TASK_STATUS_DONE` as its last line. The scheduler strips that line and delivers **only that last message** to the target chat exactly once, as a normal `assistant.message` — **content first, then a trailing italic one-liner** naming the task and its kept transcript file (no prefix header):

   ```text
   <the run's last assistant message>

   *Scheduled task "daily-report" completed · full output: ~/.config/agent-bridge/run-outputs/schedule_daily-report_3.md*
   ```

   Attachments and formatting from every accumulated message still go with the delivery (they are real deliverables). The **full transcript stays in the accumulation file** at `run-outputs/<run-id>.md` (kept after delivery — it is the pointer the suffix references) and is *not* inlined. A last message that is empty or whitespace-only is delivered as the italic one-liner `*Scheduled task "name" finished with no output · full output: <path>*` instead of silence. A marker in an intermediate (non-last) line is *not* a completion signal — the message is accumulated like any other.
2. **Timeout** — the run exceeds the task's `timeout` (default `10m`): the scheduler aborts that run's session and delivers the italic one-liner `*Scheduled task "name" timed out · full output: <path>*` to the target chat. The partial transcript is **not** inlined — it stays in the kept accumulation file the suffix references.

A terminal `error` during the run ends it immediately and delivers the error detail followed by the italic one-liner `*Scheduled task "name" failed · full output: <path>*`. The partial transcript is **not** inlined — it stays in the accumulated file.

**The completion protocol.** The instruction block appended to every task prompt tells the agent: to work until the task is *fully* complete, including async follow-ups it is still waiting on (background jobs, sub-agents, external callbacks); to append `BRIDGE_TASK_STATUS_DONE` as the **last line of its final message, and only then** — never in intermediate messages; and to answer honestly if asked whether it is finished, appending the marker only when it truly is. So a task waiting on asynchronous work should simply **not emit DONE until its callbacks return** — nothing else is needed; the run just stays alive and keeps accumulating.

**The silence probe.** After `silence` minutes (front matter, default `10m`) without any observable run activity, the scheduler sends a probe message into the run session asking whether the task is finished (reply DONE, or keep working / keep waiting for async callbacks). Any run event — an assistant message, tool progress, or a probe answer — resets the silence window. The probe Q&A is accumulated like any other message and is included in the kept transcript file (it is not inlined in the delivered message, which carries only the last assistant message). An unanswered probe is harmless: the wall-clock `timeout` remains the only hard cap on the run.

Fire-time validation failures behave like failures: if the working directory is invalid or the prompt is empty, **nothing is injected**; the target chat receives `❌ Scheduled task "name" could not start: <detail>` and the fire is logged. If the task has no valid `target`, there is nowhere to deliver to — the fire is skipped and only logged, and `schedule list` shows `Target: no`.

**A typo'd or unavailable `model` is not part of that fire-time check.** It is validated by the adapter when the session is created (pi: passed to the pi process as `--model` at spawn, fail-fast if the process exits; opencode: an availability check that refuses to create the session). When session creation fails, the fire **fails** rather than falling back: the run ends immediately and the target chat receives the adapter's error detail followed by the italic one-liner `*Scheduled task "name" failed*`, and a manual `/schedule-run` reports the real reason in its reply. There is no fallback to the channel default model — the follow-up prompt is never sent, so the task cannot silently run on the wrong model. (A task with no valid `target` has nowhere to receive the notice; such a fire is skipped and only logged.) Treat the `model` field as "pin it and verify the first `/schedule-run` succeeded on the intended model" — a typo now fails loudly and visibly instead of silently burning the default model's budget.

### Hot reload: edits are picked up within 30 seconds

Every channel's scheduler re-scans the shared schedules directory (all channels' tasks) on a short fixed tick (30 s) and re-syncs its in-memory table. Each scheduler fires on schedule only the tasks whose front-matter `channel` matches that channel — tasks owned by other channels, and tasks with no `channel` line, are never fired on schedule by it:

- **Edited prompt body** → the file is re-read at fire time, so the new body is used on the next fire.
- **Edited front matter** (schedule, timeout, silence, directory, enabled, target, channel) → effective on the next tick; no channel restart needed.
- **New or deleted files** → tasks appear/disappear on the next tick. Deleting a file mid-run does not interrupt the in-flight run.
- There is no file-system watching; 30 s polling is cheap and predictable.

### Missed fires are not made up

A fire that was missed while the channel was stopped is skipped. Next-run times are recomputed from the current clock (when the channel starts and after every fire), so `daily 09:00` fires at the next local 09:00 whatever happened in between, and a delayed tick fires a task at most once (no bursting).

### Concurrency

Every fire unconditionally starts a fresh run — runs never interact and there is no overlap policy. If the schedule interval is shorter than the run duration (e.g. `every 1m` with `timeout: 30m`), several runs of the same task can be alive concurrently. Each run has its own synthetic session id and its own timeout timer, so results can never cross — but concurrency costs resources. Choose an interval comfortably larger than the expected run duration.

### Lifecycle

The scheduler runs per channel and starts/stops with the channel. Stopping a channel clears all timers; in-flight task sessions shut down through the normal core teardown. A channel restart mid-run loses the run (no resume in phase 1), and because `schedule:*` bindings are memory-only, a restart leaves no residue in the state file.

## `/schedule-run <task-name>`

Trigger a task immediately, in any chat of the channel:

```text
/schedule-run daily-report
```

- The command is handled locally by the client adapter and never reaches the core. The command name is case-insensitive and the task name is normalized to lowercase, so `/schedule-run DailyReport` triggers the `dailyreport` task.
- The task name must match `[a-z0-9-]+`; anything else (including a missing name) gets a usage hint.
- The trigger chat is only the *request* origin — the result always goes to the task's `target`. Any chat of the channel may trigger any of its tasks.
- The trigger is refused for a task bound to a **different** channel: `Scheduled task "daily-report" belongs to channel "wecom-main". Please run it from that channel.` A task with no `channel` line (a legacy/manual file) is not refused — it can still be triggered manually from any channel whose target validation accepts its `target`.
- The run is identical to a scheduled fire: a fresh, isolated, timeout-bounded run.
- The trigger chat receives a localized reply: "Task "name" has been triggered. The result will be sent to its target chat." on success, or a specific reply when the task is unknown, disabled, or has no valid target chat, or a generic failure message with the reason.

## `/schedule-here <task-name>`

Bind this chat as a task's delivery target in one step — send it **in the chat that should receive the task's results**:

```text
/schedule-here daily-report
```

- The command is handled locally by the client adapter and never reaches the core. The command name is case-insensitive and the task name is normalized to lowercase, so `/schedule-here DailyReport` binds the `dailyreport` task.
- On success the chat's `clientSessionId` is written into the task file's `target` line, together with this channel's config name in the `channel` line, and the chat receives `Task "daily-report" will send its results to this chat.`; when the task is unknown the reply is `Scheduled task "daily-report" was not found.`, and any other failure replies with a generic failure message carrying the reason.
- The task name must match `[a-z0-9-]+`; anything else (including a missing name) gets a usage hint. A task that is already bound — its file has a `target` or a `channel` line — is refused: `Task "daily-report" is already bound to a chat. To rebind it, remove the target/channel lines from its task file (ask the AI in its current bound chat, or edit the file manually).` There is no `/schedule-unbind` command: unbinding is an intentional file edit.

## CLI

| Command | What it does |
| --- | --- |
| `agent-bridge schedule add` | Interactive wizard: name the task (globally unique — no channel selection), enter the schedule (validated, with examples), optionally set the working directory, timeout and a per-task model, then write the task file with an example prompt and print the targeting instruction. |
| `agent-bridge schedule list` | Table of every task across all channels: Task, Schedule, Enabled (`yes`/`no`), Target (`yes`/`no`), Next run (computed from the grammar at the current clock) and Status (`ERROR:`/`WARN:` notes such as missing schedule, invalid timeout, empty body, unknown keys). |
| `agent-bridge schedule remove <task-name>` | Delete the task file directly. Task names are globally unique, so no disambiguation or `--channel` option is needed. |
| `agent-bridge schedule history [task-name]` | Newest-first table of finished runs (Time, Name, Outcome, Duration, Reason, File) from the run-history index; without a name it lists every task's runs. |

Task files are plain Markdown: diffable, git-trackable, and hot-reloaded — there is no runtime binding state and no channel-state schema change.

## Troubleshooting

**The task fired but nothing arrived in the chat — did I set `target` wrong?**
Send `/schedule-here <task-name>` again *in the destination chat*; if you edit `target` by hand, it must be the exact **Chat session ID** line from `/st` sent *in that chat*. A typo, a chat id from another channel (the platform prefix won't match, e.g. a `wecom:` id in a feishu task), or a missing line all mean the fire is skipped and only logged. Run `agent-bridge schedule list` — the `Target` column shows `no` for such tasks, and `schedule-run` replies "has no valid target chat configured". Note that `/schedule-here` only binds a task that is not yet bound — to re-point an already bound task, remove its `target`/`channel` lines first.

**The target chat was deleted IM-side.**
Delivery goes through the normal egress path, so a deleted chat fails like any other send failure: it is logged by the bridge (the task run itself has already completed or timed out). Fix the `target` line and the next fire delivers normally.

**The task did not fire at all.**
Check in order:

1. `agent-bridge schedule list` — is the task listed? Is `Enabled` `yes`? Is `Next run` a real time rather than "invalid schedule"? Are there `ERROR:`/`WARN:` notes in `Status`?
2. Is `target` set (`Target: yes`)? Without it the fire is silently skipped by design.
3. Does the task's file carry a `channel` line matching a running channel? Only tasks whose `channel` line matches a channel fire on schedule — an unbound task (no `channel` line) never fires; bind it with `/schedule-here` first. (`schedule list` no longer shows a Channel column; ownership lives in the file.)
4. Was the change recent? Front matter edits and new/deleted files take effect on the next 30 s tick; the prompt body is read at fire time.
5. Is the channel running? A stopped channel never fires, and missed fires are not made up on restart.
6. Check the bridge's logs — fire failures, invalid-directory skips, no-target skips and delivery errors are logged under the `[schedule]` scope.

**I moved the result to another chat.**
Unbind the task first — remove the `target` and `channel` lines from the file (there is no `/schedule-unbind` command) — then send `/schedule-here <task-name>` in the new chat; or edit the `target` (and `channel`) line manually. The change is effective on the next tick; no restart needed. A task with no `target`/`channel` lines skips fires and `schedule list` shows `Target: no`.
