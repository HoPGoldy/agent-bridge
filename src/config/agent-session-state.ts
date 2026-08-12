import type {
  AgentSessionRecord,
  AgentSessionStateApi,
  AgentSessionStateCodec,
  AgentSessionStateRegistry,
  ChannelStateStore,
  NewAgentSessionStateApi,
} from "../types";
import { assertJsonCompatible } from "./json-compat";

export class AgentSessionStateError extends Error {
  override readonly name: string = "AgentSessionStateError";
}

export class AgentSessionStateNotFoundError extends AgentSessionStateError {
  override readonly name = "AgentSessionStateNotFoundError";
}

export class AgentSessionStateConflictError extends AgentSessionStateError {
  override readonly name = "AgentSessionStateConflictError";
}

export class AgentSessionStateRevokedError extends AgentSessionStateError {
  override readonly name = "AgentSessionStateRevokedError";
}

export class AgentSessionStateNotInitializedError extends AgentSessionStateError {
  override readonly name = "AgentSessionStateNotInitializedError";
}

export class AgentSessionStateTypeMismatchError extends AgentSessionStateError {
  override readonly name = "AgentSessionStateTypeMismatchError";
}

export class AgentSessionStateDecodeError extends AgentSessionStateError {
  override readonly name = "AgentSessionStateDecodeError";
}

export class AgentSessionStateUpdaterError extends AgentSessionStateError {
  override readonly name = "AgentSessionStateUpdaterError";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * JSON-safe defensive deep clone.
 *
 * Every value this helper is applied to is JSON-compatible (committed store
 * state, encode output after `assertJsonCompatible`, or decode input read from
 * the store), so a JSON round-trip is a faithful clone. It deliberately strips
 * class instances and functions and duplicates shared references, matching
 * explicit JSON semantics: mutating the returned copy can never reach the
 * store cache or the caller's original object. Primitives are immutable and
 * returned as-is.
 */
function defensiveClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Per-session gate shared by every handle for the same agent session. Revoking
 * flips the flag on the shared object, so all existing handles fail together,
 * while a later `open` creates a fresh gate (resume after idle release).
 */
interface SharedHandleState {
  revoked: boolean;
  initialized: boolean;
}

class StateHandleImpl<TState extends object> implements NewAgentSessionStateApi<TState> {
  readonly agentSessionId: string;

  readonly #registry: AgentSessionStateRegistryImpl;
  readonly #shared: SharedHandleState;
  readonly #agentType: string;
  readonly #codec: AgentSessionStateCodec<TState>;
  readonly #createMode: boolean;

  constructor(
    registry: AgentSessionStateRegistryImpl,
    agentSessionId: string,
    agentType: string,
    codec: AgentSessionStateCodec<TState>,
    shared: SharedHandleState,
    createMode: boolean,
  ) {
    this.#registry = registry;
    this.agentSessionId = agentSessionId;
    this.#agentType = agentType;
    this.#codec = codec;
    this.#shared = shared;
    this.#createMode = createMode;
  }

  #assertActive(): void {
    if (this.#shared.revoked) {
      throw new AgentSessionStateRevokedError(
        `agent session ${this.agentSessionId} state handle has been revoked`,
      );
    }
  }

