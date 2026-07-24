import { getTranslator, type Translator } from "../../../i18n";
import type { ClientInputEvent } from "../../../types";

export interface ProgressRendererOptions {
  /** Number of recent progress lines to keep before collapsing older ones. Defaults to 10. */
  collapseThreshold?: number;
  t?: Translator;
}

/** The subset of `ClientInputEvent` that represents a renderable progress update. */
export type ProgressEvent = Extract<
  ClientInputEvent,
  | { type: "session.compacting" }
  | { type: "assistant.tool.running" }
  | { type: "assistant.tool.update" }
  | { type: "assistant.tool.done" }
  | { type: "assistant.tool.error" }
>;

export interface RenderedProgress {
  markdown: string;
  status: string;
  collapsedCount: number;
  isEmpty: boolean;
}

const DEFAULT_COLLAPSE_THRESHOLD = 10;
const MAX_TOOL_LABEL_DISPLAY_LENGTH = 24;

/**
 * Accumulates agent progress events (tool running/done/error, session
 * compacting, ...) for a single conversation turn and renders them as a
 * markdown string. One instance tracks one turn's worth of progress;
 * callers should create a fresh instance when a new turn starts.
 */
type ProgressEntry =
  | {
      kind: "line";
      line: string;
    }
  | {
      kind: "tool";
      toolName: string;
      toolLabel?: string;
      status: "running" | "done" | "error";
      text?: string;
    };

export class ProgressRenderer {
  readonly #collapseThreshold: number;
  readonly #t: Translator;
  #entries = new Map<string, ProgressEntry>();
  #order: string[] = [];
  #status = "running";

  constructor(options: ProgressRendererOptions = {}) {
    this.#collapseThreshold = options.collapseThreshold ?? DEFAULT_COLLAPSE_THRESHOLD;
    this.#t = options.t ?? getTranslator("en-US");
  }

  /** Whether `event` should be recorded as progress (excludes assistant messages and thinking). */
  isProgressEvent(event: ClientInputEvent): event is ProgressEvent {
    return event.type !== "assistant.message" && event.type !== "assistant.thinking";
  }

  /** Records a progress event, formatting it into a line and collapsing older lines if needed. */
  takeProgressEvent(event: ProgressEvent): void {
    const toolEntryId = this.#toolEntryId(event);
    if (toolEntryId) {
      this.#upsertToolEntry(toolEntryId, event);
    } else {
      this.#appendLineEntry(this.#formatProgressLine(event));
    }
    this.#status = this.#progressStatus(event);
  }

  /** Returns the current rendered markdown, status, and collapsed-line count. */
  getCurrentProgress(): RenderedProgress {
    const collapsedCount = Math.max(0, this.#order.length - this.#collapseThreshold);
    return {
      markdown: this.#renderMarkdown(collapsedCount),
      status: this.#status,
      collapsedCount,
      isEmpty: this.#order.length === 0,
    };
  }

  #renderMarkdown(collapsedCount: number): string {
    const contentLines: string[] = [];
    if (collapsedCount > 0) {
      contentLines.push(`- ${this.#t("progress.collapsed", { count: collapsedCount })}`);
    }
    for (const id of this.#visibleOrder()) {
      const entry = this.#entries.get(id);
      if (!entry) continue;
      contentLines.push(entry.kind === "line" ? entry.line : this.#formatToolEntry(entry));
    }
    return contentLines.length > 0 ? contentLines.join("\n") : this.#t("progress.noProgress");
  }

  #visibleOrder(): string[] {
    return this.#order.slice(-this.#collapseThreshold);
  }

  #appendLineEntry(line: string): void {
    const id = `line:${this.#order.length}`;
    this.#entries.set(id, { kind: "line", line });
    this.#order.push(id);
  }

  #upsertToolEntry(id: string, event: ProgressEvent): void {
    if (!this.#entries.has(id)) {
      this.#order.push(id);
    }

    this.#entries.set(id, {
      kind: "tool",
      toolName: event.toolName,
      toolLabel: event.toolLabel,
      status: event.type === "assistant.tool.error" ? "error" : event.type === "assistant.tool.done" ? "done" : "running",
      text: event.text,
    });
  }

  #toolEntryId(event: ProgressEvent): string | null {
    if (
      event.type === "assistant.tool.running" ||
      event.type === "assistant.tool.update" ||
      event.type === "assistant.tool.done" ||
      event.type === "assistant.tool.error"
    ) {
      return event.toolCallId ? `tool:${event.toolCallId}` : null;
    }
    return null;
  }

  #formatToolEntry(entry: Extract<ProgressEntry, { kind: "tool" }>): string {
    const subject = this.#formatToolSubject(entry.toolName, entry.toolLabel);
    switch (entry.status) {
      case "running":
        return `- ${this.#t("progress.running", { subject })}`;
      case "done":
        return `- ${this.#t("progress.finished", { subject })}`;
      case "error":
        return this.#formatToolErrorLine(subject, entry.text);
    }
  }

  #formatProgressLine(event: ProgressEvent): string {
    switch (event.type) {
      case "session.compacting":
        return `- ${
          event.text
            ? this.#t("progress.compactingWithDetail", { detail: event.text })
            : this.#t("progress.compacting")
        }`;
      case "assistant.tool.running":
      case "assistant.tool.update":
        return `- ${this.#t("progress.running", { subject: this.#formatToolSubject(event.toolName, event.toolLabel) })}`;
      case "assistant.tool.done":
        return `- ${this.#t("progress.finished", { subject: this.#formatToolSubject(event.toolName, event.toolLabel) })}`;
      case "assistant.tool.error":
        return this.#formatToolErrorLine(this.#formatToolSubject(event.toolName, event.toolLabel), event.text);
    }
  }

  #formatToolSubject(toolName: string, toolLabel?: string): string {
    const normalizedLabel = toolLabel?.trim();
    if (!normalizedLabel) {
      return toolName;
    }
    return `${toolName}: ${this.#truncateToolLabel(normalizedLabel)}`;
  }

  #truncateToolLabel(toolLabel: string): string {
    return toolLabel.length > MAX_TOOL_LABEL_DISPLAY_LENGTH
      ? `${toolLabel.slice(0, MAX_TOOL_LABEL_DISPLAY_LENGTH)}…`
      : toolLabel;
  }

  #formatToolErrorLine(toolName: string, text?: string): string {
    const normalizedText = text?.trim();
    if (!normalizedText) {
      return `- ${this.#humanizeToolError(toolName)}`;
    }

    return `- ${this.#t("progress.failedWithDetail", { subject: toolName, detail: normalizedText })}`;
  }

  #humanizeToolError(toolName: string): string {
    return this.#t("progress.failed", { subject: toolName });
  }

  #progressStatus(event: ProgressEvent): string {
    switch (event.type) {
      case "assistant.tool.error":
        return "error";
      case "assistant.tool.done":
        return "done";
      default:
        return "running";
    }
  }
}
