import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSessionRecord, ChannelPersistentState, ChannelStateStore } from "../types";
import { assertJsonCompatible } from "./json-compat";

export const CHANNEL_STATE_VERSION = 2 as const;
export const AGENT_SESSION_RECORD_VERSION = 1 as const;
export const MIGRATED_AGENT_STATE_VERSION = 1 as const;

const STATE_DIR = path.join(os.homedir(), ".config", "agent-bridge", "session-bindings");

/** Bridge agent session id prefixes for the built-in agent modules. */
const KNOWN_AGENT_TYPE_PREFIXES: ReadonlyArray<readonly [prefix: string, agentType: string]> = [
  ["pi-coding-agent:", "pi-coding-agent"],
  ["opencode:", "opencode"],
];

/** Maps a bridge agent session id to its agent module type by id prefix. */
export function inferAgentType(agentSessionId: string): string | null {
  for (const [prefix, agentType] of KNOWN_AGENT_TYPE_PREFIXES) {
    if (agentSessionId.startsWith(prefix)) {
      return agentType;
    }
  }
  return null;
}

export function getChannelStateStorePath(channelName: string): string {
  return path.join(STATE_DIR, `${encodeURIComponent(channelName)}.json`);
}

export function emptyChannelState(): ChannelPersistentState {
  return {
    version: CHANNEL_STATE_VERSION,
    bindings: {},
    agentSessions: {},
  };
}

export class ChannelStateFormatError extends Error {
  override readonly name = "ChannelStateFormatError";
}

export interface DroppedBindingEntry {
  clientSessionId: string;
  reason: string;
}

export interface DroppedAgentRecordEntry {
  agentSessionId: string;
  reason: string;
}

export interface SkippedAgentRecordEntry {
  agentSessionId: string;
  clientSessionIds: string[];
  reason: string;
}

export interface MetadataConflictEntry {
  agentSessionId: string;
  field: "workingDirectory";
  kept: string | null;
  discarded: string | null;
}

