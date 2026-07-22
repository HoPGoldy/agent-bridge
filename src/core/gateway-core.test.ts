import { afterEach, describe, expect, it } from "vitest";
import { GatewayCore } from "./gateway-core";
import type {
  AgentAdapter,
  AgentInputEvent,
  AgentModule,
  AgentOutputEvent,
  ClientEgressEvent,
  ClientIngressEvent,
  IMAdapter,
} from "../types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await assertion();
      return;
    } catch {
      await sleep(10);
    }
  }
  await assertion();
}

class FakeIMAdapter implements IMAdapter {
  #onOutput: ((event: ClientIngressEvent) => Promise<void> | void) | null = null;
  readonly outputs: ClientEgressEvent[] = [];

  async start(onOutput: (event: ClientIngressEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
  }

  async stop(): Promise<void> {
    this.#onOutput = null;
  }

  async input(event: ClientEgressEvent): Promise<void> {
    this.outputs.push(event);
  }

  async isBusy(): Promise<boolean> {
    return false;
  }

  async emit(event: ClientIngressEvent): Promise<void> {
    if (!this.#onOutput) {
      throw new Error("FakeIMAdapter is not started");
    }
    await this.#onOutput(event);
  }
}

class FakeAgentAdapter implements AgentAdapter {
  readonly inputs: AgentInputEvent[] = [];
  readonly outputs: AgentOutputEvent[] = [];
  stopCount = 0;
  abortCount = 0;
  #onOutput: ((event: AgentOutputEvent) => Promise<void> | void) | null = null;

  constructor(readonly agentSessionId: string) {}

  async start(onOutput: (event: AgentOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    if (!this.retainOutputCallback) {
      this.#onOutput = null;
    }
  }

  retainOutputCallback = false;

  async abort(): Promise<void> {
    this.abortCount += 1;
  }

  async input(event: AgentInputEvent): Promise<void> {
    this.inputs.push(event);
  }

  async isBusy(): Promise<boolean> {
    return false;
  }

  async emitAssistant(text: string): Promise<void> {
    const event: AgentOutputEvent = {
      type: "assistant.message",
      agentSessionId: this.agentSessionId,
      text,
    };
    this.outputs.push(event);
    await this.#onOutput?.(event);
  }
}

describe("GatewayCore", () => {
  const running: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    while (running.length > 0) {
      await running.pop()!.stop();
    }
  });

  it("drops late output from an old agent session after command.session.new", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentSessionId = `agent-${createdAdapters.length + 1}`;
        const agentAdapter = new FakeAgentAdapter(agentSessionId);
        createdAdapters.push(agentAdapter);
        return { agentSessionId, agentAdapter };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(1);
      expect(createdAdapters[0]!.inputs).toEqual([{ type: "user.message", text: "hello" }]);
    });

    const first = createdAdapters[0]!;

    await imAdapter.emit({
      type: "command.session.new",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(createdAdapters).toHaveLength(2);
      expect(first.stopCount).toBe(1);
      expect(imAdapter.outputs.some((event) => event.text === "Started a new session.")).toBe(true);
    });

    await first.emitAssistant("late old reply");
    await sleep(30);

    expect(imAdapter.outputs.some((event) => event.text === "late old reply")).toBe(false);
  });

  it("drops output from an agent session released after idle timeout", async () => {
    const imAdapter = new FakeIMAdapter();
    const createdAdapters: FakeAgentAdapter[] = [];

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        const agentSessionId = `agent-${createdAdapters.length + 1}`;
        const agentAdapter = new FakeAgentAdapter(agentSessionId);
        agentAdapter.retainOutputCallback = true;
        createdAdapters.push(agentAdapter);
        return { agentSessionId, agentAdapter };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 20,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "user.message",
      clientSessionId: "client-1",
      text: "hello",
    });

    const first = createdAdapters[0]!;
    await waitFor(() => {
      expect(first.stopCount).toBe(1);
    });

    await first.emitAssistant("late reply after release");
    await sleep(30);

    expect(imAdapter.outputs.some((event) => event.text === "late reply after release")).toBe(false);
  });

  it("returns a message when compact is requested without an active agent session", async () => {
    const imAdapter = new FakeIMAdapter();

    const agentModule: AgentModule<Record<string, never>> = {
      type: "fake",
      async createAgentSession() {
        return {
          agentSessionId: "agent-1",
          agentAdapter: new FakeAgentAdapter("agent-1"),
        };
      },
    };

    const core = new GatewayCore({
      imAdapter,
      agentModule,
      agentConfig: {},
      agentIdleTimeoutMs: 60_000,
    });
    running.push(core);
    await core.start();

    await imAdapter.emit({
      type: "command.session.compact",
      clientSessionId: "client-1",
    });

    await waitFor(() => {
      expect(imAdapter.outputs).toContainEqual({
        type: "assistant.message",
        clientSessionId: "client-1",
        text: "No active agent session to compact.",
      });
    });
  });
});
