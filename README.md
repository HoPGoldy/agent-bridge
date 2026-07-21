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
- Pi agent adapter: scaffold only, target runtime is RPC mode

## Development

```bash
npm install
npm run build
npm test
npm run dev -- --help
```

## Notes

- Feishu receive/send text path is implemented for the MVP event pair.
- `PiRpcAgentAdapter` currently emits a placeholder response so the core pipeline can be exercised.
- Rich Feishu behaviors from Hermes/pi-feishu (cards, reactions, media, mention gating) are intentionally not included in the MVP yet.
