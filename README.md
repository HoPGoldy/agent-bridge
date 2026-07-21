# agent-bridge

IM ↔ Pi bridge following the dual-adapter design in `ADAPTER_INTERFACE_DESIGN.md`.

## Engineering setup

This project now follows the same general engineering pattern as `review-pilot`:

- TypeScript source in `src/` and `bin/`
- `tsup` build output in `dist/`
- dedicated CLI bootstrap in `bin/agent-bridge.ts`
- command implementation in `src/cli.ts`
- shared types in `src/types.ts`
- `vitest` for tests
- GitHub Actions CI for build + test

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
- Feishu IM adapter: minimal WebSocket long-connection implementation using official Lark SDK
- Pi agent adapter: subprocess integration via `pi --mode rpc`

## Development

```bash
npm install
npm run build
npm test
npm run dev -- --help
```

## Notes

- Feishu receive/send text path is implemented for the MVP event pair.
- `PiRpcAgentAdapter` now spawns a real Pi RPC subprocess per session and emits a single final `assistant.message` for each input turn.
- Pi sessions are persisted by exact `--session-id` under the bridge-owned session directory, so adapter recreation can resume the same conversation.
- Optional runtime overrides:
  - `PI_BIN` (default: `pi`)
  - `PI_SESSION_DIR` (default: `~/.config/agent-bridge/pi-sessions`)
  - `PI_RPC_EXTRA_ARGS` (space-separated extra CLI args, for example `--approve`)
- Rich Feishu behaviors from Hermes/pi-feishu (cards, reactions, media, mention gating) are intentionally not included in the MVP yet.
