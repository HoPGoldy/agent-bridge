# OpenCode Setup

This guide explains how to connect `agent-bridge` to a user-managed [OpenCode](https://opencode.ai/) Server.

`agent-bridge` connects to the server over HTTP but does not start, restart, update, or stop it. One server can host multiple OpenCode sessions, while each bridge conversation is bound to its own session.

## 1. Install OpenCode

Install the OpenCode CLI:

```bash
npm install -g opencode-ai
```

Verify the installation:

```bash
opencode --version
```

Configure at least one OpenCode provider and confirm that it has an available model before connecting the bridge.

## 2. Start OpenCode Server

For a local server, use:

```bash
OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow","question":"deny"}}' \
opencode serve --hostname 127.0.0.1 --port 4096
```

The recommended permission policy is designed for non-interactive IM use:

- all ordinary permission requests are allowed by the server
- the interactive Question Tool is denied

The adapter also handles unexpected requests defensively: permission requests for its current session are approved once, while Question requests are rejected with an explicit error.

Verify the server:

```bash
curl http://127.0.0.1:4096/global/health
```

## 3. Add the channel

Run:

```bash
agent-bridge add
```

After configuring the IM client, select `opencode` as the agent type. The setup asks for:

| Field | Required | Description |
| --- | --- | --- |
| Server URL | Yes | An `http://` or `https://` URL. The default is `http://127.0.0.1:4096`. |
| Basic Auth | No | Optional username and password for the server. |
| Working directory | No | OpenCode workspace. Defaults to the current directory. |
| Agent | No | OpenCode agent name. Uses the server default when omitted. |
| Model | No | Initial model in `provider/modelID` form. Uses the server default when omitted. |

The server health and configured model are validated before the channel is saved.

Start the channel:

```bash
agent-bridge start <channel-name>
```

## HTTP Basic Auth

Start a protected server with environment variables:

```bash
OPENCODE_SERVER_USERNAME='opencode' \
OPENCODE_SERVER_PASSWORD='<password>' \
OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow","question":"deny"}}' \
opencode serve --hostname 127.0.0.1 --port 4096
```

Enter the same username and password during `agent-bridge add`. The password is collected as a secret and omitted from summaries and errors. It is used for health checks, session requests, provider requests, SSE events, permission replies, and Question rejection.

Do not embed credentials in the server URL.

## Remote servers

To listen on all network interfaces:

```bash
OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow","question":"deny"}}' \
opencode serve --hostname 0.0.0.0 --port 4096
```

Use HTTPS for remote deployments. Plain HTTP is allowed after a warning, but it does not encrypt messages or Basic Auth credentials. Keep a remote server behind a trusted network, VPN, firewall, or TLS reverse proxy, and restrict access to the listening port.

## Supported behavior

The OpenCode adapter provides:

- creation and restoration of OpenCode sessions
- regular prompts and follow-up messages while a session is busy
- `/stop` to abort only the current session
- `/compact` using the current provider and model
- `/status` with session, model, token, and context information when available
- `/model` listing and model selection
- reasoning and tool progress events
- final assistant text and local file attachments
- a shared SSE connection for sessions belonging to the same channel runtime
- bounded SSE reconnection with status and pending-request recovery

Only models belonging to connected OpenCode providers appear in `/model`. A model selection applies to the next prompt because OpenCode does not expose a separate immediate model-switch operation.

OpenCode's internal compaction summary messages are not forwarded to the IM client; users receive only bridge progress and completion output.

## Lifecycle

Stopping `agent-bridge` closes its SSE subscription and local runtime state. It does not:

- delete OpenCode sessions
- dispose the OpenCode Server
- terminate the external `opencode serve` process

Saved bridge bindings allow a later bridge process to restore the same OpenCode session, provided that the server still has it.

## Troubleshooting

### Server connection fails

Check the health endpoint and confirm that the URL, port, and protocol match the server:

```bash
curl http://127.0.0.1:4096/global/health
```

A `401` response indicates mismatched Basic Auth credentials.

### No model is available

Configure a provider in OpenCode and verify that it appears as connected. The bridge intentionally excludes models from providers that are installed but not authenticated.

### `/compact` cannot determine a model

Select one with `/model provider/modelID`, configure a default model for the channel, or send a normal prompt so the session records its current model.

### Tool access is blocked

Review the OpenCode server permission configuration. The recommended non-interactive policy is:

```json
{
  "permission": {
    "*": "allow",
    "question": "deny"
  }
}
```

### Events stop arriving

The runtime reconnects SSE automatically. If the server itself was restarted or removed the session, restart the channel or use `/new` to create a new session.
