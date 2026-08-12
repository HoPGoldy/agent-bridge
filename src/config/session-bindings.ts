import { unlink } from "node:fs/promises";
import type {
  AgentSessionRecord,
  ChannelStateStore,
  SessionBinding,
  SessionBindingStore,
} from "../types";
import {
  backfillWorkingDirectory,
  buildMigratedAgentRecord,
  createFileChannelStateStore,
  extractWorkingDirectory,
  getChannelStateStorePath,
} from "./channel-state";

/**
 * Legacy-compatible path helper. The persisted document is now the full
 * per-channel state document (see `getChannelStateStorePath`); this name is
 * kept for callers that predate the ChannelStateStore split.
 */
export function getSessionBindingStorePath(channelName: string): string {
  return getChannelStateStorePath(channelName);
}

/** Removes the persisted per-channel state document, if present. */
export async function removeSessionBindingStore(channelName: string): Promise<void> {
  try {
    await unlink(getSessionBindingStorePath(channelName));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Normalizes a raw stored binding value into a {@link SessionBinding}.
 *
 * Kept as a compatibility helper; whole documents are now normalized through
 * `normalizeChannelState` in `./channel-state`.
 */
export function normalizeSessionBinding(value: unknown): SessionBinding | null {
  if (typeof value === "string") {
    return value.length > 0 ? { agentSessionId: value } : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const binding = value as Record<string, unknown>;
    if (typeof binding.agentSessionId === "string" && binding.agentSessionId.length > 0) {
      return {
        agentSessionId: binding.agentSessionId,
        ...(typeof binding.workingDirectory === "string" && binding.workingDirectory.length > 0
          ? { workingDirectory: binding.workingDirectory }
          : {}),
      };
    }
  }
  return null;
}

/**
 * Legacy entry point for {@link GatewayCore}: adapts the full per-channel
 * state document to the old `SessionBindingStore` surface.
 *
 * Bindings are persisted as pure `clientSessionId -> agentSessionId` strings;
 * agent-side metadata such as the working directory lives in `agentSessions`
 * records and is reconstructed on load so existing resume behavior is
 * preserved. This facade is the compatibility seam: the next lifecycle
 * refactor should move GatewayCore onto {@link ChannelStateStore} directly.
 */
export function createFileSessionBindingStore(filePath: string): SessionBindingStore {
  return createSessionBindingStoreFacade(createFileChannelStateStore(filePath));
}

/**
 * Adapts any {@link ChannelStateStore} to the legacy `SessionBindingStore` surface.
 *
 * The facade keeps no local cache: reads come from the store's committed
 * state and saves go through the store's serialized transaction, so a facade
 * save can never overwrite a concurrent agent-session-state write and vice
 * versa.
 */
export function createSessionBindingStoreFacade(channelStateStore: ChannelStateStore): SessionBindingStore {
  return {
    async load() {
      const document = await channelStateStore.load();
      const bindings: Record<string, SessionBinding> = {};
      for (const [clientSessionId, agentSessionId] of Object.entries(document.bindings)) {
        const workingDirectory = extractWorkingDirectory(document.agentSessions[agentSessionId]);
        bindings[clientSessionId] = {
          agentSessionId,
          ...(workingDirectory !== undefined ? { workingDirectory } : {}),
        };
      }
      return bindings;
    },

    async save(bindings) {
      await channelStateStore.transaction((draft) => {
        const nextBindings: Record<string, string> = {};
        const nextAgentSessions: Record<string, AgentSessionRecord> = { ...draft.agentSessions };

        for (const [clientSessionId, binding] of Object.entries(bindings)) {
          nextBindings[clientSessionId] = binding.agentSessionId;
          const existing = nextAgentSessions[binding.agentSessionId];
          if (!existing) {
            // Mirror the migration policy: keep the binding, but never create an
            // `agentType: "unknown"` record for an uninferable agent id.
            const created = buildMigratedAgentRecord(binding.agentSessionId, binding.workingDirectory);
            if (created) {
              nextAgentSessions[binding.agentSessionId] = created;
            }
          } else if (
            binding.workingDirectory !== undefined &&
            extractWorkingDirectory(existing) === undefined
          ) {
            const backfilled = backfillWorkingDirectory(existing, binding.workingDirectory);
            if (backfilled !== existing) {
              nextAgentSessions[binding.agentSessionId] = backfilled;
            }
          }
        }

        draft.bindings = nextBindings;
        draft.agentSessions = nextAgentSessions;
      });
    },
  };
}
