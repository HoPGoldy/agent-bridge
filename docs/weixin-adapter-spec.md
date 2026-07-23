# Weixin Adapter Spec

## Goal

Add a personal WeChat (`weixin`) client adapter to `agent-bridge` that satisfies the client-adapter capability contract while reusing a proven iLink transport where practical.

This iteration includes:

- a new `weixin` client module alongside `feishu` and `wecom`
- DM-first personal WeChat support over Tencent iLink Bot API
- stable session mapping for DM and group conversations
- slash-command translation for `/new`, `/compact`, and `/stop`
- fast acknowledgement of accepted inbound messages via WeChat typing state
- ordered outbound text delivery with chunking
- bidirectional image/file transfer, plus pragmatic voice/video handling aligned with Hermes behavior
- delivery-failure reporting back to the user
- adapter-local handling of platform-specific state such as `context_token`, `sync_buf`, typing tickets, and rate-limit protection
- focused Vitest coverage for config, session helpers, adapter behavior, and transport integration

This iteration does not include:

- changes to `GatewayCore` session semantics
- changes to the Pi RPC protocol
- a new bridge-wide abstraction just for Weixin
- guaranteed full feature parity with Hermes group policy on day one if the iLink account type cannot actually receive ordinary group events

## Capability Mapping

This design explicitly follows `docs/client-adapter-capabilities.md`.

### Inbound capabilities

The Weixin adapter will:

- accept plain text messages
- accept attachments, at least images and files, by downloading them to local temp paths and appending plain-text hints for Pi
- translate supported slash commands into standard `agent-bridge` events
- build a stable `clientSessionId` per Weixin conversation

### Outbound capabilities

The Weixin adapter will:

- acknowledge accepted inbound messages quickly using typing state
- surface agent progress using a conservative Weixin-friendly strategy
- upload and send images and files natively through iLink/CDN
- return the final assistant message
- split long outbound text into ordered chunks
- preserve in-order delivery within the same session via the adapter egress queue
- report delivery failures back to the user with a follow-up message

### Lifecycle capabilities

The Weixin adapter will:

- start receiving platform events through long polling
- stop cleanly
- report whether it is still busy
- clean up sessions, timers, polling loops, queues, and runtime resources when stopped

## Recommended Transport Strategy

### Primary approach

Use `@openilink/openilink-sdk-node` as the default low-level iLink transport layer, then wrap it in an `agent-bridge`-specific adapter.

Reasoning:

- it already covers the core iLink transport surface: login, long polling, text/media send, CDN upload/download, typing, and `context_token` caching
- it is TypeScript/Node-native and fits the current project stack
- it has tests and keeps runtime dependencies minimal
- it reduces the amount of hand-written crypto/CDN/protocol code we must maintain in `agent-bridge`

### Adapter-owned policy layer

Even when using the SDK, `agent-bridge` still owns the platform policy layer that Hermes has already proven is necessary:

- stable `clientSessionId` mapping
- slash-command translation
- ordered egress queue semantics
- message chunking policy
- delivery-failure notification behavior
- temp-file handling for inbound attachments
- stale-session handling beyond generic SDK behavior if needed
- rate-limit/backoff/circuit-breaker behavior if the SDK is too thin
- content deduplication and text batching if required by observed Weixin behavior

### Fallback approach

If the SDK proves insufficient during integration, the fallback is to replace the transport implementation with a thin in-repo iLink client while keeping the same `weixin-im-adapter.ts` contract and tests.

This keeps the architectural risk low: transport can change without changing the rest of the bridge.

## Architectural Fit

The adapter must follow the existing `agent-bridge` layering:

- protocol/runtime specifics stay inside `src/modules/client/weixin/adapter/weixin-client.ts`
- bridge semantics stay inside `src/modules/client/weixin/adapter/weixin-im-adapter.ts`
- session helpers stay inside `src/modules/client/weixin/adapter/weixin-session.ts`
- registration/config stay inside `src/modules/client/weixin/index.ts`
- `GatewayCore` remains transport-agnostic

## User-Visible Behavior

### Inbound

- Direct messages are accepted by default.
- Group messages are supported structurally, but may be gated by configuration and by actual iLink account limitations.
- Existing slash commands continue to work:
  - `/new`
  - `/compact`
  - `/stop`
- Accepted inbound messages should trigger an immediate typing acknowledgement when possible.

### Inbound attachments

- Supported inbound attachment classes in this iteration:
  - image
  - file
  - video
  - voice/audio when retrievable through iLink media references
- Downloaded resources are written to a local temp directory.
- The forwarded user text to Pi includes plain-text file hints such as:

```text
[Received image: /tmp/agent-bridge-weixin-media/172-photo.jpg]
[Received file: /tmp/agent-bridge-weixin-media/173-report.pdf]
```

This keeps the existing bridge contract unchanged and matches the pattern already used successfully elsewhere.

### Outbound text

- Assistant replies are sent as normal Weixin text messages.
- Long replies are chunked.
- Chunks are sent sequentially with `await`.
- The adapter must preserve per-session ordering by keeping the existing single-event egress queue behavior.

### Progress updates

Weixin does not support editable messages in the same way Feishu does, and high-frequency progress chatter is likely a poor fit for iLink rate limits.

Therefore this iteration uses a conservative strategy:

- start typing when a user message is accepted
- optionally accumulate internal progress state
- prefer sending the final answer only
- if progress must be surfaced before completion, do so using low-frequency summary messages rather than frequent incremental updates
- stop typing after final delivery or on terminal failure

