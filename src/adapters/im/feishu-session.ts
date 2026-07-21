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

export function parseFeishuSessionId(sessionId: string): FeishuSessionTarget {
  if (sessionId.startsWith("feishu:dm:")) {
    return { platform: "feishu", chatType: "dm", chatId: sessionId.slice("feishu:dm:".length) };
  }
  if (sessionId.startsWith("feishu:group:")) {
    return { platform: "feishu", chatType: "group", chatId: sessionId.slice("feishu:group:".length) };
  }
  throw new Error(`Unsupported sessionId: ${sessionId}`);
}
