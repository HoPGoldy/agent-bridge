import type { ClientInputEvent } from "../../../types";

export interface ProgressRendererOptions {
  /** Number of recent progress lines to keep before collapsing older ones. Defaults to 10. */
  collapseThreshold?: number;
}

/** The subset of `ClientInputEvent` that represents a renderable progress update. */
export type ProgressEvent = Exclude<
  ClientInputEvent,
  { type: "assistant.message" } | { type: "assistant.thinking" }
>;

export interface RenderedProgress {
  markdown: string;
  status: string;
  collapsedCount: number;
}

const DEFAULT_COLLAPSE_THRESHOLD = 10;

/** Rendered when no progress lines have been recorded yet. */
export const NO_PROGRESS_MARKDOWN = "No progress yet.";

/**
 * Accumulates agent progress events (tool running/done/error, session
 * compacting, ...) for a single conversation turn and renders them as a
 * markdown string. One instance tracks one turn's worth of progress;
 * callers should create a fresh instance when a new turn starts.
 */
export class ProgressRenderer {
  readonly #collapseThreshold: number;
  #lines: string[] = [];
  #status = "running";
  #collapsedCount = 0;

  constructor(options: ProgressRendererOptions = {}) {
    this.#collapseThreshold = options.collapseThreshold ?? DEFAULT_COLLAPSE_THRESHOLD;
  }

  /** Whether `event` should be recorded as progress (excludes assistant messages and thinking). */
  isProgressEvent(event: ClientInputEvent): event is ProgressEvent {
    return event.type !== "assistant.message" && event.type !== "assistant.thinking";
  }

  /** Records a progress event, formatting it into a line and collapsing older lines if needed. */
  takeProgressEvent(event: ProgressEvent): void {
    this.#lines.push(this.#formatProgressLine(event));
    if (this.#lines.length > this.#collapseThreshold) {
      const overflow = this.#lines.length - this.#collapseThreshold;
      this.#collapsedCount += overflow;
      this.#lines.splice(0, overflow);
    }
    this.#status = this.#progressStatus(event);
  }

  /** Returns the current rendered markdown, status, and collapsed-line count. */
  getCurrentProgress(): RenderedProgress {
    return {
      markdown: this.#renderMarkdown(),
      status: this.#status,
      collapsedCount: this.#collapsedCount,
    };
  }

  #renderMarkdown(): string {
    const contentLines: string[] = [];
    if (this.#collapsedCount > 0) {
      contentLines.push(`- Collapsed ${this.#collapsedCount} earlier updates.`);
    }
    if (this.#lines.length > 0) {
      contentLines.push(...this.#lines);
    }
    return contentLines.length > 0 ? contentLines.join("\n") : NO_PROGRESS_MARKDOWN;
  }

  #formatProgressLine(event: ProgressEvent): string {
    switch (event.type) {
      case "session.compacting":
        return `- Compacting session${event.text ? `: ${event.text}` : ""}`;
      case "assistant.tool.running":
        return `- Running ${event.toolName}`;
      case "assistant.tool.done":
        return `- Finished ${event.toolName}`;
      case "assistant.tool.error":
        return this.#formatToolErrorLine(event.toolName, event.text);
    }
  }

  #formatToolErrorLine(toolName: string, text?: string): string {
    const normalizedText = text?.trim();
    if (!normalizedText) {
      return `- ${this.#humanizeToolError(toolName)}`;
    }

    const lowerText = normalizedText.toLowerCase();
    const lowerToolName = toolName.toLowerCase();
    if (lowerText === lowerToolName || lowerText === `failed ${lowerToolName}`) {
      return `- ${this.#humanizeToolError(toolName)}`;
    }

    return `- ${this.#humanizeToolError(toolName)}: ${normalizedText}`;
  }

  #humanizeToolError(toolName: string): string {
    return `Failed ${toolName}`;
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
