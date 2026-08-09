import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkingDirectory } from "./working-directory";

const tempDirs: string[] = [];

async function makeBaseDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-wd-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveWorkingDirectory", () => {
  it("keeps the default cwd when no working directory is provided", async () => {
    const base = await makeBaseDir();
    await expect(resolveWorkingDirectory(undefined, { cwd: base })).resolves.toBe(base);
    await expect(resolveWorkingDirectory("", { cwd: base })).resolves.toBe(base);
    await expect(resolveWorkingDirectory("   ", { cwd: base })).resolves.toBe(base);
  });

  it("uses process.cwd() when no working directory and no base cwd are provided", async () => {
    await expect(resolveWorkingDirectory(undefined)).resolves.toBe(process.cwd());
  });

  it("accepts an absolute directory and canonicalizes it", async () => {
    const base = await makeBaseDir();
    const target = path.join(base, "project");
    await mkdir(target, { recursive: true });

    await expect(resolveWorkingDirectory(target)).resolves.toBe(await realpath(target));
  });

  it("resolves a relative directory against the base cwd", async () => {
    const base = await makeBaseDir();
    const target = path.join(base, "sub", "project");
    await mkdir(target, { recursive: true });

    await expect(resolveWorkingDirectory("./sub/project", { cwd: base })).resolves.toBe(
      await realpath(target),
    );
  });

  it("expands ~ and ~/... against the home directory", async () => {
    const homedir = await makeBaseDir();
    const target = path.join(homedir, "project");
    await mkdir(target, { recursive: true });

    await expect(resolveWorkingDirectory("~", { homedir })).resolves.toBe(await realpath(homedir));
    await expect(resolveWorkingDirectory("~/project", { homedir })).resolves.toBe(
      await realpath(target),
    );
  });

  it("accepts paths containing spaces and unicode characters", async () => {
    const base = await makeBaseDir();
    const target = path.join(base, "My Project 中文 🚀");
    await mkdir(target, { recursive: true });

    await expect(resolveWorkingDirectory(target)).resolves.toBe(await realpath(target));
  });

  it("canonicalizes symlinks to the real directory", async () => {
    const base = await makeBaseDir();
    const realDir = path.join(base, "real");
    const link = path.join(base, "link");
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, link);

    const result = await resolveWorkingDirectory(link);
    expect(result).toBe(await realpath(realDir));
    expect(result).not.toBe(link);
  });

  it("rejects a file path because it is not a directory", async () => {
    const base = await makeBaseDir();
    const file = path.join(base, "file.txt");
    await writeFile(file, "content");

    await expect(resolveWorkingDirectory(file)).rejects.toThrow(/not a directory/);
  });

  it("rejects a missing path with a clear reason", async () => {
    const base = await makeBaseDir();
    const missing = path.join(base, "does-not-exist");

    await expect(resolveWorkingDirectory(missing)).rejects.toThrow(/no such file or directory/);
    await expect(resolveWorkingDirectory(missing)).rejects.toThrow(/invalid working directory/);
  });
});
