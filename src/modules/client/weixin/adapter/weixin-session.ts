export type WeixinSessionTarget = {
  platform: "weixin";
  chatType: "dm" | "group";
  chatId: string;
};

export function buildWeixinSessionId(chatType: "dm" | "group", chatId: string): string {
  if (chatType === "dm") {
    return `weixin:dm:${chatId}`;
  }
  if (chatType === "group") {
    return `weixin:group:${chatId}`;
  }
  throw new Error(`Unsupported Weixin chat type: ${chatType satisfies never}`);
}

export function parseWeixinSessionId(clientSessionId: string): WeixinSessionTarget {
  if (clientSessionId.startsWith("weixin:dm:")) {
    return { platform: "weixin", chatType: "dm", chatId: clientSessionId.slice("weixin:dm:".length) };
  }
  if (clientSessionId.startsWith("weixin:group:")) {
    return { platform: "weixin", chatType: "group", chatId: clientSessionId.slice("weixin:group:".length) };
  }
  throw new Error(`Unsupported clientSessionId: ${clientSessionId}`);
}
