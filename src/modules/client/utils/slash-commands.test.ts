import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTranslator } from "../../../i18n";
import {
  formatQueueHereReply,
  formatScheduleHereReply,
  formatScheduleRunReply,
  parseSlashCommand,
  resolveHelpMarkdown,
  resolveSlashCommandEvent,
} from "./slash-commands";
import {
  createInMemoryImClientSessionStateStore,
  type ImClientSessionStateV1,
} from "./client-session-state";
import type { ClientSessionStateApi } from "../../../types";

describe("resolveHelpMarkdown", () => {
  it("returns localized help markdown for /help and /h", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(resolveHelpMarkdown("/help", en)).toContain("Available commands:");
    expect(resolveHelpMarkdown("/h", en)).toContain("/stop");
    expect(resolveHelpMarkdown("/H", zh)).toContain("可用命令：");
    expect(resolveHelpMarkdown("/HELP", zh)).toContain("查看这条帮助信息");
  });

  it("documents /schedule-run and /schedule-here in the help text", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(resolveHelpMarkdown("/help", en)).toContain("/schedule-run <task-name>");
    expect(resolveHelpMarkdown("/help", zh)).toContain("/schedule-run <任务名>");
    expect(resolveHelpMarkdown("/help", en)).toContain("/schedule-here <task-name>");
    expect(resolveHelpMarkdown("/help", zh)).toContain("/schedule-here <任务名>");
  });

  it("returns null for non-help text", () => {
    const en = getTranslator("en-US");

    expect(resolveHelpMarkdown("/stop", en)).toBeNull();
    expect(resolveHelpMarkdown("/help me", en)).toBeNull();
    expect(resolveHelpMarkdown("hello", en)).toBeNull();
  });
});

