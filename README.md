# agent-bridge

MVP scaffold for an IM ↔ Pi bridge following the dual-adapter design in `ADAPTER_INTERFACE_DESIGN.md`.

## Current scope

- CLI commands:
  - `agent-bridge add`
  - `agent-bridge ls`
  - `agent-bridge remove <channel-name>`
  - `agent-bridge start <channel-name>`
- Config file: `~/.config/agent-bridge/config.json`
- MVP events:
  - `user.message`
  - `assistant.message`
- Core queues:
  - ingress FIFO
  - egress FIFO
- Feishu IM adapter: scaffold only, target implementation mode follows Hermes WebSocket adapter
- Pi agent adapter: scaffold only, target runtime is RPC mode

## Usage

```bash
node ./src/cli.js add
node ./src/cli.js ls
node ./src/cli.js start <channel-name>
```

## Notes

- Feishu and Pi RPC integrations are not fully implemented yet.
- `PiRpcAgentAdapter` currently emits a placeholder response so the core pipeline can be exercised.
