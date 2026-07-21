import { describe, expect, it } from "vitest";
import { feishuConfigAdapter } from "./feishu";

describe("feishuConfigAdapter.validate", () => {
  it("accepts a valid config", () => {
    expect(() =>
      feishuConfigAdapter.validate({
        type: "feishu",
        appId: "cli_xxx",
        appSecret: "secret",
        domain: "feishu",
      }),
    ).not.toThrow();
  });

  it("rejects invalid domain", () => {
    expect(() =>
      feishuConfigAdapter.validate({
        type: "feishu",
        appId: "cli_xxx",
        appSecret: "secret",
        domain: "bad" as "feishu",
      }),
    ).toThrow("Feishu domain must be feishu or lark");
  });
});
