# PI Coding Agent Setup

This guide explains how to connect `agent-bridge` to [PI Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

## 1. Install PI Coding Agent

PI runs as a separate local CLI process. Install it globally:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Verify that the executable is available:

```bash
pi --version
```

## 2. Configure a provider and model

Start PI interactively and authenticate with a supported provider:

```bash
pi
```

Then run:

```text
/login
```

API-key environment variables such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are also supported. Custom providers and models can be defined in `~/.pi/agent/models.json`; refer to the PI documentation for provider-specific configuration.

Use `/model` inside PI to confirm that the intended model is available before starting `agent-bridge`.

## 3. Add the channel

Run:

```bash
agent-bridge add
```

After configuring the IM client, select `pi-coding-agent` as the agent type. The model is optional:

```text
provider/modelID
```

Leave it empty to use PI's default model.

Start the channel from the workspace that PI should operate on by default:

```bash
cd /path/to/workspace
agent-bridge start <channel-name>
```

By default, the PI adapter uses the current working directory of the `agent-bridge` process as the agent workspace. Any chat can override this per session with `/new <path>` — see [Working directories](#working-directories) below.

## Advanced configuration

The interactive setup currently asks only for the model. These optional fields can also be set in `~/.config/agent-bridge/config.json`. The `agent` block lives under a channel, not at the top level:

```json
{
  "channels": {
    "<channel-name>": {
      "common": { "language": "zh-CN" },
      "client": {
        "type": "<client-type>",
        "config": { "...": "existing client config" }
      },
      "agent": {
        "type": "pi-coding-agent",
        "config": {
          "bin": "pi",
          "sessionDir": "/path/to/pi-sessions",
          "model": "provider/modelID",
          "extraArgs": ["--thinking", "high"]
        }
      }
    }
  }
}
```

Replace `<channel-name>` with the configured channel name. The `common` and `client` blocks are required and must stay intact; a top-level `agent` key would be ignored by the bridge.

| Field | Description |
| --- | --- |
| `bin` | PI executable path. Defaults to `PI_BIN`, then `pi`. |
| `sessionDir` | Session storage used by the bridge. Defaults to `PI_SESSION_DIR`, then `~/.config/agent-bridge/pi-sessions`. |
| `model` | Initial model in `provider/modelID` form. Defaults to `PI_MODEL` when omitted. |
| `extraArgs` | Additional arguments passed when PI is started in RPC mode. Defaults to the space-separated `PI_RPC_EXTRA_ARGS`. |

Prefer the JSON `extraArgs` array when an argument contains spaces.

## Bridge behavior

The adapter starts PI in RPC mode and provides:

- persistent session creation and restoration
- `/new <path>` to start a session in a specific working directory
- messages sent while PI is busy using PI's steering behavior
- `/stop`, `/compact`, `/status`, and `/model`
- reasoning, tool progress, final text, and local attachments
- PI extensions, skills, prompt templates, context files, and packages loaded by the PI process

PI configuration remains owned by PI. Files such as `~/.pi/agent/settings.json`, `~/.pi/agent/models.json`, `AGENTS.md`, and project `.pi` resources continue to work according to PI's normal loading and project-trust rules.

## Working directories

Sending `/new <path>` (or `/n <path>`) starts the next session with `<path>` as the PI working directory and remembers it as the chat's default; a later bare `/new` reuses the remembered directory, falling back to the bridge process cwd only when nothing was ever chosen.

Path handling is performed by the bridge before PI starts:

- absolute paths are used as-is
- relative paths are resolved against the agent-bridge process cwd
- `~` and `~/...` are expanded against the bridge user's home directory
- spaces and Unicode (for example Chinese directory names) are supported
- shell-style environment variables such as `$HOME` are **not** expanded
- the target is canonicalized with `realpath`: it must exist, be a directory, and be readable/enterable by the bridge process, and symlinks are resolved before any allowlist check

Prefer absolute paths for predictable behavior:

```text
/new /Users/wesley/project-learn/demo
```

The working directory is persisted in the agent session state, so it is restored when the session is resumed after the idle timeout or a bridge restart.

If `defaults.allowedWorkingDirectoryRoots` is configured (see [`docs/command-system.md`](./command-system.md)), a user-originated working directory (an explicit `/new <path>` or a remembered chat default) must resolve inside one of the allowed roots. The allowlist check applies only to user-originated paths: the client-side cwd fallback and the channel configuration are trusted and never checked.

## Troubleshooting

### `pi` is not found

Set an absolute executable path in `bin` or export `PI_BIN` before starting the bridge.

### A model is unavailable

Open PI directly, run `/login` and `/model`, and verify the provider credentials. Then restart the channel.

### The agent is using the wrong workspace

Use `/new /path/to/workspace` in the chat to start the next session in a different directory, without restarting the channel. The working directory is persisted in the agent session state and restored on resume. If the bridge process cwd itself should change for all sessions, stop the channel, change to the intended directory, and start it again.

### Project extensions or skills are not loaded

Check PI's project-trust configuration and verify the same resources load when PI is started directly from that workspace.