export interface ChannelStateMigrationReport {
  /** True when the input was a legacy binding map rather than a versioned document. */
  migrated: boolean;
  keptBindings: number;
  createdAgentRecords: number;
  droppedBindings: DroppedBindingEntry[];
  droppedAgentRecords: DroppedAgentRecordEntry[];
  skippedAgentRecords: SkippedAgentRecordEntry[];
  metadataConflicts: MetadataConflictEntry[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function emptyReport(migrated: boolean): ChannelStateMigrationReport {
  return {
    migrated,
    keptBindings: 0,
    createdAgentRecords: 0,
    droppedBindings: [],
    droppedAgentRecords: [],
    skippedAgentRecords: [],
    metadataConflicts: [],
    warnings: [],
  };
}

/**
 * Normalizes a raw persisted document into a {@link ChannelPersistentState}.
 *
 * Accepts, in order:
 * 1. the current versioned document (`version: 2` with `bindings` and
 *    `agentSessions`);
 * 2. legacy object bindings `Record<clientId, { agentSessionId, workingDirectory? }>`;
 * 3. legacy string bindings `Record<clientId, agentSessionId>`.
 *
 * The returned report makes every migration decision explicit: dropped corrupt
 * entries, records skipped because the agent type cannot be inferred, and
 * conflicting shared-agent metadata (resolved deterministically, first wins).
 *
 * A top-level `version` key whose value is not the supported numeric version
 * is rejected with {@link ChannelStateFormatError} (fail-safe) instead of
 * being treated as a legacy binding map.
 */
export function normalizeChannelState(raw: unknown): {
  state: ChannelPersistentState;
  report: ChannelStateMigrationReport;
} {
  if (!isRecord(raw)) {
    throw new ChannelStateFormatError(
      `channel state document must be a JSON object, got ${describeValue(raw)}`,
    );
  }

  if ("version" in raw) {
    if (typeof raw.version !== "number") {
      throw new ChannelStateFormatError(
        `channel state document has a top-level 'version' key with a non-numeric value (${describeValue(raw.version)}); expected version ${CHANNEL_STATE_VERSION}. A legacy binding map whose client id is literally named "version" is not auto-migrated (fail-safe)`,
      );
    }
    return normalizeVersionedDocument(raw);
  }

  return migrateLegacyBindings(raw);
}

function normalizeVersionedDocument(raw: Record<string, unknown>): {
  state: ChannelPersistentState;
  report: ChannelStateMigrationReport;
} {
  const report = emptyReport(false);

  if (raw.version !== CHANNEL_STATE_VERSION) {
    throw new ChannelStateFormatError(
      `unsupported channel state version ${String(raw.version)} (expected ${CHANNEL_STATE_VERSION})`,
    );
  }

  if (!isRecord(raw.bindings)) {
    throw new ChannelStateFormatError("channel state document is missing a valid 'bindings' object");
  }
  if (!isRecord(raw.agentSessions)) {
    throw new ChannelStateFormatError("channel state document is missing a valid 'agentSessions' object");
  }

  const bindings: Record<string, string> = {};
  for (const [clientSessionId, value] of Object.entries(raw.bindings)) {
    if (typeof value === "string" && value.length > 0) {
      bindings[clientSessionId] = value;
      report.keptBindings += 1;
    } else {
      report.droppedBindings.push({
        clientSessionId,
        reason: `binding value must be a non-empty string, got ${describeValue(value)}`,
      });
    }
  }

  const agentSessions: Record<string, AgentSessionRecord> = {};
  for (const [agentSessionId, value] of Object.entries(raw.agentSessions)) {
    const record = normalizeAgentSessionRecord(value);
    if (record) {
      agentSessions[agentSessionId] = record;
    } else {
      report.droppedAgentRecords.push({
        agentSessionId,
        reason: "agent session record failed envelope validation",
      });
    }
  }

  return {
    state: { version: CHANNEL_STATE_VERSION, bindings, agentSessions },
    report,
  };
}

function normalizeAgentSessionRecord(value: unknown): AgentSessionRecord | null {
  if (!isRecord(value)) return null;
  if (value.recordVersion !== AGENT_SESSION_RECORD_VERSION) return null;
  if (typeof value.agentType !== "string" || value.agentType.length === 0) return null;
  if (typeof value.stateVersion !== "number" || !Number.isInteger(value.stateVersion) || value.stateVersion < 0) {
    return null;
  }
  if (typeof value.createdAt !== "string" || value.createdAt.length === 0) return null;
  if (typeof value.updatedAt !== "string" || value.updatedAt.length === 0) return null;
  if (!("state" in value)) return null;

  return {
    recordVersion: AGENT_SESSION_RECORD_VERSION,
    agentType: value.agentType,
    stateVersion: value.stateVersion,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    state: value.state,
  };
}

function migrateLegacyBindings(raw: Record<string, unknown>): {
  state: ChannelPersistentState;
  report: ChannelStateMigrationReport;
} {
  const report = emptyReport(true);
  const bindings: Record<string, string> = {};
  const agentSessions: Record<string, AgentSessionRecord> = {};

  for (const [clientSessionId, value] of Object.entries(raw)) {
    const parsed = parseLegacyBinding(value);
    if (!parsed) {
      report.droppedBindings.push({
        clientSessionId,
        reason: `unsupported legacy binding value ${describeValue(value)}`,
      });
      continue;
    }

    const { agentSessionId, workingDirectory } = parsed;
    bindings[clientSessionId] = agentSessionId;
    report.keptBindings += 1;

    const existing = agentSessions[agentSessionId];
    if (existing) {
      // The same agent id is referenced by another client binding: reconcile
      // metadata deterministically. A missing workingDirectory is enriched when
      // a later binding provides one; conflicting values keep the first.
      const existingWorkingDirectory = extractWorkingDirectory(existing);
      if (workingDirectory === undefined || existingWorkingDirectory === workingDirectory) {
        continue;
      }
      if (existingWorkingDirectory === undefined) {
        agentSessions[agentSessionId] = backfillWorkingDirectory(existing, workingDirectory);
        continue;
      }
      report.metadataConflicts.push({
        agentSessionId,
        field: "workingDirectory",
        kept: existingWorkingDirectory,
        discarded: workingDirectory,
      });
      report.warnings.push(
        `agent session ${agentSessionId} is referenced with conflicting workingDirectory values; kept "${existingWorkingDirectory}", discarded "${workingDirectory}"`,
      );
      continue;
    }

    const created = buildMigratedAgentRecord(agentSessionId, workingDirectory);
    if (!created) {
      // Fail-safe: keep the routing binding even though a record cannot be
      // created because the module type is unknown. The skip is surfaced in
      // the report so the entry is never silently lost or guessed at.
      report.skippedAgentRecords.push({
        agentSessionId,
        clientSessionIds: [clientSessionId],
        reason: `cannot infer agent module type from id prefix: ${agentSessionId}`,
      });
      report.warnings.push(
        `binding ${clientSessionId} -> ${agentSessionId} kept, but no agent session record was created: cannot infer agent module type from id prefix`,
      );
      continue;
    }

    agentSessions[agentSessionId] = created;
    report.createdAgentRecords += 1;
  }

  return {
    state: { version: CHANNEL_STATE_VERSION, bindings, agentSessions },
    report,
  };
}

function parseLegacyBinding(value: unknown): { agentSessionId: string; workingDirectory?: string } | null {
  if (typeof value === "string") {
    return value.length > 0 ? { agentSessionId: value } : null;
  }
  if (isRecord(value) && typeof value.agentSessionId === "string" && value.agentSessionId.length > 0) {
    return {
      agentSessionId: value.agentSessionId,
      ...(typeof value.workingDirectory === "string" && value.workingDirectory.length > 0
        ? { workingDirectory: value.workingDirectory }
        : {}),
    };
  }
  return null;
}

/**
 * Builds a {@link AgentSessionRecord} for a binding that predates the
 * agent-session store, or `null` when the agent module type cannot be inferred
 * from the id prefix.
 *
 * The `state` payload is a minimal migrated-state marker
 * (`migratedFromBinding: true`) plus any working directory carried over from
 * the legacy binding, so later migration/validation can distinguish
 * module-owned state from binding-derived state.
 *
 * The unknown-prefix policy is shared by legacy migration and facade saves:
 * keep the routing binding, but never invent an `agentType: "unknown"` record
 * for a module the bridge cannot resume. Pre-existing records with an unknown
 * or provider agent type in a versioned document are preserved as-is and are
 * never touched by this helper.
 */
export function buildMigratedAgentRecord(
  agentSessionId: string,
  workingDirectory?: string,
): AgentSessionRecord | null {
  const agentType = inferAgentType(agentSessionId);
  if (!agentType) {
    return null;
  }
  const now = new Date().toISOString();
  return {
    recordVersion: AGENT_SESSION_RECORD_VERSION,
    agentType,
    stateVersion: MIGRATED_AGENT_STATE_VERSION,
    createdAt: now,
    updatedAt: now,
    state: {
      migratedFromBinding: true,
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    },
  };
}

/** Reads a working directory out of a record state, when present as a string. */
export function extractWorkingDirectory(record: AgentSessionRecord | undefined): string | undefined {
  if (!record || !isRecord(record.state)) {
    return undefined;
  }
  const workingDirectory = record.state.workingDirectory;
  return typeof workingDirectory === "string" && workingDirectory.length > 0
    ? workingDirectory
    : undefined;
}

/**
 * Backfills a working directory onto a binding-migrated record. Records whose
 * state is not the binding-migrated marker are left untouched (module-owned
 * state is owned by the module, not by this store layer).
 */
export function backfillWorkingDirectory(
  record: AgentSessionRecord,
  workingDirectory: string,
): AgentSessionRecord {
  if (!isRecord(record.state) || record.state.migratedFromBinding !== true) {
    return record;
  }
  return {
    ...record,
    updatedAt: new Date().toISOString(),
    state: { ...record.state, workingDirectory },
  };
}

/**
 * Raised when a transaction updater violates the synchronous contract or a
 * document fails write validation before being persisted.
 */
export class ChannelStateTransactionError extends Error {
  override readonly name = "ChannelStateTransactionError";
}

function isChannelPersistentState(value: unknown): value is ChannelPersistentState {
  return (
    isRecord(value) &&
    value.version === CHANNEL_STATE_VERSION &&
    isRecord(value.bindings) &&
    isRecord(value.agentSessions)
  );
}

/** Rejects any document that would be unsafe to persist. */
function assertWritableChannelState(state: ChannelPersistentState): void {
  if (!isChannelPersistentState(state)) {
    throw new ChannelStateTransactionError(
      "refusing to persist an invalid channel state document",
    );
  }
  for (const [clientSessionId, agentSessionId] of Object.entries(state.bindings)) {
    if (typeof agentSessionId !== "string" || agentSessionId.length === 0) {
      throw new ChannelStateTransactionError(
        `binding ${clientSessionId} is not a non-empty agent session id`,
      );
    }
  }
  for (const [agentSessionId, record] of Object.entries(state.agentSessions)) {
    if (!normalizeAgentSessionRecord(record)) {
      throw new ChannelStateTransactionError(
        `agent session record ${agentSessionId} failed envelope validation`,
      );
    }
  }
  assertJsonCompatible(state);
}

/**
 * Deep-clones a committed document for transactional drafts. Committed
 * documents are always JSON-safe (validated on load and before every write),
 * so a JSON round-trip is a faithful clone.
 */
function cloneCommittedState(state: ChannelPersistentState): ChannelPersistentState {
  return JSON.parse(JSON.stringify(state)) as ChannelPersistentState;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * File-backed {@link ChannelStateStore}. Loads normalize legacy documents in
 * memory (no write-through); every commit is atomic (same-directory temp file
 * + rename) and serialized through a single FIFO queue shared by `save` and
 * `transaction`, so a crash or a failed write can never corrupt the persisted
 * document and concurrent writers can never overwrite each other. A failed
 * write rejects its own caller while the queue keeps running for later
 * writes.
 */
export function createFileChannelStateStore(filePath: string): ChannelStateStore {
  let cache: ChannelPersistentState | null = null;
  let loading: Promise<ChannelPersistentState> | null = null;
  let tail: Promise<void> = Promise.resolve();

  async function readStateFile(): Promise<ChannelPersistentState> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return emptyChannelState();
      }
      throw error;
    }

    const parsed: unknown = JSON.parse(raw);
    const { state, report } = normalizeChannelState(parsed);
    if (report.warnings.length > 0) {
      console.warn(`[channel-state] ${filePath}: ${report.warnings.join("; ")}`);
    }
    return state;
  }

