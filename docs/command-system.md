# Command System

`agent-bridge` keeps the IM-side command surface intentionally small.

All client adapters use the same command parser, so the command behavior is consistent across:

- Feishu / Lark
- WeCom
- Weixin

## Supported commands

| User input | Meaning | Internal event |
| --- | --- | --- |
| `/new` | Start a fresh agent session for the current chat | `command.session.new` |
| `/n` | Alias of `/new` | `command.session.new` |
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
3. `/model` and `/m` additionally support a single argument tail, interpreted as the target model string.
4. Matching is case-insensitive.

That means these are valid:

- `/new`
- `/n`
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
- `/New`
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

- `/new please`
- `/compact now`
- `/status now`
- `/help me`
- `hello /n`
- `hello /model anthropic/claude-sonnet-4-5`
- `-n`
- `-c`

## Why exact-match only

The bridge does not try to do fuzzy command extraction from normal chat text.

This avoids accidental command execution when users are just talking naturally, and it keeps the adapter contract simple: a message is either:

- a command message, or
- a normal user message

## Runtime behavior

### `/new`

`/new` and `/n` detach the current chat from any previous agent session and create a fresh one.

The user will receive a confirmation reply:

```text
Started a new session.
```

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

- `/new` (`/n`)
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