  #assertInitialized(): void {
    if (this.#createMode && !this.#shared.initialized) {
      throw new AgentSessionStateNotInitializedError(
        `agent session ${this.agentSessionId} has not been initialized yet; call initialize() first`,
      );
    }
  }

  #decode(record: AgentSessionRecord): TState {
    try {
      // The codec never sees the live record.state reference, and its output
      // is cloned again so neither a mutating codec nor a caller-retained
      // decode result can reach the store cache or the persisted document.
      const decoded = this.#codec.decode(defensiveClone(record.state), record.stateVersion);
      return defensiveClone(decoded);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AgentSessionStateDecodeError(
        `cannot decode state for agent session ${this.agentSessionId} (stateVersion=${record.stateVersion}): ${detail}`,
      );
    }
  }

  #encode(state: TState): unknown {
    const encoded = this.#codec.encode(state);
    assertJsonCompatible(encoded);
    // Store a fresh clone so the codec's output object (which may alias the
    // caller's `state` or be retained by the module) never becomes the live
    // cache reference. Only an explicit replace/update can write.
    return defensiveClone(encoded);
  }

  async read(): Promise<Readonly<TState>> {
    this.#assertActive();
    this.#assertInitialized();
    const record = await this.#registry.readRecord(this.agentSessionId);
    return this.#decode(record);
  }

  async replace(next: TState): Promise<void> {
    this.#assertActive();
    this.#assertInitialized();
    const encoded = this.#encode(next);
    const agentSessionId = this.agentSessionId;
    const stateVersion = this.#codec.currentVersion;
    await this.#registry.store.transaction((draft) => {
      this.#assertActive();
      const record = draft.agentSessions[agentSessionId];
      if (!record) {
        throw new AgentSessionStateNotFoundError(
          `agent session ${agentSessionId} does not exist`,
        );
      }
      record.state = encoded;
      record.stateVersion = stateVersion;
      record.updatedAt = new Date().toISOString();
    });
  }

  async update(updater: (current: Readonly<TState>) => TState): Promise<Readonly<TState>> {
    this.#assertActive();
    this.#assertInitialized();
    const agentSessionId = this.agentSessionId;
    const stateVersion = this.#codec.currentVersion;
    return this.#registry.store.transaction<TState>((draft) => {
      this.#assertActive();
      const record = draft.agentSessions[agentSessionId];
      if (!record) {
        throw new AgentSessionStateNotFoundError(
          `agent session ${agentSessionId} does not exist`,
        );
      }
      const current = this.#decode(record);
      const next = updater(current);
      if (isThenable(next)) {
        throw new AgentSessionStateUpdaterError(
          "update updater must be synchronous; do not await inside the updater",
        );
      }
      const encoded = this.#encode(next);
      record.state = encoded;
      record.stateVersion = stateVersion;
      record.updatedAt = new Date().toISOString();
      return defensiveClone(next);
    });
  }

  async flush(): Promise<void> {
    this.#assertActive();
    await this.#registry.store.flush();
  }

  async initialize(initial: TState): Promise<void> {
    if (!this.#createMode) {
      throw new AgentSessionStateConflictError(
        `agent session ${this.agentSessionId} is not in creation mode`,
      );
    }
    this.#assertActive();
    if (this.#shared.initialized) {
      throw new AgentSessionStateConflictError(
        `agent session ${this.agentSessionId} has already been initialized`,
      );
    }
    const encoded = this.#encode(initial);
    const agentSessionId = this.agentSessionId;
    const agentType = this.#agentType;
    const stateVersion = this.#codec.currentVersion;
    await this.#registry.store.transaction((draft) => {
      this.#assertActive();
      if (draft.agentSessions[agentSessionId]) {
        throw new AgentSessionStateConflictError(
          `agent session ${agentSessionId} already exists`,
        );
      }
      const now = new Date().toISOString();
      draft.agentSessions[agentSessionId] = {
        recordVersion: 1,
        agentType,
        stateVersion,
        createdAt: now,
        updatedAt: now,
        state: encoded,
      };
    });
    this.#shared.initialized = true;
  }
}

class AgentSessionStateRegistryImpl implements AgentSessionStateRegistry {
  readonly #store: ChannelStateStore;
  readonly #entries = new Map<string, SharedHandleState>();
  /**
   * Per-session generation counter. Every revoke/delete of a session bumps it
   * so an in-flight `reserve`/`open` parked on store I/O can detect that the
   * session was invalidated while it was waiting and reject instead of
   * returning a dead handle.
   */
  readonly #generations = new Map<string, number>();

  constructor(store: ChannelStateStore) {
    this.#store = store;
  }

  get store(): ChannelStateStore {
    return this.#store;
  }

