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

describe("resolveWorkingDirectory allowlist", () => {
  it("allows a target equal to the allowed root", async () => {
    const base = await makeBaseDir();
    const root = path.join(base, "projects");
    await mkdir(root, { recursive: true });

    await expect(
      resolveWorkingDirectory(root, { allowedWorkingDirectoryRoots: [root] }),
    ).resolves.toBe(await realpath(root));
  });

  it("allows a strict descendant of an allowed root", async () => {
    const base = await makeBaseDir();
    const root = path.join(base, "projects");
    const target = path.join(root, "project-a", "sub");
    await mkdir(target, { recursive: true });

    await expect(
      resolveWorkingDirectory(target, { allowedWorkingDirectoryRoots: [root] }),
    ).resolves.toBe(await realpath(target));
  });

  it("allows relative and ~ inputs that resolve inside the root", async () => {
    const base = await makeBaseDir();
    const root = path.join(base, "projects");
    const target = path.join(root, "project-a");
    await mkdir(target, { recursive: true });

    await expect(
      resolveWorkingDirectory("./projects/project-a", { cwd: base, allowedWorkingDirectoryRoots: [root] }),
    ).resolves.toBe(await realpath(target));
    await expect(
      resolveWorkingDirectory("~/projects/project-a", {
        homedir: base,
        allowedWorkingDirectoryRoots: [root],
      }),
    ).resolves.toBe(await realpath(target));
  });

  it("rejects a sibling-prefix root bypass (root /work vs target /work2)", async () => {
    const base = await makeBaseDir();
    const root = path.join(base, "work");
    const target = path.join(base, "work2");
    await mkdir(root, { recursive: true });
    await mkdir(target, { recursive: true });

    await expect(
      resolveWorkingDirectory(target, { allowedWorkingDirectoryRoots: [root] }),
    ).rejects.toThrow(/not inside an allowed root/);
  });

  it("rejects a target outside the root", async () => {
    const base = await makeBaseDir();
    const root = path.join(base, "projects");
    const target = path.join(base, "elsewhere");
    await mkdir(root, { recursive: true });
    await mkdir(target, { recursive: true });

    await expect(
      resolveWorkingDirectory(target, { allowedWorkingDirectoryRoots: [root] }),
    ).rejects.toThrow(/not inside an allowed root/);
  });

  it("rejects a .. escape that lexically starts inside the root", async () => {
    const base = await makeBaseDir();
    const root = path.join(base, "projects");
    const target = path.join(base, "projects", "project-a");
    await mkdir(target, { recursive: true });

    const escape = path.join(target, "..", "..", "elsewhere");
    await mkdir(path.join(base, "elsewhere"), { recursive: true });

    await expect(
      resolveWorkingDirectory(escape, { allowedWorkingDirectoryRoots: [root] }),
    ).rejects.toThrow(/not inside an allowed root/);
  });

  it("rejects a symlink inside the root that escapes it", async () => {
    const base = await makeBaseDir();
    const root = path.join(base, "projects");
    const outside = path.join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    const link = path.join(root, "escape");
    await symlink(outside, link);

    await expect(
      resolveWorkingDirectory(link, { allowedWorkingDirectoryRoots: [root] }),
    ).rejects.toThrow(/not inside an allowed root/);
  });

  it("allows child directories whose names start with two dots (e.g. ..foo, ...)", async () => {
    const base = await makeBaseDir();
    const root = path.join(base, "projects");
    await mkdir(path.join(root, "..foo"), { recursive: true });
    await mkdir(path.join(root, "..."), { recursive: true });

    await expect(
      resolveWorkingDirectory(path.join(root, "..foo"), { allowedWorkingDirectoryRoots: [root] }),
    ).resolves.toBe(await realpath(path.join(root, "..foo")));
    await expect(
      resolveWorkingDirectory(path.join(root, "..."), { allowedWorkingDirectoryRoots: [root] }),
    ).resolves.toBe(await realpath(path.join(root, "...")));
  });

  it("allows when any of multiple roots matches", async () => {
    const base = await makeBaseDir();
    const first = path.join(base, "one");
    const second = path.join(base, "two");
    const target = path.join(second, "project");
    await mkdir(first, { recursive: true });
    await mkdir(target, { recursive: true });

    await expect(
      resolveWorkingDirectory(target, {
        allowedWorkingDirectoryRoots: [first, second],
      }),
    ).resolves.toBe(await realpath(target));
  });

  it("allows a ~-expanded root", async () => {
    const homedir = await makeBaseDir();
    const root = path.join(homedir, "projects");
    const target = path.join(root, "project-a");
    await mkdir(target, { recursive: true });

    await expect(
      resolveWorkingDirectory(target, {
        homedir,
        allowedWorkingDirectoryRoots: ["~/projects"],
      }),
    ).resolves.toBe(await realpath(target));
  });

  it("is permissive with an empty allowlist", async () => {
    const base = await makeBaseDir();
    const target = path.join(base, "anywhere");
    await mkdir(target, { recursive: true });

    await expect(
      resolveWorkingDirectory(target, { allowedWorkingDirectoryRoots: [] }),
    ).resolves.toBe(await realpath(target));
  });

  it("never checks the default cwd for a bare /new even when roots are configured", async () => {
    const base = await makeBaseDir();
    const root = path.join(base, "projects");
    await mkdir(root, { recursive: true });

    await expect(
      resolveWorkingDirectory(undefined, { cwd: base, allowedWorkingDirectoryRoots: [root] }),
    ).resolves.toBe(base);
    await expect(
      resolveWorkingDirectory("", { cwd: base, allowedWorkingDirectoryRoots: [root] }),
    ).resolves.toBe(base);
  });

  it("canonicalizes an allowed root through realpath (symlinked root)", async () => {
    const base = await makeBaseDir();
    const realRoot = path.join(base, "real-projects");
    const rootLink = path.join(base, "projects-link");
    const target = path.join(rootLink, "project-a");
    await mkdir(realRoot, { recursive: true });
    await symlink(realRoot, rootLink);
    await mkdir(target, { recursive: true });

    // target itself is reached through the symlinked root; both canonicalize to
    // the same real location so the boundary check passes.
    await expect(
      resolveWorkingDirectory(target, { allowedWorkingDirectoryRoots: [rootLink] }),
    ).resolves.toBe(await realpath(path.join(realRoot, "project-a")));
  });

  it("rejects a root that is not a directory with a clear error", async () => {
    const base = await makeBaseDir();
    const target = path.join(base, "projects", "project-a");
    const rootFile = path.join(base, "root-file.txt");
    await mkdir(target, { recursive: true });
    await writeFile(rootFile, "file");

    await expect(
      resolveWorkingDirectory(target, { allowedWorkingDirectoryRoots: [rootFile] }),
    ).rejects.toThrow(/invalid allowed working directory root.*not a directory/);
  });

  it("rejects a missing root with a clear error", async () => {
    const base = await makeBaseDir();
    const missing = path.join(base, "missing-root");
    const target = path.join(base, "anywhere");
    await mkdir(target, { recursive: true });

    await expect(
      resolveWorkingDirectory(target, { allowedWorkingDirectoryRoots: [missing] }),
    ).rejects.toThrow(/invalid allowed working directory root.*no such file or directory/);
  });
});
