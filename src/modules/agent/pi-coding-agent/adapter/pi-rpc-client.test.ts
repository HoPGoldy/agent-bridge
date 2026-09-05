import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiRpcClient } from "./pi-rpc-client";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));
vi.mock("./pi-extension-path", () => ({
  resolveMediaPromptExtensionPath: () => "/tmp/media-prompt.ts",
}));

import { spawn } from "node:child_process";

type FakeChild = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  stdin: {
    writable: boolean;
    write: (payload: string, cb?: (error?: Error | null) => void) => boolean;
  };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createFakeChild(): FakeChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = {
    writable: true,
    write(payload: string, cb?: (error?: Error | null) => void) {
      const parsed = JSON.parse(payload) as { id?: string; type: string };
      const response = {
        id: parsed.id,
        type: "response",
        command: parsed.type,
        success: true,
        data:
          parsed.type === "get_state"
            ? { sessionId: "session-1", sessionName: "agent-1" }
            : {},
      };
      setImmediate(() => {
        stdout.emit("data", Buffer.from(`${JSON.stringify(response)}\n`));
      });
      cb?.();
      return true;
    },
  };
  child.kill = vi.fn(() => true);
  return child;
}

describe("PiRpcClient", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(path.join(os.tmpdir(), "pi-rpc-test-"));
    vi.mocked(spawn).mockReset();
  });

  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("spawns the pi process with the configured cwd", async () => {
    const cwd = "/tmp/normalized-workspace";
    const client = new PiRpcClient({
      agentSessionId: "agent-1",
      piSessionId: "pi-agent-1",
      cwd,
      sessionDir,
    });

    vi.mocked(spawn).mockReturnValue(createFakeChild() as never);
    await client.start();

    expect(spawn).toHaveBeenCalledWith(
      "pi",
      expect.any(Array),
      expect.objectContaining({ cwd }),
    );
  });

  it("spawns with --session-id by default", async () => {
    const client = new PiRpcClient({
      agentSessionId: "agent-1",
      piSessionId: "pi-agent-1",
      cwd: "/tmp/x",
      sessionDir,
    });

    vi.mocked(spawn).mockReturnValue(createFakeChild() as never);
    await client.start();

    const args = vi.mocked(spawn).mock.calls[0]?.[1] ?? [];
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("pi-agent-1");
    expect(args).not.toContain("--session");
  });

  it("spawns with --session <file> and never --session-id when a session file is given", async () => {
    const sessionFile = path.join(sessionDir, "2026-01-01T00-00-00-000Z_ext-abc.jsonl");
    const client = new PiRpcClient({
      agentSessionId: "agent-1",
      piSessionId: "pi-agent-1",
      cwd: "/tmp/x",
      sessionDir,
      sessionFile,
    });

    vi.mocked(spawn).mockReturnValue(createFakeChild() as never);
    await client.start();

    const args = vi.mocked(spawn).mock.calls[0]?.[1] ?? [];
    expect(args).toContain("--session");
    // The file form must win exclusively: pi creates a same-id empty session
    // when --session-id is combined or names an unknown session (context §3.3).
    expect(args[args.indexOf("--session") + 1]).toBe(sessionFile);
    expect(args).not.toContain("--session-id");
  });
});
