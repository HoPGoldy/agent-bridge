import type { Event } from "@opencode-ai/sdk/v2/types";
import { createLogger, type Logger } from "../../../../core/logger";
import type { OpenCodeApi } from "./opencode-api";

export interface OpenCodeRuntimeAdapter {
  readonly openCodeSessionId: string;
  handleOpenCodeEvent(event: Event): Promise<void>;
}

function eventSessionId(event: Event): string | undefined {
  const properties = event.properties as { sessionID?: unknown };
  return typeof properties.sessionID === "string" ? properties.sessionID : undefined;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class OpenCodeRuntime {
  readonly #api: OpenCodeApi;
  readonly #logger: Logger;
  readonly #adapters = new Map<string, OpenCodeRuntimeAdapter>();
  readonly #onEmpty?: () => void;
  readonly #describeError: (error: unknown) => string;
  #abortController: AbortController | null = null;
  #loopPromise: Promise<void> | null = null;
  #readyPromise: Promise<void> | null = null;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((error: unknown) => void) | null = null;
  #hasConnected = false;

  constructor({
    api,
    logger,
    onEmpty,
    describeError,
  }: {
    api: OpenCodeApi;
    logger?: Logger;
    onEmpty?: () => void;
    describeError?: (error: unknown) => string;
  }) {
    this.#api = api;
    this.#logger = logger ?? createLogger("opencode-runtime");
    this.#onEmpty = onEmpty;
    this.#describeError = describeError ?? ((error) => (error instanceof Error ? error.message : String(error)));
  }

  get api(): OpenCodeApi {
    return this.#api;
  }

  async register(adapter: OpenCodeRuntimeAdapter): Promise<void> {
    const existing = this.#adapters.get(adapter.openCodeSessionId);
    if (existing && existing !== adapter) {
      throw new Error(`OpenCode session is already registered: ${adapter.openCodeSessionId}`);
    }
    this.#adapters.set(adapter.openCodeSessionId, adapter);

    try {
      await this.#ensureStarted();
    } catch (error) {
      this.#adapters.delete(adapter.openCodeSessionId);
      if (this.#adapters.size === 0) await this.#shutdownLoop();
      throw error;
    }
  }

  async unregister(adapter: OpenCodeRuntimeAdapter): Promise<void> {
    if (this.#adapters.get(adapter.openCodeSessionId) === adapter) {
      this.#adapters.delete(adapter.openCodeSessionId);
    }
    if (this.#adapters.size === 0) {
      await this.#shutdownLoop();
      this.#onEmpty?.();
    }
  }

  async #ensureStarted(): Promise<void> {
    if (this.#loopPromise && this.#readyPromise) {
      await this.#readyPromise;
      return;
    }

    this.#abortController = new AbortController();
    this.#hasConnected = false;
    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#loopPromise = this.#runLoop(this.#abortController.signal);
    await this.#readyPromise;
  }

  async #shutdownLoop(): Promise<void> {
    this.#abortController?.abort();
    await this.#loopPromise?.catch(() => undefined);
    this.#abortController = null;
    this.#loopPromise = null;
    this.#readyPromise = null;
    this.#resolveReady = null;
    this.#rejectReady = null;
    this.#hasConnected = false;
  }

  async #runLoop(signal: AbortSignal): Promise<void> {
    let retryDelayMs = 250;
    while (!signal.aborted && this.#adapters.size > 0) {
      try {
        await this.#api.subscribe({
          signal,
          onConnected: async () => {
            this.#hasConnected = true;
            retryDelayMs = 250;
            await this.#recoverState();
            this.#resolveReady?.();
            this.#resolveReady = null;
            this.#rejectReady = null;
          },
          onEvent: (event) => this.#dispatch(event),
        });
        if (!signal.aborted) {
          this.#logger.warn("OpenCode SSE stream ended; reconnecting");
        }
      } catch (error) {
        if (signal.aborted) break;
        if (this.#resolveReady) {
          this.#rejectReady?.(error);
          this.#rejectReady = null;
          this.#resolveReady = null;
          return;
        }
        this.#logger.warn("OpenCode SSE connection failed; reconnecting", this.#describeError(error));
      }

      await abortableDelay(retryDelayMs, signal);
      retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
    }
  }

  async #recoverState(): Promise<void> {
    const [statuses, permissions, questions] = await Promise.all([
      this.#api.getSessionStatuses(),
      this.#api.listPermissions(),
      this.#api.listQuestions(),
    ]);

    for (const [sessionID, status] of Object.entries(statuses)) {
      await this.#dispatch({
        id: `recovered-status:${sessionID}`,
        type: "session.status",
        properties: { sessionID, status },
      });
    }
    for (const permission of permissions) {
      await this.#dispatch({
        id: `recovered-permission:${permission.id}`,
        type: "permission.asked",
        properties: permission,
      });
    }
    for (const question of questions) {
      await this.#dispatch({
        id: `recovered-question:${question.id}`,
        type: "question.asked",
        properties: question,
      });
    }
  }

  async #dispatch(event: Event): Promise<void> {
    const sessionID = eventSessionId(event);
    if (!sessionID) return;
    const adapter = this.#adapters.get(sessionID);
    if (!adapter) return;
    try {
      await adapter.handleOpenCodeEvent(event);
    } catch (error) {
      this.#logger.error(
        `failed to handle OpenCode event (session=${sessionID} type=${event.type})`,
        this.#describeError(error),
      );
    }
  }
}
