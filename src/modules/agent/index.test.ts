import { describe, expect, it } from "vitest";
import { getAgentModule, listAgentModules } from "./index";

describe("agent module registry", () => {
  it("registers the OpenCode module", () => {
    expect(getAgentModule("opencode")?.type).toBe("opencode");
    expect(listAgentModules().map((module) => module.type)).toContain("opencode");
  });
});
