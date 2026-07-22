import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMediaMarkers } from "./media-marker";
import { MEDIA_CONVENTION_PROMPT } from "./adapter/media-prompt";

const rawDir = mkdtempSync(join(tmpdir(), "media-marker-test-"));
const dir = realpathSync(rawDir);
const realImagePath = join(dir, "chart.png");
writeFileSync(realImagePath, "fake-png-bytes");
const realFilePath = join(dir, "report.pdf");
writeFileSync(realFilePath, "fake-pdf-bytes");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("extractMediaMarkers", () => {
  it("extracts a marker that appears mid-sentence, not just at line start", () => {
    const { text, attachments } = extractMediaMarkers(
      `Here is the chart you asked for MEDIA:${realImagePath} let me know if you want changes.`,
    );

    expect(attachments).toEqual([{ kind: "image", filePath: realImagePath }]);
    expect(text).not.toContain("MEDIA:");
    expect(text).toContain("Here is the chart you asked for");
    expect(text).toContain("let me know if you want changes.");
  });

  it("extracts a file marker as kind file based on extension", () => {
    const { attachments } = extractMediaMarkers(`Report attached. MEDIA:${realFilePath}`);
    expect(attachments).toEqual([{ kind: "file", filePath: realFilePath }]);
  });

  it("does not extract a marker inside a fenced code block", () => {
    const raw = [
      "You can reference media like this:",
      "```",
      `MEDIA:${realImagePath}`,
      "```",
      "That's just documentation.",
    ].join("\n");

    const { text, attachments } = extractMediaMarkers(raw);
    expect(attachments).toEqual([]);
    expect(text).toContain(`MEDIA:${realImagePath}`);
  });

  it("does not extract a marker inside inline code", () => {
    const raw = `Use \`MEDIA:${realImagePath}\` in your reply to send an image.`;
    const { attachments } = extractMediaMarkers(raw);
    expect(attachments).toEqual([]);
  });

  it("leaves a marker untouched when the path does not exist on disk", () => {
    const fakePath = join(dir, "does-not-exist.png");
    const raw = `Here you go MEDIA:${fakePath}`;

    const { text, attachments } = extractMediaMarkers(raw);
    expect(attachments).toEqual([]);
    expect(text).toBe(raw);
  });

  it("never strips a marker from the visible text without also delivering it (no black-hole case)", () => {
    const fakePath = join(dir, "also-missing.pdf");
    const raw = `MEDIA:${fakePath}`;

    const { text, attachments } = extractMediaMarkers(raw);
    expect(attachments).toEqual([]);
    expect(text).toContain("MEDIA:");
  });

  it("returns no attachments and unchanged (trimmed) text when there is no marker at all", () => {
    const { text, attachments } = extractMediaMarkers("Just a normal reply with no attachments.");
    expect(attachments).toEqual([]);
    expect(text).toBe("Just a normal reply with no attachments.");
  });
});

// Coherence test between media-marker.ts (the regex/validation) and
// media-prompt.ts (the prose describing the convention to the model).
// These two files have no code-level dependency on each other, so nothing
// stops them from drifting apart if edited independently — this test is
// the actual guard against that, not file co-location.
describe("MEDIA_CONVENTION_PROMPT stays consistent with extractMediaMarkers", () => {
  it("documents the exact marker keyword that extractMediaMarkers recognizes", () => {
    expect(MEDIA_CONVENTION_PROMPT).toContain("MEDIA:");
  });

  it("a marker written exactly as the prompt describes is actually extracted", () => {
    const raw = `Sure, here you go MEDIA:${realImagePath}`;
    const { attachments } = extractMediaMarkers(raw);
    expect(attachments).toEqual([{ kind: "image", filePath: realImagePath }]);
  });
});