describe("parseSlashCommand", () => {
  it("parses /new and /n into a command.session.new event without a workingDirectory key", () => {
    expect(parseSlashCommand("/new", "session-1")).toStrictEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/n", "session-1")).toStrictEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
    });
    expect("workingDirectory" in parseSlashCommand("/new", "session-1")!).toBe(false);
    expect("workingDirectory" in parseSlashCommand("/n", "session-1")!).toBe(false);
  });

  it("parses /new <path> and /n <path> into a command.session.new event with a working directory", () => {
    expect(parseSlashCommand("/new /Users/wesley/project", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: "/Users/wesley/project",
    });
    expect(parseSlashCommand("/n /tmp/demo", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: "/tmp/demo",
    });
  });

  it("preserves relative paths as the working directory", () => {
    expect(parseSlashCommand("/new ./demo", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: "./demo",
    });
    expect(parseSlashCommand("/new ../up", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: "../up",
    });
    expect(parseSlashCommand("/new please", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: "please",
    });
  });

  it("keeps the full tail as a single path including spaces", () => {
    expect(parseSlashCommand("/new /Users/wesley/My Project", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: "/Users/wesley/My Project",
    });
  });

  it("supports Unicode working directory paths", () => {
    expect(parseSlashCommand("/new /Users/wesley/中文项目", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: "/Users/wesley/中文项目",
    });
  });

  it("matches the /new command name case-insensitively while preserving path case", () => {
    expect(parseSlashCommand("/New /Users/Wesley/MyProject", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: "/Users/Wesley/MyProject",
    });
    expect(parseSlashCommand("/N /tmp/Demo", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: "/tmp/Demo",
    });
  });

  it("trims whitespace around the working directory argument", () => {
    expect(parseSlashCommand("/new   /Users/wesley/project  ", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: "/Users/wesley/project",
    });
  });

  it("parses /compact and /c into a command.session.compact event", () => {
    expect(parseSlashCommand("/compact", "session-1")).toEqual({
      type: "command.session.compact",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/c", "session-1")).toEqual({
      type: "command.session.compact",
      clientSessionId: "session-1",
    });
  });

  it("parses /stop and /s into a command.session.stop event", () => {
    expect(parseSlashCommand("/stop", "session-1")).toEqual({
      type: "command.session.stop",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/s", "session-1")).toEqual({
      type: "command.session.stop",
      clientSessionId: "session-1",
    });
  });

  it("parses /status and /st into a command.session.status event", () => {
    expect(parseSlashCommand("/status", "session-1")).toEqual({
      type: "command.session.status",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/st", "session-1")).toEqual({
      type: "command.session.status",
      clientSessionId: "session-1",
    });
  });

  it("parses /model and /m into a command.session.model.list event", () => {
    expect(parseSlashCommand("/model", "session-1")).toEqual({
      type: "command.session.model.list",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/m", "session-1")).toEqual({
      type: "command.session.model.list",
      clientSessionId: "session-1",
    });
  });

  it("parses /model <target> and /m <target> into a command.session.model.set event", () => {
    expect(parseSlashCommand("/model anthropic/claude-sonnet-4-5", "session-1")).toEqual({
      type: "command.session.model.set",
      clientSessionId: "session-1",
      target: "anthropic/claude-sonnet-4-5",
    });
    expect(parseSlashCommand("/m openai/gpt-5", "session-1")).toEqual({
      type: "command.session.model.set",
      clientSessionId: "session-1",
      target: "openai/gpt-5",
    });
  });

  it("parses supported commands case-insensitively", () => {
    expect(parseSlashCommand("/New", "session-1")).toStrictEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/C", "session-1")).toEqual({
      type: "command.session.compact",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/Compact", "session-1")).toEqual({
      type: "command.session.compact",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/S", "session-1")).toEqual({
      type: "command.session.stop",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/Status", "session-1")).toEqual({
      type: "command.session.status",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/ST", "session-1")).toEqual({
      type: "command.session.status",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/Model", "session-1")).toEqual({
      type: "command.session.model.list",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/M anthropic/claude-sonnet-4-5", "session-1")).toEqual({
      type: "command.session.model.set",
      clientSessionId: "session-1",
      target: "anthropic/claude-sonnet-4-5",
    });
  });

  it("returns null for regular text", () => {
    expect(parseSlashCommand("hello there", "session-1")).toBeNull();
  });

  it("returns null for unrecognized command-like text", () => {
    expect(parseSlashCommand("/help", "session-1")).toBeNull();
    expect(parseSlashCommand("/h", "session-1")).toBeNull();
    expect(parseSlashCommand("/compact please", "session-1")).toBeNull();
    expect(parseSlashCommand("/status now", "session-1")).toBeNull();
    expect(parseSlashCommand("hello /model anthropic/claude-sonnet-4-5", "session-1")).toBeNull();
    expect(parseSlashCommand("-n", "session-1")).toBeNull();
    expect(parseSlashCommand("-c", "session-1")).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(parseSlashCommand("", "session-1")).toBeNull();
  });

  it("parses /schedule-run <task-name> into an adapter-local schedule.run command", () => {
    expect(parseSlashCommand("/schedule-run daily-report", "session-1")).toEqual({
      type: "schedule.run",
      clientSessionId: "session-1",
      taskName: "daily-report",
    });
    expect(parseSlashCommand("/schedule-run 123", "session-1")).toEqual({
      type: "schedule.run",
      clientSessionId: "session-1",
      taskName: "123",
    });
  });

  it("matches /schedule-run case-insensitively and normalizes the task name to lowercase", () => {
    expect(parseSlashCommand("/Schedule-Run DailyReport", "session-1")).toEqual({
      type: "schedule.run",
      clientSessionId: "session-1",
      taskName: "dailyreport",
    });
    expect(parseSlashCommand("/SCHEDULE-RUN my-task", "session-1")).toEqual({
      type: "schedule.run",
      clientSessionId: "session-1",
      taskName: "my-task",
    });
  });

  it("returns a usage error for /schedule-run without a task name", () => {
    expect(parseSlashCommand("/schedule-run", "session-1")).toEqual({
      type: "schedule.run.usage",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/schedule-run   ", "session-1")).toEqual({
      type: "schedule.run.usage",
      clientSessionId: "session-1",
    });
  });

  it("returns a usage error for /schedule-run with an invalid task name", () => {
    for (const bad of ["/schedule-run foo_bar", "/schedule-run a b", "/schedule-run täsk", "/schedule-run x.y"]) {
      expect(parseSlashCommand(bad, "session-1")).toEqual({
        type: "schedule.run.usage",
        clientSessionId: "session-1",
      });
    }
  });

  it("returns null for schedule-run-like text that is not the command", () => {
    expect(parseSlashCommand("/schedule-runner", "session-1")).toBeNull();
    expect(parseSlashCommand("hello /schedule-run daily", "session-1")).toBeNull();
  });
});

