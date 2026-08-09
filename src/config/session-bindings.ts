import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionBinding, SessionBindingStore } from "../types";

const BINDINGS_DIR = path.join(os.homedir(), ".config", "agent-bridge", "session-bindings");

export function getSessionBindingStorePath(channelName: string): string {
  return path.join(BINDINGS_DIR, `${encodeURIComponent(channelName)}.json`);
}

/**
 * Normalizes a stored binding value into a {@link SessionBinding}.
 *
 * Older agent-bridge versions persisted plain agent session id strings; newer
 * versions persist `{ agentSessionId, workingDirectory? }` objects. Unknown
 * shapes are dropped so a corrupt or foreign entry never breaks the store.
 */
export function normalizeSessionBinding(value: unknown): SessionBinding | null {
  if (typeof value === "string") {
    return { agentSessionId: value };
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const binding = value as Record<string, unknown>;
    if (typeof binding.agentSessionId === "string") {
      return {
        agentSessionId: binding.agentSessionId,
        ...(typeof binding.workingDirectory === "string"
          ? { workingDirectory: binding.workingDirectory }
          : {}),
      };
    }
  }

  return null;
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
        const bindings: Record<string, SessionBinding> = {};
        for (const [clientSessionId, value] of Object.entries(parsed)) {
          const binding = normalizeSessionBinding(value);
          if (binding) {
            bindings[clientSessionId] = binding;
          }
        }
        return bindings;
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
