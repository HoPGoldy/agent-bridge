import type {
  ChannelStateStore,
  ClientSessionRecord,
  ClientSessionStateApi,
  ClientSessionStateCodec,
  ClientSessionStateStore,
} from "../types";
import { assertJsonCompatible } from "./json-compat";

export class ClientSessionStateError extends Error {
  override readonly name: string = "ClientSessionStateError";
}

export class ClientSessionStateTypeMismatchError extends ClientSessionStateError {
  override readonly name = "ClientSessionStateTypeMismatchError";
}

export class ClientSessionStateDecodeError extends ClientSessionStateError {
  override readonly name = "ClientSessionStateDecodeError";
}

export class ClientSessionStateUpdaterError extends ClientSessionStateError {
  override readonly name = "ClientSessionStateUpdaterError";
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
 * store cache or the caller's original object.
 */
function defensiveClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Session-scoped handle implementation. Unlike agent sessions, client
 * sessions have no explicit lifecycle (a chat exists as soon as it messages
 * the bot), so handles are cheap, never revoked, and records are created
 * lazily on the first `update`. All mutations go through the channel store's
 * serialized transaction queue, sharing one write order with bindings and
 * agent session state.
 */
class ClientSessionStateHandleImpl<TState extends object> implements ClientSessionStateApi<TState> {
  readonly clientSessionId: string;

  readonly #store: ChannelStateStore;
  readonly #clientType: string;
  readonly #codec: ClientSessionStateCodec<TState>;

  constructor(
    store: ChannelStateStore,
    clientType: string,
    codec: ClientSessionStateCodec<TState>,
    clientSessionId: string,
  ) {
    this.#store = store;
    this.#clientType = clientType;
    this.#codec = codec;
    this.clientSessionId = clientSessionId;
  }

  #decode(record: ClientSessionRecord): TState {
    try {
      // The codec never sees the live record.state reference, and its output
      // is cloned again so neither a mutating codec nor a caller-retained
      // decode result can reach the store cache or the persisted document.
      const decoded = this.#codec.decode(defensiveClone(record.state), record.stateVersion, {
        clientSessionId: this.clientSessionId,
      });
      return defensiveClone(decoded);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ClientSessionStateDecodeError(
        `cannot decode state for client session ${this.clientSessionId} (stateVersion=${record.stateVersion}): ${detail}`,
      );
    }
  }

  #encode(state: TState): unknown {
    const encoded = this.#codec.encode(state);
    assertJsonCompatible(encoded);
    // Store a fresh clone so the codec's output object (which may alias the
    // caller's `state` or be retained by the module) never becomes the live
    // cache reference. Only an explicit update can write.
    return defensiveClone(encoded);
  }

  #assertRecordType(record: ClientSessionRecord): void {
    if (record.clientType !== this.#clientType) {
      throw new ClientSessionStateTypeMismatchError(
        `client session ${this.clientSessionId} has clientType "${record.clientType}", expected "${this.#clientType}"`,
      );
    }
  }

  async #findRecord(): Promise<ClientSessionRecord | undefined> {
    await this.#store.flush();
    const state = await this.#store.load();
    return state.clientSessions[this.clientSessionId];
  }

  async read(): Promise<Readonly<TState> | undefined> {
    const record = await this.#findRecord();
    if (!record) {
      return undefined;
    }
    this.#assertRecordType(record);
    return this.#decode(record);
  }

  async update(updater: (current: Readonly<TState> | undefined) => TState): Promise<Readonly<TState>> {
    const clientSessionId = this.clientSessionId;
    const clientType = this.#clientType;
    const stateVersion = this.#codec.currentVersion;
    return this.#store.transaction<TState>((draft) => {
      const record = draft.clientSessions[clientSessionId];
      let current: TState | undefined;
      if (record) {
        this.#assertRecordType(record);
        current = this.#decode(record);
      }
      const next = updater(current === undefined ? undefined : defensiveClone(current));
      if (isThenable(next)) {
        throw new ClientSessionStateUpdaterError(
          "update updater must be synchronous; do not await inside the updater",
        );
      }
      const encoded = this.#encode(next);
      const now = new Date().toISOString();
      if (record) {
        record.state = encoded;
        record.stateVersion = stateVersion;
        record.updatedAt = now;
      } else {
        draft.clientSessions[clientSessionId] = {
          recordVersion: 1,
          clientType,
          stateVersion,
          createdAt: now,
          updatedAt: now,
          state: encoded,
        };
      }
      return defensiveClone(next);
    });
  }

  async flush(): Promise<void> {
    await this.#store.flush();
  }
}

/**
 * Creates the per-channel client session state store for one client module.
 * The store is scoped to the module's type and codec; adapters request
 * session-scoped handles from it and can never touch bindings, agent session
 * state, or other client sessions.
 */
export function createClientSessionStateStore<TState extends object>(args: {
  channelStateStore: ChannelStateStore;
  clientType: string;
  codec: ClientSessionStateCodec<TState>;
}): ClientSessionStateStore<TState> {
  return {
    session(clientSessionId: string): ClientSessionStateApi<TState> {
      return new ClientSessionStateHandleImpl(
        args.channelStateStore,
        args.clientType,
        args.codec,
        clientSessionId,
      );
    },
  };
}
