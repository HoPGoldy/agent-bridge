# WeCom Private Chat Investigation Summary

## Problem Statement

When running the WeCom channel through long connection mode, the bot can connect and authenticate successfully, but sending a private message such as `你好` does not produce any visible response.

The goal of this investigation was to determine whether the problem was caused by `agent-bridge`, the official WeCom SDK, or enterprise WeCom-side delivery/configuration rules.

## What Was Changed In `agent-bridge`

We replaced the handwritten WeCom WebSocket client implementation with the official SDK `@wecom/aibot-node-sdk`.

The migration also included:

- support for `reply`
- support for `replyMedia`
- support for `replyWelcome`
- support for `replyStream`
- stream context reuse for incremental replies
- adapter changes so start/progress/final assistant text uses stream replies

Focused tests were updated and passed for the WeCom client and IM adapter.

## Validation Already Completed

### 1. Local code-path validation

We updated the WeCom implementation in `agent-bridge` and ran focused tests for the touched slices.

Validated areas:

- WeCom client wrapper behavior
- stream reply behavior
- IM adapter delivery behavior
- attachment reply behavior

Result: the local implementation and tests are consistent with the official SDK contract.

### 2. Official SDK control experiment

To rule out `agent-bridge` as the source of the problem, we cloned and ran the official SDK repository:

- repo: `WecomTeam/aibot-node-sdk`
- local runner based on built `dist` output

The official SDK runner successfully reached:

- `CONNECTED`
- `AUTHENTICATED`

This confirms that:

- bot credentials are valid
- the WebSocket endpoint is reachable
- the official SDK can authenticate successfully in this environment

## Key Runtime Observations

### Observation 1: private message did not reach the official SDK callback

After the official SDK runner was connected and authenticated, a private message `你好` was sent from WeCom.

Expected signals:

- `message`
- `message.text`
- `event.enter_chat`

Observed result:

- none of the above callbacks were received

This is the most important result in the investigation.

It means the symptom is reproducible even when using the official SDK directly, outside of `agent-bridge`.

### Observation 2: server sent `disconnected_event`

During testing, the official SDK runner received:

- `disconnected_event`
- message meaning: a new connection has been established, this connection will be closed by server

This confirms that the bot only allows one active long connection at a time. When a new connection is established, the previous one is disconnected by the server.

### Observation 3: connection ownership was not stable during testing

At least one test run showed the official SDK runner being disconnected because another connection took over.

This means any manual test is unreliable unless we first ensure that only one environment is using the same `botId + secret`.

## GitHub Issue Investigation

We checked the public issues in the official SDK repository:

- `WecomTeam/aibot-node-sdk`

We did not find a public issue that exactly matches:

- `disconnected_event`
- `enter_chat` not arriving
- private chat callback completely missing
- single-connection behavior described explicitly in issue form

However, we found related issues that strongly suggest the problem may be on the enterprise WeCom side rather than in SDK code.

### Related issue: #17

Issue:

- `为什么除了管理员其他人都不能接受到消息`

Reported symptom:

- admin messages can be received
- messages from other enterprise members are not received by the SDK

Reply in the issue points to:

- whether the allowed/usable members were configured correctly

This is highly relevant because it shows a real case where the SDK connection is fine, but message delivery depends on enterprise WeCom-side member scope.

### Related issue: #19

Issue:

- `接收不到群消息，只能接收到私聊消息`

Follow-up from the reporter:

- `被@可以收到`

This is relevant because it shows that message delivery depends on the exact chat scenario and trigger conditions. Not every message in every context is delivered to the long connection bot.

### Related issue: #23

Issue:

- `能去掉 sendMessage 上的各种限制，让主动发起的消息和 reply 的行为对齐吗？`

This is not the same bug, but it confirms that enterprise WeCom imposes platform-level restrictions on bot messaging behavior, especially for proactive sends.

## Current Conclusion

Based on all evidence collected so far, the current best conclusion is:

The problem is more likely caused by enterprise WeCom-side delivery rules, member scope, session entry conditions, or connection ownership conflicts, rather than by `agent-bridge` implementation bugs.

More specifically:

1. `agent-bridge` was migrated to the official SDK and validated with focused tests.
2. The same symptom appears when using the official SDK directly.
3. The official SDK can connect and authenticate successfully.
4. The private message still does not arrive as a callback.
5. The server explicitly enforces single active long-connection ownership.

## Most Likely Causes To Check Next

### 1. Allowed member scope

Check whether the current WeCom user account is included in the bot's allowed or usable member scope.

This is the strongest external clue from the public issue tracker.

### 2. Wrong chat entry path

Check whether the message was sent from the correct bot conversation entry point.

It is possible that sending a message from a normal private chat window is not the same as entering the supported bot session flow.

### 3. Another environment is taking over the connection

Check whether any other terminal, machine, service, CI job, or teammate is using the same `botId + secret`.

If another connection is established, the current one will be disconnected by the server.

### 4. Scenario-specific delivery rules

Enterprise WeCom may apply different delivery rules depending on:

- private chat vs group chat
- whether the bot was mentioned
- whether the user entered the bot session through a supported entry point
- whether the user has interacted with the bot before

## Recommended Next Steps

1. Ensure only one environment is connected with this bot's credentials.
2. Keep one runner alive and verify that no `disconnected_event` occurs for a stable observation window.
3. Confirm the current test user is inside the bot's allowed member scope.
4. Re-enter the bot through the official supported conversation entry point.
5. Test whether `enter_chat` is emitted before testing normal text messages.
6. After the environment is stable, test again with only one active connection.

## One-Sentence Summary

We already reproduced the same "connected and authenticated, but private chat message does not arrive" symptom with the official WeCom SDK itself, so the current evidence points much more strongly to enterprise WeCom-side configuration, delivery rules, or connection ownership conflicts than to an `agent-bridge` code bug.