  async function ensureLoaded(): Promise<ChannelPersistentState> {
    if (cache) {
      return cache;
    }
    loading ??= readStateFile().then((state) => {
      cache = state;
      return state;
    });
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  async function commit(state: ChannelPersistentState): Promise<void> {
    assertWritableChannelState(state);
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    const tempPath = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(tempPath, filePath);
      cache = state;
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  /** Runs `fn` strictly in order behind every earlier write and returns its result. */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = tail.then(fn);
      const handled = run.then(
        () => undefined,
        () => undefined,
      );
      tail = handled;
      run.then(resolve, reject);
    });
  }

  return {
    async load() {
      return ensureLoaded();
    },

    save(state: ChannelPersistentState): Promise<void> {
      return enqueue(async () => {
        await commit(state);
      });
    },

    transaction<T>(
      updater: (draft: ChannelPersistentState) => T | ChannelPersistentState,
    ): Promise<T> {
      return enqueue(async () => {
        const current = await ensureLoaded();
        const draft = cloneCommittedState(current);
        const result = updater(draft);
        if (isThenable(result)) {
          throw new ChannelStateTransactionError(
            "transaction updater must be synchronous; do not await inside the updater",
          );
        }
        const next: ChannelPersistentState = isChannelPersistentState(result) ? result : draft;
        await commit(next);
        return result as T;
      });
    },

    async flush() {
      await tail;
    },
  };
}

