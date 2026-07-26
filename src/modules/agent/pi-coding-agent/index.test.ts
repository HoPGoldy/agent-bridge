import { describe, expect, it, vi } from "vitest";
import { piCodingAgentModule } from "./index";

describe("Pi coding agent config collector", () => {
  it("shows a provider-qualified model example without making it the default value", async () => {
    const input = vi.fn(async () => "");
    const collector = piCodingAgentModule.createConfigCollector?.();

    const config = await collector?.collect({
      input,
      select: vi.fn(),
      confirm: vi.fn(),
      close: vi.fn(),
    });

    expect(input).toHaveBeenCalledWith("Pi model (leave empty for pi default)", {
      placeholder: "Example: azure-openai-responses/gpt-5.6-terra",
    });
    expect(config).toEqual({});
  });
});
