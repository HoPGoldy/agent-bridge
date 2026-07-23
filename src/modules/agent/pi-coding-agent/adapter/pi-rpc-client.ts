import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createLogger, type Logger } from "../../../../core/logger";
import { resolveMediaPromptExtensionPath } from "./pi-extension-path";

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
  model?: string;
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

function attachStrictJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
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
  readonly #options: Required<Omit<PiRpcClientOptions, "model" | "extraArgs" | "logger">> & {
    model?: string;
    extraArgs: string[];
  };
  readonly #logger: Logger;
  #process: ChildProcessWithoutNullStreams | null = null;
  #stderr = "";
  #requestId = 0;
  #pendingRequests = new Map<string, PendingRequest>();
  #detachStdoutReader: (() => void) | null = null;
  #settledWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  #started = false;
  #stopping = false;
  #exitError: Error | null = null;
  #eventListeners = new Set<(event: PiRpcEvent) => void>();

  constructor(options: PiRpcClientOptions) {
    this.#options = {
      agentSessionId: options.agentSessionId,
      piSessionId: options.piSessionId,
      cwd: options.cwd ?? process.cwd(),
      sessionDir: options.sessionDir ?? defaultSessionDir(),
      bin: options.bin ?? "pi",
      model: options.model,
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
      "--extension",
      resolveMediaPromptExtensionPath(),
      ...(this.#options.model ? ["--model", this.#options.model] : []),
      ...this.#options.extraArgs,
    ];

    const child = spawn(this.#options.bin, args, {
      cwd: this.#options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#logger.info(
      `spawned pi process (pid=${child.pid} bin=${this.#options.bin} args=${args.join(" ")} cwd=${this.#options.cwd})`,
    );

    this.#process = child;
    this.#started = true;
    this.#exitError = null;

    child.stderr.on("data", (chunk) => {
      this.#stderr += chunk.toString();
      this.#logger.debug(`pi stderr: ${chunk.toString().trimEnd()}`);
    });

    child.once("error", (error) => {
      const wrapped = new Error(`pi RPC process error: ${error.message}`);
      this.#handleExitError(wrapped);
    });

    child.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${String(code)}`;
      const stderr = this.#stderr.trim();
      const message = stderr
        ? `pi RPC process exited (${detail}): ${stderr}`
        : `pi RPC process exited (${detail})`;
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

    this.#stopping = true;
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
          this.#logger.warn("pi process did not exit after SIGTERM, sending SIGKILL");
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

  async getState(): Promise<{ sessionName?: string }> {
    const response = await this.#send({ type: "get_state" });
    return (response.data as { sessionName?: string } | undefined) ?? {};
  }

  async setSessionName(name: string): Promise<void> {
    await this.#send({ type: "set_session_name", name });
  }

  async #send(command: PiRpcCommand): Promise<PiRpcResponse> {
    if (!this.#process?.stdin.writable) {
      throw this.#exitError ?? new Error("pi RPC process is not writable");
    }

    const id = `req-${++this.#requestId}`;
    const payload = { ...command, id };
    this.#logger.debug(`sending command (id=${id} type=${command.type})`);

    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.#pendingRequests.set(id, { resolve, reject });

      this.#process!.stdin.write(serializeJsonLine(payload), (error) => {
        if (!error) return;
        this.#pendingRequests.delete(id);
        this.#logger.error(`failed to write command to pi RPC stdin (id=${id}):`, error);
        reject(new Error(`Failed to write to pi RPC stdin: ${error.message}`));
      });
    }).then((response) => {
      this.#logger.debug(`received response (id=${id} type=${command.type} success=${response.success})`);
      if (!response.success) {
        this.#logger.error(
          `pi RPC command failed (id=${id} type=${response.command}): ${response.error ?? "unknown error"}`,
        );
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
      if (!id) {
        this.#logger.warn("ignoring RPC response without id:", JSON.stringify(response).slice(0, 500));
        return;
      }
      const pending = this.#pendingRequests.get(id);
      if (!pending) {
        this.#logger.warn(`ignoring RPC response with unknown id (id=${id})`);
        return;
      }
      this.#pendingRequests.delete(id);
      pending.resolve(response);
      return;
    }

    const event = payload as PiRpcEvent;
    this.#logger.debug(`received event (type=${event.type})`);
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
    if (this.#stopping) {
      this.#logger.debug(`pi process exited during stop: ${error.message}`);
    } else {
      this.#logger.error(error.message);
    }
    this.#stopping = false;
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
