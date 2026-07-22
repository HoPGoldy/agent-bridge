import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createLogger, type Logger } from "../../../core/logger";

export type PiRpcCommand =
  | { id?: string; type: "prompt"; message: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "set_session_name"; name: string };

export type PiRpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
};

export type PiRpcEvent = {
  type: string;
  [key: string]: unknown;
};

export interface PiRpcClientOptions {
  agentSessionId: string;
  piSessionId: string;
  cwd?: string;
  sessionDir?: string;
  bin?: string;
  extraArgs?: string[];
  logger?: Logger;
}

type PendingRequest = {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
};

function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function attachStrictJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.length > 0) {
        onLine(line);
      }
    }
  };

  const onEnd = () => {
    buffer += decoder.end();
    const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    if (tail.length > 0) {
      onLine(tail);
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

function defaultSessionDir(): string {
  return path.join(os.homedir(), ".config", "agent-bridge", "pi-sessions");
}

export class PiRpcClient {
  readonly #options: Required<Omit<PiRpcClientOptions, "extraArgs" | "logger">> & { extraArgs: string[] };
  readonly #logger: Logger;
  #process: ChildProcessWithoutNullStreams | null = null;
  #stderr = "";
  #requestId = 0;
  #pendingRequests = new Map<string, PendingRequest>();
  #detachStdoutReader: (() => void) | null = null;
  #settledWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  #started = false;
  #exitError: Error | null = null;
  #eventListeners = new Set<(event: PiRpcEvent) => void>();

  constructor(options: PiRpcClientOptions) {
    this.#options = {
      agentSessionId: options.agentSessionId,
      piSessionId: options.piSessionId,
      cwd: options.cwd ?? process.cwd(),
      sessionDir: options.sessionDir ?? defaultSessionDir(),
      bin: options.bin ?? "pi",
      extraArgs: options.extraArgs ?? [],
    };
    this.#logger = options.logger ?? createLogger("pi-rpc");
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("PiRpcClient already started");
    }

    await mkdir(this.#options.sessionDir, { recursive: true });

    const args = [
      "--mode",
      "rpc",
      "--session-id",
      this.#options.piSessionId,
      "--session-dir",
      this.#options.sessionDir,
      ...this.#options.extraArgs,
    ];

    const child = spawn(this.#options.bin, args, {
      cwd: this.#options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#process = child;
    this.#started = true;
    this.#exitError = null;

    child.stderr.on("data", (chunk) => {
      this.#stderr += chunk.toString();
    });

    child.once("error", (error) => {
      const wrapped = new Error(`pi RPC process error: ${error.message}`);
      this.#handleExitError(wrapped);
    });

    child.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${String(code)}`;
      const stderr = this.#stderr.trim();
      const message = stderr ? `pi RPC process exited (${detail}): ${stderr}` : `pi RPC process exited (${detail})`;
      this.#handleExitError(new Error(message));
    });

    this.#detachStdoutReader = attachStrictJsonlReader(child.stdout, (line) => {
      this.#handleLine(line);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    if (this.#exitError) {
      throw this.#exitError;
    }

    const state = await this.getState();
    if (!state.sessionName) {
      await this.setSessionName(this.#options.agentSessionId);
    }
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (!child) return;

    this.#detachStdoutReader?.();
    this.#detachStdoutReader = null;

    await new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        resolve();
      };

      child.once("exit", () => done());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        done();
      }, 1000);
    });

    this.#process = null;
    this.#started = false;
    this.#rejectPending(new Error("pi RPC client stopped"));
  }

  async prompt(message: string): Promise<void> {
    await this.#send({ type: "prompt", message });
  }

  async abort(): Promise<void> {
    await this.#send({ type: "abort" });
  }

  async compact(customInstructions?: string): Promise<{ estimatedTokensAfter?: number; summary?: string }> {
    const response = await this.#send({ type: "compact", customInstructions });
    const data = response.data as { estimatedTokensAfter?: number; summary?: string } | undefined;
    return data ?? {};
  }

  async getLastAssistantText(): Promise<string | null> {
    const response = await this.#send({ type: "get_last_assistant_text" });
    const data = response.data as { text?: string | null } | undefined;
    return data?.text ?? null;
  }

  async getState(): Promise<{ sessionName?: string }> {
    const response = await this.#send({ type: "get_state" });
    return (response.data as { sessionName?: string } | undefined) ?? {};
  }

  async setSessionName(name: string): Promise<void> {
    await this.#send({ type: "set_session_name", name });
  }

  waitForSettled(timeoutMs = 10 * 60 * 1000): Promise<void> {
    if (!this.#process) {
      return Promise.reject(new Error("pi RPC client is not running"));
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for pi agent to settle after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#settledWaiters.push({
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  async #send(command: PiRpcCommand): Promise<PiRpcResponse> {
    if (!this.#process?.stdin.writable) {
      throw this.#exitError ?? new Error("pi RPC process is not writable");
    }

    const id = `req-${++this.#requestId}`;
    const payload = { ...command, id };

    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.#pendingRequests.set(id, { resolve, reject });

      this.#process!.stdin.write(serializeJsonLine(payload), (error) => {
        if (!error) return;
        this.#pendingRequests.delete(id);
        reject(new Error(`Failed to write to pi RPC stdin: ${error.message}`));
      });
    }).then((response) => {
      if (!response.success) {
        throw new Error(response.error ?? `pi RPC command failed: ${response.command}`);
      }
      return response;
    });
  }

  #handleLine(line: string): void {
    let payload: PiRpcResponse | PiRpcEvent;
    try {
      payload = JSON.parse(line) as PiRpcResponse | PiRpcEvent;
    } catch (error) {
      this.#logger.error("failed to parse line:", error);
      return;
    }

    if (payload.type === "response") {
      const response = payload as PiRpcResponse;
      const id = response.id;
      if (!id) return;
      const pending = this.#pendingRequests.get(id);
      if (!pending) return;
      this.#pendingRequests.delete(id);
      pending.resolve(response);
      return;
    }

    const event = payload as PiRpcEvent;
    for (const listener of this.#eventListeners) {
      listener(event);
    }

    if (event.type === "agent_settled") {
      const waiters = this.#settledWaiters.splice(0);
      for (const waiter of waiters) {
        waiter.resolve();
      }
    }
  }

  #handleExitError(error: Error): void {
    this.#exitError = error;
    this.#process = null;
    this.#started = false;
    this.#detachStdoutReader?.();
    this.#detachStdoutReader = null;
    this.#rejectPending(error);
  }

  #rejectPending(error: Error): void {
    for (const [id, pending] of this.#pendingRequests) {
      this.#pendingRequests.delete(id);
      pending.reject(error);
    }

    const waiters = this.#settledWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }
}
