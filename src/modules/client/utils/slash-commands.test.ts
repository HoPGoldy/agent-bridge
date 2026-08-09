import { describe, expect, it } from "vitest";
import { getTranslator } from "../../../i18n";
import { parseSlashCommand, resolveHelpMarkdown } from "./slash-commands";

describe("resolveHelpMarkdown", () => {
  it("returns localized help markdown for /help and /h", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(resolveHelpMarkdown("/help", en)).toContain("Available commands:");
    expect(resolveHelpMarkdown("/h", en)).toContain("/stop");
    expect(resolveHelpMarkdown("/H", zh)).toContain("可用命令：");
    expect(resolveHelpMarkdown("/HELP", zh)).toContain("查看这条帮助信息");
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
});
