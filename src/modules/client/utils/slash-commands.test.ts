import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "./slash-commands";

describe("parseSlashCommand", () => {
  it("parses /new into a command.session.new event", () => {
    expect(parseSlashCommand("/new", "session-1")).toEqual({
      type: "command.session.new",
      clientSessionId: "session-1",
    });
  });

  it("parses /compact into a command.session.compact event", () => {
    expect(parseSlashCommand("/compact", "session-1")).toEqual({
      type: "command.session.compact",
      clientSessionId: "session-1",
    });
  });

  it("parses /stop into a command.session.stop event", () => {
    expect(parseSlashCommand("/stop", "session-1")).toEqual({
      type: "command.session.stop",
      clientSessionId: "session-1",
    });
  });

  it("returns null for regular text", () => {
    expect(parseSlashCommand("hello there", "session-1")).toBeNull();
  });

  it("returns null for unrecognized slash-like text", () => {
    expect(parseSlashCommand("/help", "session-1")).toBeNull();
    expect(parseSlashCommand("/new please", "session-1")).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(parseSlashCommand("", "session-1")).toBeNull();
  });
});
