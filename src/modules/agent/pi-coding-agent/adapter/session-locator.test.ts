import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locatePiSession, PiSessionLocateError } from "./session-locator";

interface TempDirs {
  root: string;
  bridgeDir: string;
  piProjectDir: string;
}

const realHomedir = os.homedir();
let dirs: TempDirs;

async function writeSessionFile(dir: string, id: string, header: Record<string, unknown>): Promise<string> {
  const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, ...header })}\n{"type":"message"}\n`);
  return file;
}

async function secondSessionFile(dir: string, id: string): Promise<string> {
  const file = path.join(dir, `2026-02-02T00-00-00-000Z_${id}.jsonl`);
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: dir })}\n`);
  return file;
}

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-session-locator-"));
  const bridgeDir = path.join(root, "bridge-sessions");
  await mkdir(bridgeDir);
  const piProjectDir = path.join(root, ".pi", "agent", "sessions", "--home-test-project--");
  await mkdir(piProjectDir, { recursive: true });
  dirs = { root, bridgeDir, piProjectDir };
});

afterEach(async () => {
  await rm(dirs.root, { recursive: true, force: true });
});

const options = () => ({ sessionDir: dirs.bridgeDir, homedir: dirs.root });

describe("locatePiSession", () => {
  it("resolves an exact id in the bridge session dir and reads id and cwd from the header", async () => {
    const file = await writeSessionFile(dirs.bridgeDir, "aaaaaaaa-1111-2222-3333-444444444444", {
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      cwd: "/tmp/project-a",
    });

    const located = await locatePiSession("aaaaaaaa-1111-2222-3333-444444444444", options());

    expect(located.sessionFile).toBe(file);
    expect(located.sessionId).toBe("aaaaaaaa-1111-2222-3333-444444444444");
    expect(located.cwd).toBe("/tmp/project-a");
  });

  it("matches bridge ids that carry the pi-coding-agent prefix exactly", async () => {
    const file = await writeSessionFile(dirs.bridgeDir, "pi-coding-agent.aaaaaaaa-1111-2222-3333-444444444444", {
      id: "pi-coding-agent.aaaaaaaa-1111-2222-3333-444444444444",
      cwd: "/tmp/project-a",
    });

    expect((await locatePiSession("pi-coding-agent.aaaaaaaa-1111-2222-3333-444444444444", options())).sessionFile).toBe(file);
  });

  it("resolves a unique id prefix in the bridge session dir", async () => {
    const file = await writeSessionFile(dirs.bridgeDir, "aaaaaaaa-1111-2222-3333-444444444444", {
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      cwd: "/tmp/project-a",
    });

    const located = await locatePiSession("aaaaaaaa", options());
    expect(located.sessionFile).toBe(file);
  });

  it("rejects an ambiguous prefix listing every candidate id", async () => {
    await writeSessionFile(dirs.bridgeDir, "aaaaaaaa-1111-2222-3333-444444444444", {
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      cwd: "/tmp/a",
    });
    await secondSessionFile(dirs.bridgeDir, "aaaaaaaa-9999-2222-3333-444444444444");

    try {
      await locatePiSession("aaaaaaaa", options());
      expect.unreachable("expected PiSessionLocateError");
    } catch (error) {
      expect(error).toBeInstanceOf(PiSessionLocateError);
      const candidates = (error as PiSessionLocateError).candidates!;
      expect(candidates).toHaveLength(2);
      expect(candidates).toContain("aaaaaaaa-1111-2222-3333-444444444444");
      expect(candidates).toContain("aaaaaaaa-9999-2222-3333-444444444444");
      expect((error as Error).message).toContain("ambiguous");
      expect((error as Error).message).toContain('"aaaaaaaa"');
    }
  });

  it("resolves an exact id in the pi default sessions root across project directories", async () => {
    const file = await writeSessionFile(dirs.piProjectDir, "bbbbbbbb-1111-2222-3333-444444444444", {
      id: "bbbbbbbb-1111-2222-3333-444444444444",
      cwd: "/home/test/project",
    });

    const located = await locatePiSession("bbbbbbbb-1111-2222-3333-444444444444", options());
    expect(located.sessionFile).toBe(file);
    expect(located.cwd).toBe("/home/test/project");
  });

  it("prefers the bridge session dir over the pi default sessions root", async () => {
    await writeSessionFile(dirs.piProjectDir, "cccccccc-1111-2222-3333-444444444444", {
      id: "cccccccc-1111-2222-3333-444444444444",
      cwd: "/from-pi-root",
    });
    const bridgeFile = await writeSessionFile(dirs.bridgeDir, "cccccccc-1111-2222-3333-444444444444", {
      id: "cccccccc-1111-2222-3333-444444444444",
      cwd: "/from-bridge-dir",
    });

    expect((await locatePiSession("cccccccc-1111-2222-3333-444444444444", options())).sessionFile).toBe(bridgeFile);
  });

  it("prefers an exact id match over a prefix match within the same tier", async () => {
    const exactFile = await writeSessionFile(dirs.bridgeDir, "dddddddd-1111-2222-3333-444444444444", {
      id: "dddddddd-1111-2222-3333-444444444444",
      cwd: "/exact",
    });
    await secondSessionFile(dirs.bridgeDir, "dddddddd-9999-2222-3333-444444444444");

    const located = await locatePiSession("dddddddd-1111-2222-3333-444444444444", options());
    expect(located.sessionFile).toBe(exactFile);
  });

  it("treats path-shaped input as a literal file path (relative input resolves against the injected base dir)", async () => {
    const file = await writeSessionFile(dirs.bridgeDir, "eeeeeeee-1111-2222-3333-444444444444", {
      id: "eeeeeeee-1111-2222-3333-444444444444",
      cwd: "/tmp/project-e",
    });

    const located = await locatePiSession(`2026-01-01T00-00-00-000Z_eeeeeeee-1111-2222-3333-444444444444.jsonl`, {
      ...options(),
      cwd: dirs.bridgeDir,
    });
    expect(located.sessionFile).toBe(file);
  });

  it("expands `~` in path-shaped input", async () => {
    const file = await writeSessionFile(dirs.bridgeDir, "eeeeeeee-1111-2222-3333-444444444444", {
      id: "eeeeeeee-1111-2222-3333-444444444444",
      cwd: "/tmp/project-e",
    });
    const relative = path.relative(dirs.root, file);

    const located = await locatePiSession(`~/${relative}`, options());
    expect(located.sessionFile).toBe(file);
  });

  it("canonicalizes the located file through symlinks", async () => {
    const file = await writeSessionFile(dirs.bridgeDir, "ffffffff-1111-2222-3333-444444444444", {
      id: "ffffffff-1111-2222-3333-444444444444",
      cwd: "/tmp/project-f",
    });
    const link = path.join(dirs.root, "link.jsonl");
    await symlink(file, link);

    const located = await locatePiSession(link, options());
    expect(located.sessionFile).toBe(file);
  });

  it("fails with the raw query for a path-shaped file that does not exist", async () => {
    const missing = path.join(dirs.root, "no-such-session.jsonl");
    await expect(locatePiSession(missing, options())).rejects.toThrow(
      new RegExp(`"${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
    );
  });

  it("fails with the raw query when nothing matches any search location", async () => {
    await expect(locatePiSession("12345678-1111-2222-3333-444444444444", options())).rejects.toThrow(
      /provider session "12345678-1111-2222-3333-444444444444" not found/,
    );
  });

  it("fails for an empty or whitespace-only query", async () => {
    await expect(locatePiSession("   ", options())).rejects.toThrow(/must not be empty/);
  });

  it("does not treat a longer id's suffix as an exact match", async () => {
    const fullId = "aaaaaaaa-1111-2222-3333-444444444444";
    const suffix = "444444444444"; // tail of the full id, not a prefix
    await writeSessionFile(dirs.bridgeDir, fullId, {
      id: fullId,
      cwd: "/tmp/project-a",
    });

    // A pure suffix must not resolve exactly, nor by prefix: not found.
    await expect(locatePiSession(suffix, options())).rejects.toThrow(
      new RegExp(`provider session "${suffix}" not found`),
    );
  });

  it("treats a longer id's suffix as an ambiguous prefix hit when several ids share the suffix-prefixed form", async () => {
    // "aaaaaaaa-1111" is a prefix of both ids: the ambiguity path still works.
    await writeSessionFile(dirs.bridgeDir, "aaaaaaaa-1111-2222-3333-444444444444", {
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      cwd: "/tmp/a",
    });
    await secondSessionFile(dirs.bridgeDir, "aaaaaaaa-1111-9999-3333-444444444444");

    try {
      await locatePiSession("aaaaaaaa-1111", options());
      expect.unreachable("expected PiSessionLocateError");
    } catch (error) {
      expect(error).toBeInstanceOf(PiSessionLocateError);
      expect((error as PiSessionLocateError).candidates).toHaveLength(2);
    }
  });

  it("fails with a clear error when the first line is not valid JSON", async () => {
    const file = path.join(dirs.bridgeDir, "2026-01-01T00-00-00-000Z_11111111-1111-2222-3333-444444444444.jsonl");
    await writeFile(file, "not json at all\n{\"type\":\"message\"}\n");

    await expect(locatePiSession("11111111", options())).rejects.toThrow(
      new RegExp(`malformed session header in "${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
    );
  });

  it("fails when the header lacks id or cwd fields", async () => {
    const file = path.join(dirs.bridgeDir, "2026-01-01T00-00-00-000Z_22222222-1111-2222-3333-444444444444.jsonl");
    await writeFile(file, `${JSON.stringify({ type: "session", version: 3 })}\n`);

    await expect(locatePiSession("22222222", options())).rejects.toThrow(
      /expected non-empty "id" and "cwd" fields/,
    );
  });

  it("scans nothing when the bridge session dir is not configured", async () => {
    const file = await writeSessionFile(dirs.bridgeDir, "99999999-1111-2222-3333-444444444444", {
      id: "99999999-1111-2222-3333-444444444444",
      cwd: "/tmp/x",
    });

    await expect(locatePiSession("99999999", { homedir: dirs.root })).rejects.toThrow(/not found/);
    expect((await import("node:fs/promises")).stat(file)).toBeDefined();
  });

  it("reads a session whose header line is much longer than the rest of the file", async () => {
    // A single-line (no trailing newline) file exercises the stream end path.
    const file = path.join(dirs.bridgeDir, "2026-01-01T00-00-00-000Z_77777777-1111-2222-3333-444444444444.jsonl");
    await writeFile(
      file,
      JSON.stringify({ type: "session", version: 3, id: "77777777-1111-2222-3333-444444444444", cwd: "/tmp/one-line" }),
    );

    const located = await locatePiSession("77777777", options());
    expect(located.cwd).toBe("/tmp/one-line");
  });
});
