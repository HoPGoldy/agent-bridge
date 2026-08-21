# Scheduled task per-task model — design spec

Status: implemented design source of truth for the `feat/scheduled-task-model`
branch. Grill decisions were made in the 2026-08-18 session
("定时任务支持 per-task 模型指定").

## Goal

A scheduled task can pin the agent model for its runs via a `model` front
matter field. The override affects only the fresh, isolated session created
for that task's runs; it never touches the channel's own chat sessions.

Non-goal: a generic per-session model override for chat — that already
exists as the `/model` slash command.

## Task file format

```markdown
---
schedule: daily 09:00
timeout: 10m
model: azure-openai-responses/gpt-5.6-terra
---

Prompt body…
```

- `model` is optional. Absent (or empty) means the channel agent config's
  model — i.e. the existing `config.model ?? PI_MODEL ?? adapter default`
  resolution is unchanged.
- Parsing only checks non-empty-string-when-present. No format or
  availability validation at load/scan time; validity is enforced at fire
  time (see Failure semantics).

## Fire plumbing

The override rides the existing fire injection path:

1. `task-file.ts` parses `model` into `ScheduleTask.model?: string`.
2. `Scheduler.#fire` puts `model` on the synthetic
   `command.session.new` client event (new optional field in
   `src/types.ts`), alongside the existing working directory fields.
3. `GatewayCore.#handleSessionNew` forwards `event.model` into
   `AgentModule.createAgentSession` as a new optional `model` option.
4. Adapters apply the override with precedence
   `task model > channel config.model > env/adapter default`:
   - **pi-coding-agent**: `buildAdapterOptions` takes the override; the
     resulting `model` is passed to the pi process at spawn, exactly like
     the channel model today. An invalid model fails process startup.
   - **opencode**: the module's `createAgentSession` runs the existing
     `assertModelAvailable` against the *effective* (override-first) model,
     and `#startCreate` passes the effective model to
     `api.createSession({ model })` / `currentModelFromSessionData`.
5. `resumeAgentSession` is untouched: `schedule:*` sessions never resume.

Chat-originated `/new` never sets the field, so the chat model resolution is
unchanged: with no override the effective model is exactly the channel
`config.model` (pi: `config.model ?? PI_MODEL`, as before). The only chat
behavior delta is on **opencode**, where `createAgentSession` now always runs
`assertModelAvailable` against the effective model — for chat that is
`config.model` — adding one `getProviders()` network round-trip per `/new`
and a new early-failure mode when the configured model is currently
unavailable. That is the same fail-fast check this feature documents for
task runs, applied to the existing chat model; pi chat sessions remain
byte-identical.

## Failure semantics (fail-fast, failure notice delivered to the target chat)

**Adapter-level fail-fast is real**: the pinned model never runs unless it
is accepted by the adapter.

- **opencode**: `createAgentSession` runs `assertModelAvailable` against the
  *effective* (override-first) model and throws before any provider session
  is created — a malformed (`provider/modelID` check) or unavailable model
  rejects session creation immediately.
- **pi-coding-agent**: the override is passed to the pi process as `--model`
  at spawn; an invalid/unavailable model makes the pi process exit at
  startup, so `adapter.start()` throws.

**A session-creation failure fails the whole fire** (T6). The core's
ingress (`GatewayCore.input`) never rejects: a failed `session.new`
resolves `{ ok: false, reason }` with the adapter's error message. The
scheduler checks that result and, on failure:

1. ends the run immediately — the follow-up `user.message` is **never**
   dispatched, so there is no way for the core to auto-create a session
   without the task's model override (no silent fallback to the channel
   default model);
2. delivers a localized failure notice to the task's `target` chat
   (`schedule.taskFailed` + the adapter's error detail);
3. returns `{ ok: false, reason }` so a manual `/schedule-run` trigger
   reports the real cause in its reply.

This applies to tick fires and `/schedule-run` alike (they share the one
fire path). Chat-originated `/new` failure behavior is unchanged: the
localized `gateway.failedToStartNewSession` notice still reaches the chat
(its ingress result is ignored by the adapters).

## CLI

`schedule add` gains one optional wizard step: `Model (optional, blank =
channel default)`, after the timeout step. A non-empty answer is written
as the `model:` front matter line; blank writes nothing. The CLI does not
validate the model (it cannot reach provider model lists without adapter
plumbing; a typo makes the session fail fast at fire time — the whole fire
fails with a notice to the task's `target` chat, see Failure semantics).

`schedule list` is unchanged (no Model column).

## Unchanged

- Binding/ownership semantics (`channel`, `target`, tick ownership
  filtering) — orthogonal to this feature.
- `/schedule-run` — uses the same fire path, so a pinned model applies to
  manual runs too.
- i18n — no new user-facing IM strings (the wizard prompt is CLI English,
  consistent with the other `schedule add` prompts).