/**
 * In-memory {@link ChannelStateStore} with the same serialized transaction
 * semantics as the file-backed store (single FIFO queue, atomic draft commits,
 * no durability). Used when no durable store is injected, for example in unit
 * tests or in-memory runtimes.
 */
export function createInMemoryChannelStateStore(): ChannelStateStore {
  let cache: ChannelPersistentState = emptyChannelState();
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = tail.then(fn);
      const handled = run.then(
        () => undefined,
        () => undefined,
      );
      tail = handled;
      run.then(resolve, reject);
    });
  }

  return {
    async load() {
      return cache;
    },

    save(state: ChannelPersistentState): Promise<void> {
      return enqueue(async () => {
        assertWritableChannelState(state);
        cache = cloneCommittedState(state);
      });
    },

    transaction<T>(
      updater: (draft: ChannelPersistentState) => T | ChannelPersistentState,
    ): Promise<T> {
      return enqueue(async () => {
        const draft = cloneCommittedState(cache);
        const result = updater(draft);
        if (isThenable(result)) {
          throw new ChannelStateTransactionError(
            "transaction updater must be synchronous; do not await inside the updater",
          );
        }
        const next: ChannelPersistentState = isChannelPersistentState(result) ? result : draft;
        assertWritableChannelState(next);
        cache = next;
        return result as T;
      });
    },

    async flush() {
      await tail;
    },
  };
}