  #generationOf(agentSessionId: string): number {
    return this.#generations.get(agentSessionId) ?? 0;
  }

  #bumpGeneration(agentSessionId: string): void {
    this.#generations.set(agentSessionId, this.#generationOf(agentSessionId) + 1);
  }

  async reserve<TState extends object>(args: {
    agentSessionId: string;
    agentType: string;
    codec: AgentSessionStateCodec<TState>;
  }): Promise<NewAgentSessionStateApi<TState>> {
    if (this.#entries.has(args.agentSessionId)) {
      throw new AgentSessionStateConflictError(
        `agent session ${args.agentSessionId} is already reserved or open`,
      );
    }
    const generation = this.#generationOf(args.agentSessionId);
    // Pre-register synchronously so concurrent reserves for the same id race
    // safely (one wins, the other observes the reservation immediately).
    const shared: SharedHandleState = { revoked: false, initialized: false };
    this.#entries.set(args.agentSessionId, shared);
    try {
      const existing = await this.#findRecord(args.agentSessionId);
      // Re-check after the await: a concurrent revoke/delete may have flipped
      // the shared gate while this reservation was parked on store I/O. Never
      // return a dead handle.
      if (
        this.#generationOf(args.agentSessionId) !== generation ||
        this.#entries.get(args.agentSessionId) !== shared ||
        shared.revoked
      ) {
        throw new AgentSessionStateRevokedError(
          `agent session ${args.agentSessionId} was revoked while being reserved`,
        );
      }
      if (existing) {
        throw new AgentSessionStateConflictError(
          `agent session ${args.agentSessionId} already exists in the store`,
        );
      }
    } catch (error) {
      if (this.#entries.get(args.agentSessionId) === shared) {
        this.#entries.delete(args.agentSessionId);
      }
      throw error;
    }
    return new StateHandleImpl<TState>(
      this,
      args.agentSessionId,
      args.agentType,
      args.codec,
      shared,
      true,
    );
  }

  async open<TState extends object>(args: {
    agentSessionId: string;
    agentType: string;
    codec: AgentSessionStateCodec<TState>;
  }): Promise<AgentSessionStateApi<TState>> {
    const generation = this.#generationOf(args.agentSessionId);
    const record = await this.readRecord(args.agentSessionId);
    if (record.agentType !== args.agentType) {
      throw new AgentSessionStateTypeMismatchError(
        `agent session ${args.agentSessionId} has agentType "${record.agentType}", expected "${args.agentType}"`,
      );
    }
    // Eagerly validate that the persisted state decodes with the supplied
    // codec. The codec only ever sees a defensive clone, never the live
    // record.state reference.
    try {
      args.codec.decode(defensiveClone(record.state), record.stateVersion);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AgentSessionStateDecodeError(
        `cannot decode state for agent session ${args.agentSessionId} (stateVersion=${record.stateVersion}): ${detail}`,
      );
    }
    // Re-check after the awaits above: a concurrent revoke/delete may have
    // invalidated the session while this open was parked on store I/O.
    if (this.#generationOf(args.agentSessionId) !== generation) {
      throw new AgentSessionStateRevokedError(
        `agent session ${args.agentSessionId} was revoked while being opened`,
      );
    }
    // The get+set below is synchronous, so concurrent opens share one gate.
    let shared = this.#entries.get(args.agentSessionId);
    if (!shared) {
      shared = { revoked: false, initialized: true };
      this.#entries.set(args.agentSessionId, shared);
    }
    return new StateHandleImpl<TState>(
      this,
      args.agentSessionId,
      args.agentType,
      args.codec,
      shared,
      false,
    );
  }

  async revoke(agentSessionId: string): Promise<void> {
    const shared = this.#entries.get(agentSessionId);
    if (shared) {
      shared.revoked = true;
      this.#entries.delete(agentSessionId);
      this.#bumpGeneration(agentSessionId);
    }
  }

  async delete(agentSessionId: string): Promise<void> {
    await this.revoke(agentSessionId);
    // Always bump the generation, even when no live handle existed: the record
    // itself is going away, so any in-flight open/reserve parked on store I/O
    // must reject rather than return a handle for a deleted session.
    this.#bumpGeneration(agentSessionId);
    await this.#store.transaction((draft) => {
      delete draft.agentSessions[agentSessionId];
    });
  }

  /** Reads the record behind all pending writes; throws when it is missing. */
  async readRecord(agentSessionId: string): Promise<AgentSessionRecord> {
    const record = await this.#findRecord(agentSessionId);
    if (!record) {
      throw new AgentSessionStateNotFoundError(
        `agent session ${agentSessionId} does not exist`,
      );
    }
    return record;
  }

  /** Reads the record behind all pending writes; returns undefined when missing. */
  async #findRecord(agentSessionId: string): Promise<AgentSessionRecord | undefined> {
    await this.#store.flush();
    const state = await this.#store.load();
    return state.agentSessions[agentSessionId];
  }
}

/** Creates a core-visible registry bound to one channel's state store. */
export function createAgentSessionStateRegistry(
  channelStateStore: ChannelStateStore,
): AgentSessionStateRegistry {
  return new AgentSessionStateRegistryImpl(channelStateStore);
}