describe("parse /schedule-here", () => {
  it("parses /schedule-here <task-name> into an adapter-local schedule.here command", () => {
    expect(parseSlashCommand("/schedule-here daily-report", "session-1")).toEqual({
      type: "schedule.here",
      clientSessionId: "session-1",
      taskName: "daily-report",
    });
    expect(parseSlashCommand("/schedule-here 123", "session-1")).toEqual({
      type: "schedule.here",
      clientSessionId: "session-1",
      taskName: "123",
    });
  });

  it("matches /schedule-here case-insensitively and normalizes the task name to lowercase", () => {
    expect(parseSlashCommand("/Schedule-Here DailyReport", "session-1")).toEqual({
      type: "schedule.here",
      clientSessionId: "session-1",
      taskName: "dailyreport",
    });
    expect(parseSlashCommand("/SCHEDULE-HERE my-task", "session-1")).toEqual({
      type: "schedule.here",
      clientSessionId: "session-1",
      taskName: "my-task",
    });
  });

  it("returns a usage error for /schedule-here without a task name", () => {
    expect(parseSlashCommand("/schedule-here", "session-1")).toEqual({
      type: "schedule.here.usage",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/schedule-here   ", "session-1")).toEqual({
      type: "schedule.here.usage",
      clientSessionId: "session-1",
    });
  });

  it("returns a usage error for /schedule-here with an invalid task name", () => {
    for (const bad of ["/schedule-here foo_bar", "/schedule-here a b", "/schedule-here täsk", "/schedule-here x.y"]) {
      expect(parseSlashCommand(bad, "session-1")).toEqual({
        type: "schedule.here.usage",
        clientSessionId: "session-1",
      });
    }
  });

  it("returns null for schedule-here-like text that is not the command", () => {
    expect(parseSlashCommand("/schedule-hereafter", "session-1")).toBeNull();
    expect(parseSlashCommand("hello /schedule-here daily", "session-1")).toBeNull();
    expect(parseSlashCommand("/schedule-run here", "session-1")).toEqual({
      type: "schedule.run",
      clientSessionId: "session-1",
      taskName: "here",
    });
  });
});

describe("parse /queue-here", () => {
  it("parses /queue-here <queue-name> into an adapter-local queue.here command", () => {
    expect(parseSlashCommand("/queue-here build-queue", "session-1")).toEqual({
      type: "queue.here",
      clientSessionId: "session-1",
      queueName: "build-queue",
    });
    expect(parseSlashCommand("/queue-here 123", "session-1")).toEqual({
      type: "queue.here",
      clientSessionId: "session-1",
      queueName: "123",
    });
  });

  it("matches /queue-here case-insensitively and normalizes the queue name to lowercase", () => {
    expect(parseSlashCommand("/Queue-Here BuildQueue", "session-1")).toEqual({
      type: "queue.here",
      clientSessionId: "session-1",
      queueName: "buildqueue",
    });
    expect(parseSlashCommand("/QUEUE-HERE my-queue", "session-1")).toEqual({
      type: "queue.here",
      clientSessionId: "session-1",
      queueName: "my-queue",
    });
  });

  it("returns a usage error for /queue-here without a queue name", () => {
    expect(parseSlashCommand("/queue-here", "session-1")).toEqual({
      type: "queue.here.usage",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/queue-here   ", "session-1")).toEqual({
      type: "queue.here.usage",
      clientSessionId: "session-1",
    });
  });

  it("returns a usage error for /queue-here with an invalid queue name", () => {
    for (const bad of ["/queue-here foo_bar", "/queue-here a b", "/queue-here täsk", "/queue-here x.y"]) {
      expect(parseSlashCommand(bad, "session-1")).toEqual({
        type: "queue.here.usage",
        clientSessionId: "session-1",
      });
    }
  });

  it("returns null for queue-here-like text that is not the command", () => {
    expect(parseSlashCommand("/queue-hereafter", "session-1")).toBeNull();
    expect(parseSlashCommand("hello /queue-here build", "session-1")).toBeNull();
  });
});

