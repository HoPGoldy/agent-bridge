import type { Translator } from "../../../i18n";
import type { AgentSessionStatus, ClientInputEvent } from "../../../types";

function formatModel(status: AgentSessionStatus, t: Translator): string {
  if (status.provider && status.modelId) {
    return `\`${status.provider}/${status.modelId}\``;
  }
  if (status.modelId) {
    return `\`${status.modelId}\``;
  }
  if (status.provider) {
    return `\`${status.provider}\``;
  }
  return t("client.statusUnavailableValue");
}

function formatContext(status: AgentSessionStatus, t: Translator): string {
  const context = status.context;
  if (!context) {
    return t("client.statusUnavailableValue");
  }

  const { tokens, contextWindow, percent } = context;
  if (tokens == null || contextWindow == null || percent == null) {
    return t("client.statusUnavailableValue");
  }

  return `\`${tokens.toLocaleString()} / ${contextWindow.toLocaleString()} (${percent}%)\``;
}

export function renderStatusMarkdown(event: ClientInputEvent, t: Translator): string | null {
  if (event.type === "agent.status.info") {
    return [
      `**${t("client.statusTitle")}**`,
      "",
      `- ${t("client.statusSessionId")}: \`${event.status.sessionId}\``,
      `- ${t("client.statusModel")}: ${formatModel(event.status, t)}`,
      `- ${t("client.statusThinkingLevel")}: ${event.status.thinkingLevel ? `\`${event.status.thinkingLevel}\`` : t("client.statusUnavailableValue")}`,
      `- ${t("client.statusContext")}: ${formatContext(event.status, t)}`,
    ].join("\n");
  }

  if (event.type === "error" && event.kind === "agent.status.unavailable") {
    return [`**${t("client.statusUnavailable")}**`, ...(event.detail ? ["", event.detail] : [])].join("\n");
  }

  return null;
}