### Outbound attachments

- `assistant.message.attachments` remains the model-facing path
- native Weixin upload/send is used for images/files
- caption text is sent separately before the media item when needed
- attachment failures must not suppress already-sent text; instead, send a follow-up error message

### Delivery failures

Recoverable failures produce a user-visible follow-up message in the same chat:

```text
[agent-bridge error] Message delivery failed

<reason>
```

## Weixin Transport Design

The transport must align with personal WeChat iLink semantics already proven by Hermes.

Core endpoints and behaviors:

- `ilink/bot/getupdates` for long polling
- `ilink/bot/sendmessage` for text/media send
- `ilink/bot/sendtyping` for typing state
- `ilink/bot/getconfig` for typing ticket refresh
- `ilink/bot/getuploadurl` for media upload bootstrap
- CDN upload/download with AES-128-ECB encryption

Required persisted/runtime state:

- `sync_buf` for poll resume
- latest `context_token` per peer
- typing ticket cache with refresh behavior
- dedup/runtime protection state as needed

## Data Model Changes

Add Weixin-specific config and inbound-message types to `src/types.ts`.

```ts
export interface WeixinClientConfig {
  accountId: string;
  token: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  requireMentionInGroup?: boolean;
  enableGroups?: boolean;
}

export interface WeixinInboundMessage {
  chatId: string;
  chatType: "dm" | "group";
  messageId: string;
  text: string;
  mentionedBot?: boolean;
  raw?: unknown;
}
```

Extend `ClientConfig` to include:

```ts
| { type: "weixin"; config: WeixinClientConfig }
```

## Session Model

Add `weixin-session.ts` helpers:

- `weixin:dm:<chatId>`
- `weixin:group:<chatId>`

These helpers should mirror the Feishu/WeCom pattern and provide round-trip parsing.

## Config UX

The `weixin` client module should expose a config collector that asks for:

- account ID
- token
- optional base URL (default iLink URL)
- optional CDN base URL
- whether to require mention in groups if groups are enabled
- whether group handling is enabled in this channel

First iteration recommendation:

- DM support on by default
- group handling off or conservative by default unless the user explicitly enables it

## Ordering Rules

- The adapter-level egress queue continues to process one event at a time.
- For a single assistant message, text chunks are sent in a simple awaited loop.
- Attachment sends occur after the text send path for the same event.
- No fire-and-forget platform sends are allowed in the normal outbound path.

## Text Chunking Rules

- Chunking applies to outbound assistant text only.
- Initial target size: `2000` characters, matching the more conservative Hermes Weixin limit.
- Prefer splitting at newline boundaries.
- If no newline exists before the limit, prefer whitespace.
- Otherwise hard-split.
- Preserve order.
- Drop empty chunks.

## Typing Rules

- On accepted inbound user message, attempt to start typing.
- Typing requires a valid `typing_ticket`; refresh it through `getconfig` when absent or expired.
- On final assistant delivery or terminal failure, stop typing.
- Typing failures must be logged/debugged but must not fail the user turn by themselves.

## Attachment Handling

### Inbound

- Download media references exposed by iLink.
- Store them under a temp directory such as `/tmp/agent-bridge-weixin-media`.
- Append plain-text file hints to the bridged message.

### Outbound

- For images/files/videos/voice, upload via iLink upload bootstrap + CDN flow.
- Use the correct Weixin media key encoding semantics for `aes_key`.
- Keep caption delivery separate from the media item when required.
- If native voice send is not reliable, fall back to file attachment delivery for voice payloads, following Hermes's pragmatic behavior.

## Failure Handling

The adapter must handle these platform-specific failure modes conservatively:

- missing or expired `context_token`
- expired typing tickets
- stale session responses
- rate limits / transient API failures
- CDN upload errors
- media download/decrypt failures

Policy:

- log details internally
- preserve bridge liveness
- fail the current delivery clearly to the user when necessary
- avoid duplicate or out-of-order sends

## Validation Requirements

Add focused tests for:

- config validation and session helper round-trips
- client module registration
- inbound DM acceptance
- slash-command mapping for `/new`, `/compact`, `/stop`
- ordered long-text chunk sending
- typing start/stop lifecycle
- inbound attachment download to local temp paths
- outbound image/file upload + send
- follow-up failure notification behavior
- clean adapter shutdown with no dangling polling loop or timers

If Hermes-derived protections are implemented in this iteration, also test:

- stale-session detection behavior
- rate-limit backoff/circuit-breaker behavior
- duplicate inbound message suppression

## Implementation Plan

1. Write this spec.
2. Extend `src/types.ts` and client-module registration for `weixin`.
3. Add `docs`-driven tests for config/session helpers and adapter behavior.
4. Implement `src/modules/client/weixin/index.ts`.
5. Implement `src/modules/client/weixin/adapter/weixin-session.ts`.
6. Implement `src/modules/client/weixin/adapter/weixin-client.ts` using `@openilink/openilink-sdk-node` as the initial transport.
7. Implement `src/modules/client/weixin/adapter/weixin-im-adapter.ts`.
8. Add Hermes-inspired hardening where the SDK is insufficient.
9. Run the Vitest suite and fix regressions.

## Decision Notes

- Preferred transport choice: `@openilink/openilink-sdk-node`
- Preferred adapter strategy: SDK-backed transport + bridge-owned policy layer
- Explicit fallback: replace the transport implementation with an in-repo thin client without changing the adapter contract