describe("parse /resume", () => {
  it("parses /resume <id> and /r <id> into a command.session.resume event", () => {
    expect(parseSlashCommand("/resume ses_abc123", "session-1")).toEqual({
      type: "command.session.resume",
      clientSessionId: "session-1",
      providerSessionId: "ses_abc123",
    });
    expect(parseSlashCommand("/r pi-coding-agent.0195c2e5-8b7e-7d90-8f26-f0ea4d8f6f70", "session-1")).toEqual({
      type: "command.session.resume",
      clientSessionId: "session-1",
      providerSessionId: "pi-coding-agent.0195c2e5-8b7e-7d90-8f26-f0ea4d8f6f70",
    });
  });

  it("matches /resume case-insensitively while preserving the id", () => {
    expect(parseSlashCommand("/Resume ses_abc123", "session-1")).toEqual({
      type: "command.session.resume",
      clientSessionId: "session-1",
      providerSessionId: "ses_abc123",
    });
    expect(parseSlashCommand("/R ABC-def_123", "session-1")).toEqual({
      type: "command.session.resume",
      clientSessionId: "session-1",
      providerSessionId: "ABC-def_123",
    });
  });

  it("returns a usage error for /resume without a provider session id", () => {
    expect(parseSlashCommand("/resume", "session-1")).toEqual({
      type: "command.session.resume.usage",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/r", "session-1")).toEqual({
      type: "command.session.resume.usage",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/resume   ", "session-1")).toEqual({
      type: "command.session.resume.usage",
      clientSessionId: "session-1",
    });
  });

  it("trims whitespace around the provider session id without validating it", () => {
    expect(parseSlashCommand("/resume   ses_abc123  ", "session-1")).toEqual({
      type: "command.session.resume",
      clientSessionId: "session-1",
      providerSessionId: "ses_abc123",
    });
    // Decision 4: the raw string is passed through even when it does not look
    // like a session id — only the agent backend can validate it.
    expect(parseSlashCommand("/resume what is this? x.y", "session-1")).toEqual({
      type: "command.session.resume",
      clientSessionId: "session-1",
      providerSessionId: "what is this? x.y",
    });
  });

  it("returns null for resume-like text that is not the command", () => {
    expect(parseSlashCommand("/resumes ses_1", "session-1")).toBeNull();
    expect(parseSlashCommand("/resume;x", "session-1")).toBeNull();
    expect(parseSlashCommand("hello /resume ses_1", "session-1")).toBeNull();
  });
});

describe("formatScheduleHereReply", () => {
  it("renders a localized success reply", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(formatScheduleHereReply({ ok: true }, "report", en)).toContain('Task "report"');
    expect(formatScheduleHereReply({ ok: true }, "report", en)).toContain("this chat");
    expect(formatScheduleHereReply({ ok: true }, "报告", zh)).toContain('任务 "报告"');
    expect(formatScheduleHereReply({ ok: true }, "报告", zh)).toContain("本会话");
  });

  it("maps known failure reasons to localized messages", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(formatScheduleHereReply({ ok: false, reason: "task not found" }, "x", en)).toContain(
      "was not found",
    );
    expect(formatScheduleHereReply({ ok: false, reason: "task not found" }, "x", zh)).toContain(
      "未找到定时任务",
    );
  });

  it("maps the task-already-bound reason to a localized message", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(
      formatScheduleHereReply({ ok: false, reason: "task already bound" }, "report", en),
    ).toContain("already bound");
    expect(
      formatScheduleHereReply({ ok: false, reason: "task already bound" }, "报告", zh),
    ).toContain("已绑定");
  });

  it("falls back to a generic failure message carrying the raw reason", () => {
    const en = getTranslator("en-US");

    expect(formatScheduleHereReply({ ok: false, reason: "failed to write task file: boom" }, "x", en)).toContain(
      "failed to write task file: boom",
    );
    expect(formatScheduleHereReply({ ok: false, reason: "invalid task name" }, "x", en)).toContain(
      "invalid task name",
    );
  });
});

describe("formatQueueHereReply", () => {
  it("renders a localized success reply", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(formatQueueHereReply({ ok: true }, "build", en)).toContain('Queue "build"');
    expect(formatQueueHereReply({ ok: true }, "build", en)).toContain("this chat");
    expect(formatQueueHereReply({ ok: true }, "构建", zh)).toContain('队列 "构建"');
    expect(formatQueueHereReply({ ok: true }, "构建", zh)).toContain("本会话");
  });

  it("maps known failure reasons to localized messages", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(formatQueueHereReply({ ok: false, reason: "queue not found" }, "build", en)).toContain(
      'was not found',
    );
    expect(formatQueueHereReply({ ok: false, reason: "queue not found" }, "构建", zh)).toContain(
      "未找到队列",
    );
    expect(formatQueueHereReply({ ok: false, reason: "queue already bound" }, "build", en)).toContain(
      "already bound",
    );
    expect(formatQueueHereReply({ ok: false, reason: "queue already bound" }, "构建", zh)).toContain(
      "已绑定",
    );
  });

  it("falls back to a generic failure message carrying the raw reason", () => {
    const en = getTranslator("en-US");

    expect(formatQueueHereReply({ ok: false, reason: "failed to write queue file: boom" }, "x", en)).toContain(
      "failed to write queue file: boom",
    );
    expect(formatQueueHereReply({ ok: false, reason: "target must be a non-empty string" }, "x", en)).toContain(
      "target must be a non-empty string",
    );
  });
});

