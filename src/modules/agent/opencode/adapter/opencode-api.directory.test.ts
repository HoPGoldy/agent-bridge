import { describe, expect, it, vi, beforeEach } from "vitest";

const { createOpencodeClient } = vi.hoisted(() => ({
  createOpencodeClient: vi.fn(),
}));

vi.mock("@opencode-ai/sdk/v2/client", () => ({ createOpencodeClient }));

import { createOpenCodeApi } from "./opencode-api";

function fakeClient() {
  const session = {
    create: vi.fn(async () => ({ data: { id: "session-1" } })),
    get: vi.fn(async () => ({ data: { id: "session-1" } })),
    status: vi.fn(async () => ({ data: {} })),
    messages: vi.fn(async () => ({ data: [] })),
    promptAsync: vi.fn(async () => ({ data: undefined })),
    abort: vi.fn(async () => ({ data: undefined })),
    summarize: vi.fn(async () => ({ data: undefined })),
  };
  return {
    global: { health: vi.fn(async () => ({ data: { healthy: true, version: "1.18.10" } })) },
    session,
    provider: { list: vi.fn(async () => ({ data: { all: [], connected: [], default: {} } })) },
    permission: {
      list: vi.fn(async () => ({ data: [] })),
      reply: vi.fn(async () => ({ data: undefined })),
    },
    question: {
      list: vi.fn(async () => ({ data: [] })),
      reject: vi.fn(async () => ({ data: undefined })),
    },
    event: {
      subscribe: vi.fn(async () => ({
        stream: (async function* () {
          return;
        })(),
      })),
    },
  };
}

describe("createOpenCodeApi", () => {
  beforeEach(() => {
    createOpencodeClient.mockReset();
    createOpencodeClient.mockImplementation(() => fakeClient() as never);
  });

  it("binds config.directory into the SDK client", () => {
    createOpenCodeApi({ baseUrl: "http://127.0.0.1:4096", directory: "/srv/project-a" });

    expect(createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/srv/project-a",
      headers: undefined,
    });
  });

  it("trims whitespace around config.directory before binding it", () => {
    createOpenCodeApi({ baseUrl: "http://127.0.0.1:4096", directory: "  /srv/project-a  " });

    expect(createOpencodeClient).toHaveBeenCalledWith(
      expect.objectContaining({ directory: "/srv/project-a" }),
    );
  });

  it("falls back to the process cwd when directory is absent", () => {
    createOpenCodeApi({ baseUrl: "http://127.0.0.1:4096" });

    expect(createOpencodeClient).toHaveBeenCalledWith(
      expect.objectContaining({ directory: process.cwd() }),
    );
  });

  it("passes the bound directory into every session endpoint call", async () => {
    const api = createOpenCodeApi({ baseUrl: "http://127.0.0.1:4096", directory: "/srv/project-a" });
    const client = createOpencodeClient.mock.results[0]!.value;

    await api.createSession({ title: "agent-bridge:test" });
    await api.getSession("session-1");
    await api.getMessages("session-1", 50);
    await api.promptAsync("session-1", { text: "hi" });
    await api.abort("session-1");
    await api.summarize("session-1", { providerID: "anthropic", modelID: "sonnet" });

    const withDirectory = { directory: "/srv/project-a" };
    expect(client.session.create).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
    expect(client.session.get).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
    expect(client.session.messages).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
    expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
    expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
    expect(client.session.summarize).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
  });

  it("passes the bound directory into provider, permission, question, and event calls", async () => {
    const api = createOpenCodeApi({ baseUrl: "http://127.0.0.1:4096", directory: "/srv/project-a" });
    const client = createOpencodeClient.mock.results[0]!.value;

    await api.getSessionStatuses();
    await api.getProviders();
    await api.listPermissions();
    await api.replyPermission("perm-1", "once");
    await api.listQuestions();
    await api.rejectQuestion("question-1");
    await api.subscribe({
      signal: new AbortController().signal,
      onConnected: async () => undefined,
      onEvent: async () => undefined,
    });

    const withDirectory = { directory: "/srv/project-a" };
    expect(client.session.status).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
    expect(client.provider.list).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
    expect(client.permission.list).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
    expect(client.permission.reply).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
    expect(client.question.list).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
    expect(client.question.reject).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
    expect(client.event.subscribe).toHaveBeenCalledWith(expect.objectContaining(withDirectory), expect.anything());
  });
});
