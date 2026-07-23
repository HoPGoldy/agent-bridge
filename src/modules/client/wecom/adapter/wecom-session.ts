export type WecomSessionTarget = {
  platform: "wecom";
  chatType: "dm" | "group";
  chatId: string;
};

export function buildWecomSessionId(chatType: "dm" | "group", chatId: string): string {
  if (chatType === "dm") {
    return `wecom:dm:${chatId}`;
  }
  if (chatType === "group") {
    return `wecom:group:${chatId}`;
  }
  throw new Error(`Unsupported WeCom chat type: ${chatType satisfies never}`);
}

export function parseWecomSessionId(clientSessionId: string): WecomSessionTarget {
  if (clientSessionId.startsWith("wecom:dm:")) {
    return { platform: "wecom", chatType: "dm", chatId: clientSessionId.slice("wecom:dm:".length) };
  }
  if (clientSessionId.startsWith("wecom:group:")) {
    return { platform: "wecom", chatType: "group", chatId: clientSessionId.slice("wecom:group:".length) };
  }
  throw new Error(`Unsupported clientSessionId: ${clientSessionId}`);
}
