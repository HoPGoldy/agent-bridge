import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionBindingStore } from "../types";

const BINDINGS_DIR = path.join(os.homedir(), ".config", "agent-bridge", "session-bindings");

export function getSessionBindingStorePath(channelName: string): string {
  return path.join(BINDINGS_DIR, `${encodeURIComponent(channelName)}.json`);
}

export async function removeSessionBindingStore(channelName: string): Promise<void> {
  try {
    await unlink(getSessionBindingStorePath(channelName));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
}

export function createFileSessionBindingStore(filePath: string): SessionBindingStore {
  return {
    async load() {
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return {};
        }
        return parsed as Record<string, string>;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return {};
        }
        throw error;
      }
    },

    async save(bindings) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(bindings, null, 2)}\n`, "utf8");
    },
  };
}