describe("formatScheduleRunReply", () => {
  it("renders a localized success reply", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(formatScheduleRunReply({ ok: true }, "report", en)).toContain('Task "report"');
    expect(formatScheduleRunReply({ ok: true }, "report", en)).toContain("target chat");
    expect(formatScheduleRunReply({ ok: true }, "报告", zh)).toContain('任务 "报告"');
  });

  it("maps known failure reasons to localized messages", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(formatScheduleRunReply({ ok: false, reason: "task not found" }, "x", en)).toContain(
      "was not found",
    );
    expect(formatScheduleRunReply({ ok: false, reason: "task is disabled" }, "x", en)).toContain(
      "disabled",
    );
    expect(formatScheduleRunReply({ ok: false, reason: "task has no valid target" }, "x", en)).toContain(
      "target chat",
    );
    expect(formatScheduleRunReply({ ok: false, reason: "task not found" }, "x", zh)).toContain(
      "未找到定时任务",
    );
  });

  it("falls back to a generic failure message carrying the raw reason", () => {
    const en = getTranslator("en-US");

    expect(formatScheduleRunReply({ ok: false, reason: "task body is empty" }, "x", en)).toContain(
      "task body is empty",
    );
    expect(formatScheduleRunReply({ ok: false, reason: "scheduler is not running" }, "x", en)).toContain(
      "scheduler is not running",
    );
  });

  it("maps a belongs-to-another-channel rejection and extracts the channel name", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(
      formatScheduleRunReply({ ok: false, reason: 'task belongs to channel "other"' }, "report", en),
    ).toContain('"other"');
    expect(
      formatScheduleRunReply({ ok: false, reason: 'task belongs to channel "other"' }, "报告", zh),
    ).toContain('"other"');
  });

  it("still shows a wrong-channel message when the channel cannot be extracted", () => {
    const en = getTranslator("en-US");

    // Prefix-matched but the `^task belongs to channel "([^"]+)"$` regex
    // cannot extract a channel name, so the raw reason is carried through the
    // `channelMatch?.[1] ?? result.reason` fallback. This must still render
    // the wrong-channel wording (distinct from the generic failure message).
    const reply = formatScheduleRunReply(
      { ok: false, reason: 'task belongs to channel "unterminated' },
      "report",
      en,
    );
    expect(reply).toContain("belongs to channel");
    expect(reply).toContain("Please run it from that channel");
    expect(reply).toContain('task belongs to channel "unterminated');
    expect(reply).not.toContain("Failed to trigger");
  });
});

