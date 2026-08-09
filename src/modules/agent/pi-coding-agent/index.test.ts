import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piCodingAgentModule } from "./index";

const adapterOptions: Array<{ agentSessionId: string; cwd: string }> = [];

vi.mock("./adapter/pi-coding-agent-adapter", () => ({
  PiCodingAgentAdapter: class FakePiCodingAgentAdapter {
    constructor(options: { agentSessionId: string; cwd: string }) {
      adapterOptions.push(options);
    }
  },
}));

describe("Pi coding agent config collector", () => {
  it("shows a provider-qualified model example without making it the default value", async () => {
    const input = vi.fn(async () => "");
    const collector = piCodingAgentModule.createConfigCollector?.();

    const config = await collector?.collect({
      input,
      select: vi.fn(),
      confirm: vi.fn(),
      close: vi.fn(),
    });

    expect(input).toHaveBeenCalledWith("Pi model (leave empty for pi default)", {
      placeholder: "Example: azure-openai-responses/gpt-5.6-terra",
    });
    expect(config).toEqual({});
  });
});

describe("Pi coding agent module working directory", () => {
  let base: string;
  let projectDir: string;

  beforeEach(async () => {
    adapterOptions.length = 0;
    base = await mkdtemp(path.join(os.tmpdir(), "pi-module-wd-"));
    projectDir = path.join(base, "project a 中文");
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const common = { channelName: "test-channel", language: "en-US" as const };

  it("passes the canonicalized working directory to the adapter on create", async () => {
    const expected = await realpath(projectDir);

    const created = await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      workingDirectory: projectDir,
    });

    expect(created.agentSessionId).toMatch(/^pi-coding-agent:/);
    expect(adapterOptions.at(-1)).toEqual(
      expect.objectContaining({
        agentSessionId: created.agentSessionId,
        cwd: expected,
      }),
    );
  });

  it("passes the canonicalized working directory to the adapter on resume", async () => {
    const expected = await realpath(projectDir);

    await piCodingAgentModule.resumeAgentSession!({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:resumed",
      workingDirectory: projectDir,
    });

    expect(adapterOptions.at(-1)).toEqual(
      expect.objectContaining({
        agentSessionId: "pi-coding-agent:resumed",
        cwd: expected,
      }),
    );
  });

  it("uses the same canonicalization for create and resume", async () => {
    const expected = await realpath(projectDir);

    await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      workingDirectory: projectDir,
    });
    await piCodingAgentModule.resumeAgentSession!({
      config: {},
      common,
      agentSessionId: "pi-coding-agent:resumed",
      workingDirectory: projectDir,
    });

    expect(adapterOptions).toHaveLength(2);
    expect(adapterOptions[0]!.cwd).toBe(expected);
    expect(adapterOptions[1]!.cwd).toBe(expected);
  });

  it("defaults to process.cwd() when no working directory is provided", async () => {
    await piCodingAgentModule.createAgentSession({ config: {}, common });

    expect(adapterOptions.at(-1)?.cwd).toBe(process.cwd());
  });

  it("rejects an invalid working directory on create with a clear error", async () => {
    await expect(
      piCodingAgentModule.createAgentSession({
        config: {},
        common,
        workingDirectory: path.join(base, "missing"),
      }),
    ).rejects.toThrow(/invalid working directory.*no such file or directory/);

    expect(adapterOptions).toHaveLength(0);
  });

  it("allows a working directory inside an allowed root on create and resume", async () => {
    const root = path.join(base, "projects");
    const target = path.join(root, "project-a");
    await mkdir(target, { recursive: true });
    const expected = await realpath(target);

    const created = await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      workingDirectory: target,
      allowedWorkingDirectoryRoots: [root],
    });
    await piCodingAgentModule.resumeAgentSession!({
      config: {},
      common,
      agentSessionId: created.agentSessionId,
      workingDirectory: target,
      allowedWorkingDirectoryRoots: [root],
    });

    expect(adapterOptions).toHaveLength(2);
    expect(adapterOptions[0]!.cwd).toBe(expected);
    expect(adapterOptions[1]!.cwd).toBe(expected);
  });

  it("rejects a working directory outside the allowed roots on create and resume", async () => {
    const root = path.join(base, "projects");
    const outside = path.join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });

    await expect(
      piCodingAgentModule.createAgentSession({
        config: {},
        common,
        workingDirectory: outside,
        allowedWorkingDirectoryRoots: [root],
      }),
    ).rejects.toThrow(/not inside an allowed root/);

    await expect(
      piCodingAgentModule.resumeAgentSession!({
        config: {},
        common,
        agentSessionId: "pi-coding-agent:resumed",
        workingDirectory: outside,
        allowedWorkingDirectoryRoots: [root],
      }),
    ).rejects.toThrow(/not inside an allowed root/);

    expect(adapterOptions).toHaveLength(0);
  });

  it("keeps the default cwd behavior for a bare /new even when roots are configured", async () => {
    const root = path.join(base, "projects");
    await mkdir(root, { recursive: true });

    await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      allowedWorkingDirectoryRoots: [root],
    });

    expect(adapterOptions.at(-1)?.cwd).toBe(process.cwd());
  });

  it("is permissive with an empty allowlist", async () => {
    const target = path.join(base, "anywhere");
    await mkdir(target, { recursive: true });

    const created = await piCodingAgentModule.createAgentSession({
      config: {},
      common,
      workingDirectory: target,
      allowedWorkingDirectoryRoots: [],
    });

    expect(adapterOptions.at(-1)?.cwd).toBe(await realpath(target));
    expect(created.agentSessionId).toMatch(/^pi-coding-agent:/);
  });
});
