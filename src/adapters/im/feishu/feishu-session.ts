export type FeishuSessionTarget = {
  platform: "feishu";
  chatType: "dm" | "group";
  chatId: string;
};

export function buildFeishuSessionId(chatType: "p2p" | "dm" | "group", chatId: string): string {
  if (!chatId) {
    throw new Error("chatId is required");
  }
  if (chatType === "p2p" || chatType === "dm") {
    return `feishu:dm:${chatId}`;
  }
  if (chatType === "group") {
    return `feishu:group:${chatId}`;
  }
  throw new Error(`Unsupported Feishu chat type: ${chatType}`);
}

export function parseFeishuSessionId(clientSessionId: string): FeishuSessionTarget {
  if (clientSessionId.startsWith("feishu:dm:")) {
    return { platform: "feishu", chatType: "dm", chatId: clientSessionId.slice("feishu:dm:".length) };
  }
  if (clientSessionId.startsWith("feishu:group:")) {
    return { platform: "feishu", chatType: "group", chatId: clientSessionId.slice("feishu:group:".length) };
  }
  throw new Error(`Unsupported clientSessionId: ${clientSessionId}`);
}
