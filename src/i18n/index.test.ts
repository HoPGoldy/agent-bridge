import { describe, expect, it } from "vitest";
import { getTranslator } from "./index";

describe("i18n", () => {
  it("returns localized fixed translators for supported locales", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(en("progress.noProgress")).toBe("No progress yet.");
    expect(zh("progress.noProgress")).toBe("暂无进度。");
    expect(en("client.helpMessage")).toContain("/help");
    expect(en("client.helpMessage")).toContain("/model");
    expect(en("client.helpMessage")).toContain("/new [path]");
    expect(en("client.helpMessage")).toContain("/n [path]");
    expect(en("client.helpMessage")).toContain("/new /path/to/project");
    expect(en("client.helpMessage")).toContain("/resume <id>");
    expect(en("client.helpMessage")).toContain("/r <id>");
    expect(zh("client.helpMessage")).toContain("查看这条帮助信息");
    expect(zh("client.helpMessage")).toContain("切换模型");
    expect(zh("client.helpMessage")).toContain("/new [path]");
    expect(zh("client.helpMessage")).toContain("/n [path]");
    expect(zh("client.helpMessage")).toContain("/new /path/to/project");
    expect(zh("client.helpMessage")).toContain("/resume <id>");
    expect(zh("client.helpMessage")).toContain("/r <id>");
    expect(en("gateway.failedToResumeSession", { detail: "boom" })).toBe(
      "Failed to resume the agent session: boom\nStart a new session with `/new`.",
    );
    expect(zh("gateway.failedToResumeSession", { detail: "boom" })).toBe(
      "恢复智能体会话失败：boom\n请使用 `/new` 开始新会话。",
    );
    expect(en("client.resumeUsage")).toBe(
      "Usage: `/resume <provider-session-id>` — adopt an existing provider session (get the id from `/status`).",
    );
    expect(zh("client.resumeUsage")).toBe(
      "用法：`/resume <provider 会话 ID>` —— 接管一个已有的 provider 会话（ID 可通过 `/status` 查看）。",
    );
    expect(
      en("gateway.resumedSession", { sessionId: "ses_1", workingDirectory: "/w" }),
    ).toBe('Resumed session `ses_1` (working directory: /w).');
    expect(
      zh("gateway.resumedSession", { sessionId: "ses_1", workingDirectory: "/w" }),
    ).toBe("已接管会话 `ses_1`（工作目录：/w）。",);
    expect(en("gateway.resumedSessionWithoutDirectory", { sessionId: "ses_1" })).toBe(
      "Resumed session `ses_1`.",
    );
    expect(zh("gateway.resumedSessionWithoutDirectory", { sessionId: "ses_1" })).toBe(
      "已接管会话 `ses_1`。",
    );
    expect(en("gateway.failedToResumeNewSession", { detail: "boom" })).toBe(
      "Failed to adopt the provider session: boom",
    );
    expect(zh("gateway.failedToResumeNewSession", { detail: "boom" })).toBe(
      "接管 provider 会话失败：boom",
    );
    expect(en("queue.taskCompletedSuffix", { queue: "q", path: "/p/q.md" })).toBe(
      '*Queue "q" task completed · full output: /p/q.md*',
    );
    expect(zh("queue.taskCompletedSuffix", { queue: "q", path: "/p/q.md" })).toBe(
      '*队列 "q" 任务执行完成 · 完整内容见 /p/q.md*',
    );
    expect(en("queue.taskFailedSuffix", { queue: "q", path: "/p/q.md" })).toBe(
      '*Queue "q" task failed · full output: /p/q.md*',
    );
    expect(zh("queue.taskFailedSuffix", { queue: "q", path: "/p/q.md" })).toBe(
      '*队列 "q" 任务执行失败 · 完整内容见 /p/q.md*',
    );
    expect(en("queue.taskTimedOutSuffix", { queue: "q", path: "/p/q.md" })).toBe(
      '*Queue "q" task timed out · full output: /p/q.md*',
    );
    expect(zh("queue.taskTimedOutSuffix", { queue: "q", path: "/p/q.md" })).toBe(
      '*队列 "q" 任务超时 · 完整内容见 /p/q.md*',
    );
    expect(en("schedule.taskCompletedSuffix", { name: "daily-report", path: "/p/r.md" })).toBe(
      '*Scheduled task "daily-report" completed · full output: /p/r.md*',
    );
    expect(zh("schedule.taskCompletedSuffix", { name: "daily-report", path: "/p/r.md" })).toBe(
      '*定时任务 "daily-report" 执行完成 · 完整内容见 /p/r.md*',
    );
    expect(en("schedule.taskFailedSuffix", { name: "daily-report", path: "/p/r.md" })).toBe(
      '*Scheduled task "daily-report" failed · full output: /p/r.md*',
    );
    expect(zh("schedule.taskFailedSuffix", { name: "daily-report", path: "/p/r.md" })).toBe(
      '*定时任务 "daily-report" 执行失败 · 完整内容见 /p/r.md*',
    );
    expect(en("schedule.taskTimedOutSuffix", { name: "daily-report", path: "/p/r.md" })).toBe(
      '*Scheduled task "daily-report" timed out · full output: /p/r.md*',
    );
    expect(zh("schedule.taskTimedOutSuffix", { name: "daily-report", path: "/p/r.md" })).toBe(
      '*定时任务 "daily-report" 超时 · 完整内容见 /p/r.md*',
    );
    expect(en("schedule.taskNoOutputSuffix", { name: "daily-report", path: "/p/r.md" })).toBe(
      '*Scheduled task "daily-report" finished with no output · full output: /p/r.md*',
    );
    expect(zh("schedule.taskNoOutputSuffix", { name: "daily-report", path: "/p/r.md" })).toBe(
      '*定时任务 "daily-report" 执行完成，无输出 · 完整内容见 /p/r.md*',
    );
    expect(en("cli.queueInserted", { name: "inbox", taskId: "1-2ab3" })).toBe(
      'Inserted task 1-2ab3 into queue "inbox".',
    );
    expect(zh("cli.queueInserted", { name: "inbox", taskId: "1-2ab3" })).toBe(
      '已向队列 "inbox" 插入任务 1-2ab3。',
    );
    expect(en("cli.queueInsertUnboundWarning")).toBe(
      "Warning: the queue has no target yet — tasks wait until `/queue-here` binds a chat.",
    );
    expect(zh("cli.queueInsertUnboundWarning")).toBe(
      "警告：该队列尚未绑定目标聊天——任务将一直等待，直到通过 `/queue-here` 绑定。",
    );
    expect(en("cli.noQueues")).toBe("No queues found. Add one with `agent-bridge queue add`.");
    expect(zh("cli.noQueues")).toBe("尚未创建任何队列。请使用 `agent-bridge queue add` 创建。");
    expect(en("cli.queueNotFound", { name: "inbox" })).toBe('Queue "inbox" not found.');
    expect(zh("cli.queueNotFound", { name: "inbox" })).toBe('未找到队列 "inbox"。');
    expect(en("cli.queueRetried", { name: "inbox", taskId: "1-2ab3" })).toBe(
      'Task 1-2ab3 of queue "inbox" re-queued (state: pending) — it will be consumed on the next tick.',
    );
    expect(zh("cli.queueRetried", { name: "inbox", taskId: "1-2ab3" })).toBe(
      '已将队列 "inbox" 的任务 1-2ab3 重新入队（state: pending），将由下个 tick 自然消费。',
    );
    expect(en("cli.queueRetryTaskNotFound", { name: "inbox", taskId: "1-2ab3" })).toBe(
      'Task "1-2ab3" not found in queue "inbox".',
    );
    expect(zh("cli.queueRetryTaskNotFound", { name: "inbox", taskId: "1-2ab3" })).toBe(
      '队列 "inbox" 中未找到任务 "1-2ab3"。',
    );
    expect(
      en("cli.queueRetryNotFailed", { name: "inbox", taskId: "1-2ab3", state: "pending" }),
    ).toBe(
      'Task "1-2ab3" of queue "inbox" is not failed (state: pending) — only failed tasks can be retried.',
    );
    expect(
      zh("cli.queueRetryNotFailed", { name: "inbox", taskId: "1-2ab3", state: "pending" }),
    ).toBe(
      '队列 "inbox" 的任务 "1-2ab3" 未处于 failed 状态（当前状态：pending）——只有 failed 任务可以重试。',
    );
    expect(en("queue.taskFailedAgentSession", { sessionId: "pi:1" })).toBe(
      "Agent session: pi:1",
    );
    expect(zh("queue.taskFailedAgentSession", { sessionId: "pi:1" })).toBe(
      "Agent 会话：pi:1",
    );
    expect(en("client.queueHereBound", { name: "build" })).toBe(
      'Queue "build" is now bound to this chat.',
    );
    expect(zh("client.queueHereBound", { name: "build" })).toBe('队列 "build" 已绑定到本会话。');
    expect(en("client.queueHereQueueNotFound", { name: "build" })).toBe('Queue "build" was not found.');
    expect(zh("client.queueHereQueueNotFound", { name: "build" })).toBe('未找到队列 "build"。');
    expect(en("client.queueHereAlreadyBound", { name: "build" })).toBe(
      'Queue "build" is already bound to a chat. To rebind, edit the queue file with AI.',
    );
    expect(zh("client.queueHereAlreadyBound", { name: "build" })).toBe(
      '队列 "build" 已绑定到某个会话。如需重新绑定，请用 AI 编辑队列文件。',
    );
    expect(en("client.queueHereFailed", { name: "build", reason: "boom" })).toBe(
      'Failed to bind queue "build": boom',
    );
    expect(zh("client.queueHereFailed", { name: "build", reason: "失败" })).toBe(
      '无法绑定队列 "build"：失败',
    );
    expect(en("client.queueHereUsage")).toBe(
      "Usage: `/queue-here <queue-name>` (queue names match `[a-z0-9-]+`).",
    );
    expect(zh("client.queueHereUsage")).toBe(
      "用法：`/queue-here <队列名>`（队列名需匹配 `[a-z0-9-]+`）。",
    );
  });

  it("does not leak locale state across fixed translators", () => {
    const zh = getTranslator("zh-CN");
    const en = getTranslator("en-US");

    expect(zh("client.processing")).toBe("正在处理中...");
    expect(en("client.processing")).toBe("Processing...");
    expect(zh("client.processing")).toBe("正在处理中...");
  });
});
