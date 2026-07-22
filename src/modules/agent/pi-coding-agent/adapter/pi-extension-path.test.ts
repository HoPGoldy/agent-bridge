import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("resolveMediaPromptExtensionPath", () => {
  it("uses the source media-prompt.ts only when NODE_ENV is development", async () => {
    process.env.NODE_ENV = "development";

    const mod = await import("./pi-extension-path");
    const resolved = mod.resolveMediaPromptExtensionPath();

    expect(resolved).toContain("src/modules/agent/pi-coding-agent/adapter/media-prompt.ts");
  });

  it("requires the bundled media-prompt.js when NODE_ENV is not development", async () => {
    delete process.env.NODE_ENV;

    const mod = await import("./pi-extension-path");

    expect(() => mod.resolveMediaPromptExtensionPath()).toThrow(
      "Run npm run build before starting in production mode.",
    );
  });
});
