import { describe, expect, it } from "vitest";
import { getTranslator } from "./index";

describe("i18n", () => {
  it("returns localized fixed translators for supported locales", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(en("progress.noProgress")).toBe("No progress yet.");
    expect(zh("progress.noProgress")).toBe("暂无进度。");
  });

  it("does not leak locale state across fixed translators", () => {
    const zh = getTranslator("zh-CN");
    const en = getTranslator("en-US");

    expect(zh("client.processing")).toBe("正在处理中...");
    expect(en("client.processing")).toBe("Processing...");
    expect(zh("client.processing")).toBe("正在处理中...");
  });
});
