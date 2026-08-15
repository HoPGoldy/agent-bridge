# Command System

`agent-bridge` keeps the IM-side command surface intentionally small.

All client adapters use the same command parser, so the command behavior is consistent across:

- Feishu / Lark
- WeCom
- Weixin

## Supported commands

| User input | Meaning | Internal event |
| --- | --- | --- |
| `/new` | Start a fresh agent session for the current chat (reusing the chat's remembered directory, if any) | `command.session.new` |
| `/new <path>` | Start a fresh agent session whose working directory is `<path>`, and remember `<path>` as this chat's default | `command.session.new` with `workingDirectory` |
| `/n` | Alias of `/new` | `command.session.new` |
| `/n <path>` | Alias of `/new <path>` | `command.session.new` with `workingDirectory` |
| `/compact` | Ask the current agent session to compact its context | `command.session.compact` |
| `/c` | Alias of `/compact` | `command.session.compact` |
| `/stop` | Stop the current in-flight agent run, if the agent supports stopping | `command.session.stop` |
| `/s` | Alias of `/stop` | `command.session.stop` |
| `/status` | Query the current agent session runtime status | `command.session.status` |
| `/st` | Alias of `/status` | `command.session.status` |
| `/model` | List available models for the current active agent session | `command.session.model.list` |
| `/m` | Alias of `/model` | `command.session.model.list` or `command.session.model.set` |
| `/model provider/modelId` | Switch the current active agent session model | `command.session.model.set` |
| `/help` | Show the built-in command help for the current client locale | Local client-side help response |
| `/h` | Alias of `/help` | Local client-side help response |

## How parsing works

The parser is deliberately strict and predictable:

1. The inbound message text is trimmed.
2. Zero-argument commands must match a supported command exactly.
3. `/new` and `/n` additionally support an optional argument tail, interpreted as the working directory for the new session.
4. `/model` and `/m` additionally support a single argument tail, interpreted as the target model string.
5. Matching is case-insensitive for the command name. The working directory tail is trimmed of leading/trailing whitespace but otherwise preserved exactly as typed (including case, internal spaces, and Unicode).

That means these are valid:

- `/new`
- `/new /Users/wesley/project-a`
- `/new ./demo`
- `/new ../up`
- `/new ~/project-a`
- `/new /Users/wesley/My Project`
- `/new /Users/wesley/中文项目`
- `/n`
- `/n /tmp/demo`
- `/compact`
- `/c`
- `/stop`
- `/s`
- `/status`
- `/st`
- `/model`
- `/m`
- `/model anthropic/claude-sonnet-4-5`
- `/m openai/gpt-5`
- `/New /Users/Wesley/MyProject`
- `/Compact`
- `/C`
- `/S`
- `/Status`
- `/ST`
- `/Model`
- `/M anthropic/claude-sonnet-4-5`
- `/help`
- `/h`
- `/HELP`
- `/H`

And these are **not** treated as commands:

- `/compact now`
- `/status now`
- `/help me`
- `hello /n`
- `hello /model anthropic/claude-sonnet-4-5`
- `-n`
- `-c`

> Note: `/new please` is a **valid** command. The parser treats everything after `/new` as the working directory argument, so `please` is interpreted as a relative directory. It is only rejected later if the path cannot be resolved (for example, a missing directory). Keep this in mind if you ever type `/new` followed by words that are not a path.

## Why exact-match only (except argument tails)

The bridge does not try to do fuzzy command extraction from normal chat text.

This avoids accidental command execution when users are just talking naturally, and it keeps the adapter contract simple: a message is either:

- a command message, or
- a normal user message

Only `/new`/`/n` and `/model`/`/m` accept an argument tail. All other commands must match exactly.

## Runtime behavior

### `/new`

`/new` and `/n` detach the current chat from any previous agent session and create a fresh one.

`/new <path>` and `/n <path>` do the same, but the new session is started with `<path>` as its working directory instead of the agent-bridge process's current directory.

#### Working directory resolution (client side)

The client adapter — not the agent backend — always resolves a concrete working directory before emitting the command. The resolution order is:

1. **Explicit argument**: `/new <path>` validates `<path>` locally (see below), uses the canonical directory, and remembers it in the chat's client session state (per-channel store, keyed by chat).
2. **Remembered default**: a bare `/new` reuses the last directory explicitly given in this chat, including after a bridge restart. The remembered directory is re-validated before use; if it went stale (deleted or unmounted), the command is rejected with an explanatory reply instead of silently falling back.
3. **Fallback**: when nothing is remembered, the agent-bridge process's current working directory is used.

#### Client-side validation

`/new <path>` is validated by the client adapter **before** any event is emitted: `~` is expanded, relative paths resolve against the bridge process cwd, and the target is canonicalized with `realpath` and must exist, be a directory, and be readable/enterable by the bridge process.

- **Valid** → the `command.session.new` event is emitted with the canonical directory, and that directory is remembered as the chat's default.
- **Invalid** → the user gets a localized error reply, no event is emitted, the previous session stays untouched, and **nothing is remembered**.

This local check is a UX pre-check, not the security boundary: the agent-side allowlist (`defaults.allowedWorkingDirectoryRoots`) is still enforced by the agent backend. It assumes the agent runtime shares the bridge's filesystem — see the deployment note in [`docs/opencode.md`](./opencode.md).

The emitted `command.session.new` event therefore always carries a `workingDirectory`, plus a `workingDirectorySource` trust classification:

- `user` — an explicit argument or a remembered default (which was originally user-supplied). User-sourced paths stay subject to the agent-side allowlist (`defaults.allowedWorkingDirectoryRoots`), on create and on resume.
- `default` — the client-side cwd fallback. It is trusted, never allowlist-checked, and the agent backend may still prefer its own configured directory (OpenCode's channel-level `directory` takes precedence over the fallback).

The user will receive a confirmation reply that names the resolved directory:

```text
Started a new session (working directory: /Users/wesley/project-a).
```

#### Working directory semantics

Path interpretation differs per agent backend:

| Concern | PI Coding Agent | OpenCode |
| --- | --- | --- |
| Absolute paths | Supported | Supported |
| Relative paths | Resolved against the agent-bridge process cwd | Resolved against the agent-bridge process cwd (client-side validation; see the deployment note in [`docs/opencode.md`](./opencode.md)) |
| `~` / `~/...` | Expanded against the bridge user's home directory | Expanded against the bridge user's home directory (client-side validation) |
| Spaces / Unicode | Supported | Supported |
| Shell-style env vars (`$HOME`) | Not expanded | Not expanded |
| Validation | Client-side pre-check, then `realpath` canonicalization again agent-side; target must exist, be a directory, and be readable/enterable | Client-side pre-check in the bridge; the directory is then forwarded to the server |

Because `/new <path>` is validated against the bridge's local filesystem, running the OpenCode Server on a different host or inside a container is **not recommended**: the local check can reject paths that only exist on the server (or vice versa).

For predictable behavior across both backends, **prefer absolute paths**:

```text
/new /Users/wesley/project-learn/demo
```

The working directory is persisted in the agent session's own state record (the routing binding itself only stores `clientSessionId -> agentSessionId`). When a session is released after the idle timeout or the bridge restarts, the saved working directory is restored along with the agent session, so the agent keeps operating on the same directory. Independently, the chat's remembered `/new` default lives in the client session's own state record (`clientSessions`), so a bare `/new` after a restart still targets the directory the user last chose.

#### Creation failure keeps the previous session

`/new` is transactional: the new session is created and started **before** the previous session is stopped. If the new session cannot be created — for example the working directory does not exist, is not a directory, is not readable, or is outside the configured allowlist — the previous session, its binding, and its running agent stay untouched, and the user receives:

```text
Failed to start a new session: <detail>
```

#### Security: allowlist

A user-supplied working directory can point anywhere the agent-bridge process can access. If the bot is not strictly private, restrict the directories sessions may start in with `defaults.allowedWorkingDirectoryRoots` in `~/.config/agent-bridge/config.json`:

```json
{
  "defaults": {
    "allowedWorkingDirectoryRoots": [
      "/Users/wesley/project-learn",
      "/Users/wesley/work"
    ]
  }
}
```

- When the key is absent or an empty array, the bridge is permissive.
- When configured, a user-supplied working directory must resolve to the root itself or a strict subdirectory of one of the roots.
- The check is enforced by each provider: PI canonicalizes with `realpath` before the boundary check, so symlinks cannot escape an allowed root; OpenCode performs a lexical-only check in the bridge (an absolute path must be inside a root), and the remote server remains responsible for filesystem-level safety.
- When roots are configured, OpenCode overrides must be absolute paths (a relative path would be resolved by the server, which the bridge cannot verify).
- `default`-sourced directories (the client-side cwd fallback for a bare `/new`) and the channel-level configured `directory` are trusted configuration and are **never** checked against the user-path allowlist. A remembered `/new` default keeps its original `user` classification and stays checked.

See [`docs/pi-coding-agent.md`](./pi-coding-agent.md) and [`docs/opencode.md`](./opencode.md) for backend-specific details.

### `/compact`

`/compact` and `/c` send a compact request to the current active agent session.

If there is no active session yet, the bridge replies with:

```text
No active agent session to compact.
```

### `/stop`

`/stop` and `/s` forward an abort request to the current agent adapter without first checking whether it reports itself as busy. If there is no active session, the bridge returns a short explanatory message instead of failing silently.

### `/status`

`/status` and `/st` query the current agent session runtime state.

When available, the response includes structured status information such as:

- current session id
- current model
- thinking level
- current context usage

Architecturally, this is a session/runtime command, not a normal user message:

- client adapters parse `/status` / `/st` into `command.session.status`
- `GatewayCore` routes the request to the active agent runtime
- the agent adapter returns structured status data
- the client adapter renders that structured data into localized markdown/text for the IM platform

If there is no active agent session, or the current agent adapter cannot provide runtime status, the bridge returns a structured unavailable/error event and the client adapter renders it for the user.

### `/model`

`/model` and `/m` have two related behaviors:

- `/model` or `/m`
  - query the available models for the current active agent session
- `/model provider/modelId` or `/m provider/modelId`
  - switch the current active agent session model

Architecturally, both are session/runtime commands:

- client adapters parse them into `command.session.model.list` or `command.session.model.set`
- `GatewayCore` routes the request to the active agent runtime
- the agent adapter either returns a structured model list or performs the model switch
- the client adapter renders the structured result into localized markdown/text for the IM platform

Current runtime behavior:

- model listing requires an active agent session
- model switching requires an active agent session
- model switching is rejected while the current agent runtime is busy
- v1 switching expects the target format `provider/modelId`

### `/help`

`/help` and `/h` are handled locally by the client adapter and return a built-in help message in the configured channel language.

This help text currently lists:

- `/new [path]` (`/n [path]`)
- `/compact` (`/c`)
- `/stop` (`/s`)
- `/status` (`/st`)
- `/model` (`/m`)
- `/help` (`/h`)

Because this is local client-side help, it does **not** create an agent session, does **not** send anything to `GatewayCore`, and does **not** invoke the agent.

## Adapter-level note

Client adapters should not implement their own platform-specific command grammar unless there is a very strong reason.

The intended design is:

- platform adapters normalize inbound text
- adapters first check the shared local-help helper for `/help` / `/h`
- adapters then call the shared parser for session-control commands
- the parser emits standard `agent-bridge` events
- `GatewayCore` routes those commands to the correct agent session or emits a structured unavailable/error result
- client adapters render user-facing status/help output locally

This keeps command semantics identical across all supported IM platforms while still allowing `/help` to remain a local UI-facing response, `/status` to remain a structured runtime query, and `/model` to remain a structured runtime list/switch command.
