import type { Translator } from "../../../i18n";
import type { AgentAvailableModel, AgentSessionStatus, ClientInputEvent } from "../../../types";

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

function formatAvailableModel(model: AgentAvailableModel, t: Translator): string {
  const label = `\`${model.provider}/${model.modelId}\``;
  return model.isCurrent ? `- ${label} ✅ ${t("client.modelListCurrent")}` : `- ${label}`;
}

function formatErrorMarkdown(title: string, detail?: string): string {
  return [`**${title}**`, ...(detail ? ["", detail] : [])].join("\n");
}

export function renderStatusMarkdown(event: ClientInputEvent, t: Translator): string | null {
  if (event.type === "agent.model.list") {
    return [
      `**${t("client.modelListTitle")}**`,
      "",
      ...(event.models.length > 0 ? event.models.map((model) => formatAvailableModel(model, t)) : [`- ${t("client.statusUnavailableValue")}`]),
      "",
      t("client.modelListUsage"),
    ].join("\n");
  }

  if (event.type === "agent.model.updated") {
    return t("client.modelUpdated", { model: `${event.provider}/${event.modelId}` });
  }

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

  if (event.type === "error") {
    switch (event.kind) {
      case "agent.status.unavailable":
        return formatErrorMarkdown(t("client.statusUnavailable"), event.detail);
      case "agent.model.list.unavailable":
        return formatErrorMarkdown(t("client.modelListUnavailable"), event.detail);
      case "agent.model.set.unavailable":
        return formatErrorMarkdown(t("client.modelSetUnavailable"), event.detail);
      case "agent.model.invalid":
        return formatErrorMarkdown(t("client.modelInvalid"), event.detail);
      case "agent.model.busy":
        return event.detail ?? t("client.modelBusy");
      default:
        return null;
    }
  }

  return null;
}
