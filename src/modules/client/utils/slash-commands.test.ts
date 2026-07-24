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
  it("parses /new and /n into a command.session.new event", () => {
    expect(parseSlashCommand("/new", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
    });
    expect(parseSlashCommand("/n", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
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

  it("parses supported commands case-insensitively", () => {
    expect(parseSlashCommand("/New", "session-1")).toEqual({
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
  });

  it("returns null for regular text", () => {
    expect(parseSlashCommand("hello there", "session-1")).toBeNull();
  });

  it("returns null for unrecognized command-like text", () => {
    expect(parseSlashCommand("/help", "session-1")).toBeNull();
    expect(parseSlashCommand("/h", "session-1")).toBeNull();
    expect(parseSlashCommand("/new please", "session-1")).toBeNull();
    expect(parseSlashCommand("/compact please", "session-1")).toBeNull();
    expect(parseSlashCommand("/status now", "session-1")).toBeNull();
    expect(parseSlashCommand("-n", "session-1")).toBeNull();
    expect(parseSlashCommand("-c", "session-1")).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(parseSlashCommand("", "session-1")).toBeNull();
  });
});
