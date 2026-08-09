import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileSessionBindingStore, normalizeSessionBinding } from "./session-bindings";

describe("session bindings", () => {
  const tmpDirs: string[] = [];

  async function tmpFilePath(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-bridge-bindings-"));
    tmpDirs.push(dir);
    return path.join(dir, "bindings.json");
  }

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      await rm(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("normalizes legacy string values and object bindings", () => {
    expect(normalizeSessionBinding("agent-1")).toEqual({ agentSessionId: "agent-1" });
    expect(
      normalizeSessionBinding({ agentSessionId: "agent-1", workingDirectory: "/tmp/a" }),
    ).toEqual({ agentSessionId: "agent-1", workingDirectory: "/tmp/a" });
    expect(normalizeSessionBinding(null)).toBeNull();
    expect(normalizeSessionBinding(42)).toBeNull();
    expect(normalizeSessionBinding({})).toBeNull();
    expect(normalizeSessionBinding({ agentSessionId: 42 })).toBeNull();
    expect(normalizeSessionBinding([])).toBeNull();
  });

  it("loads legacy string-format binding files", async () => {
    const file = await tmpFilePath();
    await writeFile(file, JSON.stringify({ "client-1": "agent-1" }), "utf8");

    const store = createFileSessionBindingStore(file);
    await expect(store.load()).resolves.toEqual({
      "client-1": { agentSessionId: "agent-1" },
    });
  });

  it("loads object-format binding files and drops invalid entries", async () => {
    const file = await tmpFilePath();
    await writeFile(
      file,
      JSON.stringify({
        "client-1": { agentSessionId: "agent-1", workingDirectory: "/tmp/a" },
        "client-2": 42,
        "client-3": "agent-3",
      }),
      "utf8",
    );

    const store = createFileSessionBindingStore(file);
    await expect(store.load()).resolves.toEqual({
      "client-1": { agentSessionId: "agent-1", workingDirectory: "/tmp/a" },
      "client-3": { agentSessionId: "agent-3" },
    });
  });

  it("persists workingDirectory in the saved binding file", async () => {
    const file = await tmpFilePath();
    const store = createFileSessionBindingStore(file);

    await store.save({
      "client-1": { agentSessionId: "agent-1", workingDirectory: "/tmp/a" },
      "client-2": { agentSessionId: "agent-2" },
    });

    const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    expect(raw).toEqual({
      "client-1": { agentSessionId: "agent-1", workingDirectory: "/tmp/a" },
      "client-2": { agentSessionId: "agent-2" },
    });
  });

  it("returns an empty map when the binding file does not exist", async () => {
    const file = await tmpFilePath();
    const missing = path.join(path.dirname(file), "missing.json");

    const store = createFileSessionBindingStore(missing);
    await expect(store.load()).resolves.toEqual({});
  });
});
