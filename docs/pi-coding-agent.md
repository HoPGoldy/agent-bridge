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

Start the channel from the workspace that PI should operate on:

```bash
cd /path/to/workspace
agent-bridge start <channel-name>
```

The PI adapter uses the current working directory of the `agent-bridge` process as the agent workspace.

## Advanced configuration

The interactive setup currently asks only for the model. These optional fields can also be set in `~/.config/agent-bridge/config.json`:

```json
{
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
```

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
- messages sent while PI is busy using PI's steering behavior
- `/stop`, `/compact`, `/status`, and `/model`
- reasoning, tool progress, final text, and local attachments
- PI extensions, skills, prompt templates, context files, and packages loaded by the PI process

PI configuration remains owned by PI. Files such as `~/.pi/agent/settings.json`, `~/.pi/agent/models.json`, `AGENTS.md`, and project `.pi` resources continue to work according to PI's normal loading and project-trust rules.

## Troubleshooting

### `pi` is not found

Set an absolute executable path in `bin` or export `PI_BIN` before starting the bridge.

### A model is unavailable

Open PI directly, run `/login` and `/model`, and verify the provider credentials. Then restart the channel.

### The agent is using the wrong workspace

Stop the channel, change to the intended directory, and start it again. The current adapter does not expose a separate PI working-directory field.

### Project extensions or skills are not loaded

Check PI's project-trust configuration and verify the same resources load when PI is started directly from that workspace.
