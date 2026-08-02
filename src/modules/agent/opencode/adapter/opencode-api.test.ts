import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenCodeApi } from "./opencode-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenCode API client", () => {
  it("uses the same Basic Auth header for HTTP and SSE", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname === "/global/health") {
          return new Response(JSON.stringify({ healthy: true, version: "1.18.10" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/event") {
          const body = `data: ${JSON.stringify({
            id: "connected-1",
            type: "server.connected",
            properties: {},
          })}\n\n`;
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const api = createOpenCodeApi({
      baseUrl: "http://server.internal:4096",
      username: "opencode",
      password: "test-password-value",
      directory: "/workspace",
    });
    await api.health();
    const onEvent = vi.fn();
    await api.subscribe({ signal: new AbortController().signal, onConnected: vi.fn(), onEvent });

    const expected = `Basic ${Buffer.from("opencode:test-password-value").toString("base64")}`;
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([expected, expected]);
    expect(requests.every((request) => !request.url.includes("test-password-value"))).toBe(true);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "server.connected" }));
  });

  it("does not send Authorization when no password is configured", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        requests.push(request);
        return new Response(JSON.stringify({ healthy: true, version: "1.18.10" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await createOpenCodeApi({ baseUrl: "http://127.0.0.1:4096" }).health();

    expect(requests[0]?.headers.has("authorization")).toBe(false);
  });
});
