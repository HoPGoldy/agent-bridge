# AGENTS.md

## Glossary

### client adapter (channel)

A bridge implementation that encapsulates an IM app (e.g., Feishu/Lark, WeCom), converting user actions in the IM app into standard events to send out, and displaying events passed from the agent adapter on the IM side.

### agent adapter

A bridge implementation that encapsulates an Agent app (e.g., pi coding agent, opencode), receiving user action events and passing them to the Agent app, and converting the Agent app's actions into standard events to send out.

### core module

Responsible for associating sessions between the client adapter and the agent adapter, and simply passing events to the correct adapter instance.

### schedule task

A scheduled task. When the time arrives, an agent is created to complete the task, and the result is sent back to the IM app. The controller runs in the client adapter.

### queue task (event task)

Similar to a schedule task, except that this project can create queues — an agent is only created to complete a task when there are tasks in the queue.

## Principle

- The overall architecture is a bidirectional adapter (client to agent), and the core module's logic should be kept simple.
