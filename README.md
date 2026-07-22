# agent-bridge

`agent-bridge` connects IM channel (feishu, weixin, weicom...) to local coding agent (pi, codex, opencode...) using a dual-adapter architecture.

The design stays intentionally simple and compact: no harness layer, no extra tools, no extra skills, just forwarding messages from IM to the local agent.

## Current support

Client side: `FeiShu`.

Agent side: `PI Coding Agent`.

The current built-in support is intentionally small, but the architecture is designed for straightforward horizontal extension. The project will primarily maintain the integrations used in practice today, and contributions for additional client or agent adapters are welcome through forks and PRs.

## Quick Start

Install the CLI:

```bash
npm install -g @hopgoldy/agent-bridge
```

The CLI currently provides these commands:

- `agent-bridge add`
- `agent-bridge ls`
- `agent-bridge remove <channel-name>`
- `agent-bridge start <channel-name>`

Create a channel interactively:

```bash
agent-bridge add
```

The prompt flow currently asks for:

- channel name
- select client module type
- set client config...
- select agent module type
- set agent config...

Start the configured channel:

```bash
agent-bridge start <channel-name>
```

List configured channels:

```bash
agent-bridge ls
```

Remove a configured channel:

```bash
agent-bridge remove <channel-name>
```

Config file: `~/.config/agent-bridge/config.json`

## Development

```bash
npm install
npm run build
npm test
npm run dev -- --help
```

## Q&A

### Why not implement this directly as a `pi-feishu`, `pi-wechat`, or similar plugin?

Because plugin-style integrations for Pi or similar local agents do not provide enough control over session lifecycle, channel behavior, and local runtime isolation.

In practice, this shows up in a few ways:

- It is hard to implement a real `/new` that cleanly resets the remote conversation while keeping channel-side routing predictable.
- Connecting the same local agent cleanly to multiple channels is much harder when each integration is embedded as a plugin inside the agent runtime.
- Different channels have very different behavior, and existing integrations are often maintained independently without a shared contract.
- The local development and runtime experience becomes much more invasive: starting Pi for normal local work can also start multiple channel-facing plugins and inject extra tools that are unrelated to the task at hand.

`agent-bridge` takes the opposite approach: keep the local agent runtime focused, keep channel integration outside the agent process, and make session routing explicit at the bridge layer.

## License

MIT.
