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

## How parsing works

The parser is deliberately strict and predictable:

1. The inbound message text is trimmed.
2. The whole message must match a supported command exactly.
3. Matching is case-insensitive.

That means these are valid:

- `/new`
- `/n`
- `/compact`
- `/c`
- `/stop`
- `/s`
- `/New`
- `/Compact`
- `/C`
- `/S`

And these are **not** treated as commands:

- `/new please`
- `/compact now`
- `hello /n`
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

`/stop` and `/s` ask the current agent adapter to abort the active run.

If there is no active session, or no active run to stop, the bridge returns a short explanatory message instead of failing silently.

## Adapter-level note

Client adapters should not implement their own command grammar unless there is a very strong platform-specific reason.

The intended design is:

- platform adapters normalize inbound text
- adapters call the shared parser
- the parser emits standard `agent-bridge` events
- `GatewayCore` handles the actual session behavior

This keeps command semantics identical across all supported IM platforms.
