import { describe, expect, it } from "vitest";
import { toPiSessionId } from "./pi-session-id";

describe("toPiSessionId", () => {
  it("converts agent session ids to pi-safe ids", () => {
    expect(toPiSessionId("feishu:dm:oc_xxx")).toBe("feishu.dm.oc_xxx");
    expect(toPiSessionId("feishu:group:oc_yyy")).toBe("feishu.group.oc_yyy");
  });

  it("falls back to a hashed id when normalization would be invalid", () => {
    expect(toPiSessionId(":")).toMatch(/^agent-[a-f0-9]{24}$/);
  });
});