describe("resolveSlashCommandEvent", () => {
  let base: string;

  beforeEach(async () => {
    // Canonicalize once: on macOS the tmp dir is behind a /var -> /private/var
    // symlink, and validation returns the realpath-resolved path.
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-bridge-slash-")));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function parseNew(text: string, clientSessionId = "session-1") {
    const parsed = parseSlashCommand(text, clientSessionId);
    if (!parsed) {
      throw new Error(`expected ${text} to parse as a command`);
    }
    return parsed;
  }

  it("passes non-new commands through unchanged", async () => {
    const store = createInMemoryImClientSessionStateStore("feishu");
    await expect(
      resolveSlashCommandEvent(parseNew("/compact"), {
        sessionState: store.session("session-1"),
        cwd: "/fallback",
      }),
    ).resolves.toEqual({ type: "command.session.compact", clientSessionId: "session-1" });

    // `/resume` needs no client-side resolution either: the provider session
    // id is forwarded verbatim to the core (T04 adds the adapter-local
    // interception of the usage variant before this call).
    await expect(
      resolveSlashCommandEvent(parseNew("/resume ses_abc123"), {
        sessionState: store.session("session-1"),
      }),
    ).resolves.toEqual({
      type: "command.session.resume",
      clientSessionId: "session-1",
      providerSessionId: "ses_abc123",
    });
  });

  it("uses the explicit /new path, marks it as user-sourced and remembers the canonical path", async () => {
    const store = createInMemoryImClientSessionStateStore("feishu");
    const sessionState = store.session("session-1");

    await expect(
      resolveSlashCommandEvent(parseNew(`/new ${base}`), { sessionState }),
    ).resolves.toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: base,
      workingDirectorySource: "user",
    });

    await expect(sessionState.read()).resolves.toEqual({
      version: 1,
      defaultWorkingDirectory: base,
    });
  });

  it("rejects an invalid explicit path locally: no event, nothing remembered", async () => {
    const store = createInMemoryImClientSessionStateStore("feishu");
    const sessionState = store.session("session-1");
    const missing = path.join(base, "does-not-exist");

    await expect(
      resolveSlashCommandEvent(parseNew(`/new ${missing}`), { sessionState }),
    ).resolves.toEqual({
      type: "invalid-working-directory",
      workingDirectory: missing,
      detail: "no such file or directory",
      remembered: false,
    });

    await expect(sessionState.read()).resolves.toBeUndefined();
  });

  it("reuses the remembered default for a bare /new and keeps it user-sourced", async () => {
    const store = createInMemoryImClientSessionStateStore("feishu");
    const sessionState = store.session("session-1");

    await resolveSlashCommandEvent(parseNew(`/new ${base}`), { sessionState });
    await expect(
      resolveSlashCommandEvent(parseNew("/new"), { sessionState, cwd: "/fallback" }),
    ).resolves.toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: base,
      workingDirectorySource: "user",
    });
  });

  it("reports a stale remembered default instead of silently falling back", async () => {
    const store = createInMemoryImClientSessionStateStore("feishu");
    const sessionState = store.session("session-1");

    await resolveSlashCommandEvent(parseNew(`/new ${base}`), { sessionState });
    await rm(base, { recursive: true, force: true });

    await expect(
      resolveSlashCommandEvent(parseNew("/new"), { sessionState, cwd: "/fallback" }),
    ).resolves.toEqual({
      type: "invalid-working-directory",
      workingDirectory: base,
      detail: "no such file or directory",
      remembered: true,
    });
  });

  it("falls back to the provided cwd for a bare /new without a remembered default", async () => {
    const store = createInMemoryImClientSessionStateStore("feishu");

    await expect(
      resolveSlashCommandEvent(parseNew("/new"), {
        sessionState: store.session("session-1"),
        cwd: "/fallback",
      }),
    ).resolves.toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: "/fallback",
      workingDirectorySource: "default",
    });
  });

  it("falls back to the process cwd when no cwd override is provided", async () => {
    const store = createInMemoryImClientSessionStateStore("feishu");

    await expect(
      resolveSlashCommandEvent(parseNew("/new"), { sessionState: store.session("session-1") }),
    ).resolves.toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: process.cwd(),
      workingDirectorySource: "default",
    });
  });

  it("keeps remembered defaults isolated per chat", async () => {
    const store = createInMemoryImClientSessionStateStore("feishu");

    await resolveSlashCommandEvent(parseNew(`/new ${base}`, "chat-1"), {
      sessionState: store.session("chat-1"),
    });
    await expect(
      resolveSlashCommandEvent(parseNew("/new", "chat-2"), {
        sessionState: store.session("chat-2"),
        cwd: "/fallback",
      }),
    ).resolves.toMatchObject({ workingDirectory: "/fallback", workingDirectorySource: "default" });
  });

  it("still emits the command when remembering the explicit path fails", async () => {
    const errors: unknown[] = [];
    const failingSessionState: ClientSessionStateApi<ImClientSessionStateV1> = {
      clientSessionId: "session-1",
      read: async () => undefined,
      update: async () => {
        throw new Error("store boom");
      },
      flush: async () => {},
    };

    await expect(
      resolveSlashCommandEvent(parseNew(`/new ${base}`), {
        sessionState: failingSessionState,
        onError: (error) => errors.push(error),
      }),
    ).resolves.toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: base,
      workingDirectorySource: "user",
    });
    expect(errors).toHaveLength(1);
  });

  it("falls back to the cwd when reading the remembered default fails", async () => {
    const errors: unknown[] = [];
    const failingSessionState: ClientSessionStateApi<ImClientSessionStateV1> = {
      clientSessionId: "session-1",
      read: async () => {
        throw new Error("store boom");
      },
      update: async (updater) => updater(undefined),
      flush: async () => {},
    };

    await expect(
      resolveSlashCommandEvent(parseNew("/new"), {
        sessionState: failingSessionState,
        cwd: "/fallback",
        onError: (error) => errors.push(error),
      }),
    ).resolves.toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
      workingDirectory: "/fallback",
      workingDirectorySource: "default",
    });
    expect(errors).toHaveLength(1);
  });
});
