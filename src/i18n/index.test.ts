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
    expect(zh("client.helpMessage")).toContain("查看这条帮助信息");
    expect(zh("client.helpMessage")).toContain("切换模型");
    expect(zh("client.helpMessage")).toContain("/new [path]");
    expect(zh("client.helpMessage")).toContain("/n [path]");
    expect(zh("client.helpMessage")).toContain("/new /path/to/project");
    expect(en("gateway.failedToResumeSession", { detail: "boom" })).toBe(
      "Failed to resume the agent session: boom\nStart a new session with `/new`.",
    );
    expect(zh("gateway.failedToResumeSession", { detail: "boom" })).toBe(
      "恢复智能体会话失败：boom\n请使用 `/new` 开始新会话。",
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
