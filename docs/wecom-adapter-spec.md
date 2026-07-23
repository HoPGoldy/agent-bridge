# WeCom Adapter Spec

## Goal

Add a WeCom client adapter to `agent-bridge` that mirrors the existing Feishu bridge architecture while using WeCom AI Bot WebSocket transport semantics.

This iteration includes:

- a new `wecom` client module alongside `feishu`
- DM + group chat intake with mention gating in groups
- immediate English acknowledgement on accepted inbound messages
- reply-oriented outbound text sending with chunking and ordered delivery
- progress tracking with the **same data model and rendered body text as Feishu**, but delivered as a periodic text summary once per minute instead of editable cards
- bidirectional image/file transfer
- TDD coverage for config/session helpers, client protocol handling, progress cadence, and attachment delivery

This iteration does not include:

- WeCom callback/self-built-app mode
- card editing or message editing
- reaction/typing indicators
- synchronous attachment-delivery acknowledgements back into the model turn
- audio/video send support

## Non-Goals

- No changes to `GatewayCore` session semantics.
- No changes to Pi RPC protocol.
- No structured-image/base64 input to Pi sessions.
- No new bridge-level abstractions just for WeCom.

## Architectural Fit

The adapter must follow the existing `agent-bridge` layering:

- protocol/runtime specifics stay inside `src/modules/client/wecom/adapter/wecom-client.ts`
- bridge semantics stay inside `src/modules/client/wecom/adapter/wecom-im-adapter.ts`
- `GatewayCore` remains transport-agnostic and continues passing `assistant.message.attachments` through unchanged

## User-Visible Behavior

### Inbound

- Direct messages are accepted without mention.
- Group messages require an explicit leading `@...` mention when `requireMentionInGroup` is enabled.
- Accepted inbound messages receive an immediate English acknowledgement:

> I’m starting now — I’ll share a progress update in about a minute.

- Existing slash commands continue to work:
  - `/new`
  - `/compact`
  - `/stop`

### Outbound text

- Assistant replies are sent as markdown/text messages.
- The first outbound chunk replies to the triggering inbound message when reply context is available.
- Later chunks are sent as normal messages.
- Long text is chunked using the same rules as Feishu:
  - target size `4000`
  - prefer newline
  - then whitespace
  - otherwise hard split
- Chunks must be sent sequentially with `await`.

### Progress updates

- Progress state collection stays logically identical to Feishu:
  - same event types
  - same line formatting
  - same collapsed-count behavior
  - same per-turn reset model
- Rendering content also stays identical to Feishu's `progressBody(lines, collapsedCount)`.
- Instead of editable cards, WeCom sends a plain text summary at most once per minute **when progress changed during that minute**.
- No duplicate unchanged summary should be sent.
- Final assistant output stops the progress timer for that turn.

### Attachments

#### Inbound

- User-sent image/file attachments are downloaded to a local temp directory.
- The bridge appends a plain-text hint to the user message before forwarding it to Pi, e.g.:

```text
[Received image: /tmp/agent-bridge-wecom-media/172-photo.png]
[Received file: /tmp/agent-bridge-wecom-media/173-report.pdf]
```

#### Outbound

- The existing `MEDIA:<absolute_path>` extraction path remains the only model-facing convention.
- `assistant.message.attachments` is delivered by the WeCom adapter after the text reply.
- Native WeCom upload/send is used for images/files.
- Attachment failures must not suppress the already-generated text reply; instead, a follow-up error message is sent.

## WeCom Transport Design

Use the WeCom AI Bot WebSocket flow, based on Hermes's proven adapter behavior:

- connect to `wss://openws.work.weixin.qq.com` by default
- authenticate via `aibot_subscribe`
- receive inbound callbacks via `aibot_msg_callback` (and legacy alias if present)
- send proactive messages via `aibot_send_msg`
- send reply-context messages via `aibot_respond_msg`
- upload media using the 3-step upload flow:
  - `aibot_upload_media_init`
  - `aibot_upload_media_chunk`
  - `aibot_upload_media_finish`

## Data Model Changes

Add WeCom-specific config and inbound message types to `src/types.ts`:

```ts
export interface WecomClientConfig {
  botId: string;
  secret: string;
  websocketUrl?: string;
  requireMentionInGroup?: boolean;
}

export interface WecomInboundMessage {
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
| { type: "wecom"; config: WecomClientConfig }
```

## Session Model

Add `wecom-session.ts` helpers mirroring Feishu:

- `wecom:dm:<chatId>`
- `wecom:group:<chatId>`

## Progress Model

WeCom keeps the same logical state shape as Feishu, plus timer bookkeeping:

```ts
{
  lines: string[];
  status: string;
  collapsedCount: number;
  turnId: number;
  dirty: boolean;
  interval: NodeJS.Timeout | null;
  announced: boolean;
}
```

Rules:

- on accepted inbound message: reset progress state, send immediate English acknowledgement, start interval
- on progress event: mutate state exactly as Feishu does; mark `dirty = true`
- on each minute tick: if `dirty`, enqueue one progress-summary send and clear `dirty`
- on final `assistant.message`: stop interval and clear progress state for that turn

## Attachment Handling

### Inbound

- Downloaded resources are written under `/tmp/agent-bridge-wecom-media`.
- Supported in this iteration:
  - image
  - file / appmsg file
- WeCom inbound resources may arrive as base64 or URL references; both should be handled.

### Outbound

- `WecomClient.sendAttachment(...)` uploads the file and then sends a native image/file message.
- For reply-context sends, use reply mode when possible; otherwise fall back to proactive send.

## Failure Handling

- Recoverable send failures must produce a follow-up text error:

```text
[agent-bridge error] Message delivery failed

<reason>
```

- Attachment failures follow the same rule.
- If reply-oriented send cannot be used, the client falls back to normal proactive send.

## Validation Requirements

Add TDD coverage for:

- config validation and session helper round-trips
- subscribe handshake and inbound callback parsing
- group mention gating
- immediate English acknowledgement on accepted inbound messages
- ordered chunked reply sending
- per-minute progress summary cadence using the same rendered body as Feishu
- collapsed progress summary behavior after >10 lines
- inbound image/file download to local temp path
- outbound image/file upload + native send
- attachment failure notification path

## Implementation Plan

1. Write this spec.
2. Add failing tests for WeCom config/session helpers.
3. Add failing adapter tests covering intake, acknowledgement, chunking, progress cadence, and attachments.
4. Add failing client tests covering subscribe, callback parsing, media download, and media upload/send.
5. Implement `types.ts` and client module registration.
6. Implement `wecom-session.ts` and `wecom/index.ts`.
7. Implement `wecom-client.ts`.
8. Implement `wecom-im-adapter.ts`.
9. Run the full Vitest suite and fix regressions.
