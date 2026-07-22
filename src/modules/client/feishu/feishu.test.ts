import { describe, expect, it } from "vitest";
import { feishuClientModule } from "./index";

describe("feishuClientModule config collector", () => {
  it("accepts a valid config", () => {
    const collector = feishuClientModule.createConfigCollector?.();
    expect(collector).toBeDefined();
    expect(() =>
      collector!.validate({
        appId: "cli_xxx",
        appSecret: "secret",
        domain: "feishu",
      }),
    ).not.toThrow();
  });

  it("rejects invalid domain", () => {
    const collector = feishuClientModule.createConfigCollector?.();
    expect(() =>
      collector!.validate({
        appId: "cli_xxx",
        appSecret: "secret",
        domain: "bad" as "feishu",
      }),
    ).toThrow("Feishu domain must be feishu or lark");
  });
});
