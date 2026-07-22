# Feishu Adapter Upgrade Spec

## Goal

Upgrade the Feishu client adapter in `agent-bridge` so it behaves correctly for real conversational use while keeping the bridge architecture unchanged.

This iteration includes:

- group mention gating
- reply-oriented text sending
- long-text chunking
- strict in-order awaited delivery

This iteration does not include:

- media upload or download
- card messages
- rich message formatting beyond plain text

## Non-Goals

- No changes to `GatewayCore` session semantics.
- No changes to Pi agent protocol.
- No new client command surface beyond existing `/new` and `/compact`.

## User-Visible Behavior

### Inbound behavior

- In direct messages, normal text messages continue to enter the bridge.
- In group chats, only messages that explicitly mention the bot enter the bridge.
- Group messages without a bot mention are ignored and must not create or wake a session.
- Existing `/new` and `/compact` commands still work when the inbound message is accepted.

### Outbound behavior

- Assistant output is sent as plain text.
- When replying to a user message is possible, the first outbound chunk should reply to that inbound message.
- If the SDK cannot send as a reply, delivery must fall back to a normal text message instead of failing the whole send.
- Long assistant output must be split into multiple text chunks.
- Chunks must be sent sequentially with `await` so users receive them in order.
- The adapter must not fire multiple chunk sends concurrently for the same egress event.

## Design Constraints

- Prefer the official Feishu channel abstraction from `@larksuiteoapi/node-sdk` over hand-rolled websocket/event parsing where it covers the required behavior.
- Keep Feishu-specific behavior inside the Feishu adapter layer.
- Keep `GatewayCore` unaware of Feishu mention policy and chunking rules.
- Preserve the existing per-adapter egress queue so bridge-level ordering remains stable.

## Data Model Changes

### Feishu inbound message metadata

The Feishu adapter needs enough metadata to support mention gating and reply sends.

Expected inbound payload fields:

- `chatId`
- `chatType`
- `messageId`
- `text`
- `mentionedBot` or equivalent mention signal
- `raw` for diagnostics

### Feishu config

The Feishu client config should expose a group mention policy flag.

Expected new config field:

- `requireMentionInGroup?: boolean`

Default:

- `true`

## Long Text Chunking Rules

- Chunking applies to outbound assistant text only.
- Default chunk size target: `4000` characters.
- Prefer splitting at newline boundaries.
- If no newline exists before the limit, prefer splitting at whitespace.
- If neither exists, hard-split at the limit.
- Preserve original text order.
- Drop empty chunks after trimming only when the original segment is empty noise; do not collapse meaningful whitespace inside a chunk.

## Ordering Rules

- For a single assistant egress event, all chunks must be sent in a simple `for ... of` loop with `await`.
- The adapter-level egress queue must continue to process one event at a time.
- No fire-and-forget send calls are allowed in the Feishu outbound path.

## Reply Rules

- The first outbound chunk should use the inbound `messageId` as `replyTo` when available.
- Later chunks may be sent as normal text messages in the same chat.
- If reply send fails with a recoverable SDK fallback path, the adapter should still deliver the text.
- The bridge must not duplicate the first chunk when fallback succeeds internally.

## Validation Requirements

Add focused tests for:

- group message ignored when bot is not mentioned
- group message accepted when bot is mentioned
- direct message accepted without mention
- long text split into ordered chunks
- chunk sends awaited in order
- `/new` and `/compact` still mapped correctly

## Implementation Plan

1. Extend Feishu types and config to carry mention and reply metadata.
2. Refactor the Feishu client wrapper to use the SDK channel abstraction where appropriate.
3. Update the IM adapter to enforce mention gating and sequential chunked sends.
4. Add focused Vitest coverage for the new behavior.
5. Run targeted tests for the Feishu adapter slice.
