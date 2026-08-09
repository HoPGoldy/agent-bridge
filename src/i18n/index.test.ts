import { describe, expect, it } from "vitest";
import { getTranslator } from "./index";

describe("i18n", () => {
  it("returns localized fixed translators for supported locales", () => {
    const en = getTranslator("en-US");
    const zh = getTranslator("zh-CN");

    expect(en("progress.noProgress")).toBe("No progress yet.");
    expect(zh("progress.noProgress")).toBe("暂无进度。");
    expect(en("client.helpMessage")).toContain("/help");
    expect(en("client.helpMessage")).toContain("/model");
    expect(en("client.helpMessage")).toContain("/new [path]");
    expect(en("client.helpMessage")).toContain("/n [path]");
    expect(en("client.helpMessage")).toContain("/new /path/to/project");
    expect(zh("client.helpMessage")).toContain("查看这条帮助信息");
    expect(zh("client.helpMessage")).toContain("切换模型");
    expect(zh("client.helpMessage")).toContain("/new [path]");
    expect(zh("client.helpMessage")).toContain("/n [path]");
    expect(zh("client.helpMessage")).toContain("/new /path/to/project");
  });

  it("does not leak locale state across fixed translators", () => {
    const zh = getTranslator("zh-CN");
    const en = getTranslator("en-US");

    expect(zh("client.processing")).toBe("正在处理中...");
    expect(en("client.processing")).toBe("Processing...");
    expect(zh("client.processing")).toBe("正在处理中...");
  });
});
