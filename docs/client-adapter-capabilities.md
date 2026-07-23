# Client Adapter Capabilities

This document lists the minimum capabilities a client adapter should provide in `agent-bridge`.

It is intentionally capability-oriented: it describes what an adapter must support, not how a specific IM platform should implement it.

## Inbound capabilities

A client adapter should be able to:

- accept plain text messages
- accept attachments, at least for images and files
- translate slash commands into standard `agent-bridge` events
- build a stable `clientSessionId` for each platform conversation

## Outbound capabilities

A client adapter should be able to:

- acknowledge a newly accepted user message quickly, such as by showing typing state or sending an immediate short reply
- surface agent progress, such as by updating a card or sending periodic progress messages
- upload and send images and files
- return the final assistant message
- split long outbound text into chunks when the platform has message size limits, and send those chunks in order
- preserve in-order delivery within the same session
- report delivery failures back to the user

## Lifecycle capabilities

A client adapter should be able to:

- start receiving platform events
- stop cleanly
- report whether it is still busy processing or delivering messages
- clean up connections, timers, queues, and other runtime resources when stopped

## Boundary

Client adapters should keep platform-specific behavior inside the adapter layer, while exposing only the standard `agent-bridge` event contract to the rest of the system.
