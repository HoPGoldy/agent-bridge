import { Client as OpenILinkClient } from "@openilink/openilink-sdk-node";

type QrRenderer = (data: string) => void;

export async function loginWithWeixinQr(options: {
  baseUrl?: string;
  timeoutMs?: number;
} = {}): Promise<{ accountId: string; token: string; baseUrl: string }> {
  const { baseUrl = "https://ilinkai.weixin.qq.com", timeoutMs } = options;

  const renderQr = await loadQrRenderer();

  const client = new OpenILinkClient("", {
    base_url: baseUrl,
  }) as {
    loginWithQr(
      callbacks?: {
        on_qrcode?: (url: string) => void;
        on_scanned?: () => void;
        on_expired?: (attempt: number, maxAttempts: number) => void;
      },
      timeoutMs?: number,
    ): Promise<{
      connected: boolean;
      message: string;
      bot_id?: string;
      bot_token?: string;
      base_url?: string;
    }>;
  };

  let lastQrUrl = "";
  const result = await client.loginWithQr(
    {
      on_qrcode(url) {
        lastQrUrl = url;
        console.log("\n请使用微信扫描以下二维码：");
        try {
          renderQr(url);
        } catch (error) {
          console.log(`（终端二维码渲染失败: ${String(error)}）`);
          console.log(url);
        }
      },
      on_scanned() {
        console.log("\n已扫码，请在微信里确认...");
      },
      on_expired(attempt, maxAttempts) {
        console.log(`\n二维码已过期，正在刷新... (${attempt}/${maxAttempts})`);
      },
    },
    timeoutMs,
  );

  if (!result.connected || !result.bot_id || !result.bot_token) {
    throw new Error(`Weixin QR login failed: ${result.message || "unknown error"}`);
  }

  const resolvedBaseUrl = result.base_url || baseUrl;
  console.log(`\n微信连接成功，accountId=${result.bot_id}`);
  if (!lastQrUrl) {
    console.log("提示：如需重新登录，可再次触发二维码登录流程。");
  }

  return {
    accountId: result.bot_id,
    token: result.bot_token,
    baseUrl: resolvedBaseUrl,
  };
}

async function loadQrRenderer(): Promise<QrRenderer> {
  const mod = await import("qrcode-terminal");
  const api = (mod.default ?? mod) as { generate?: (data: string, opts?: { small?: boolean }) => void };
  if (typeof api.generate !== "function") {
    throw new Error("qrcode-terminal generate() is unavailable");
  }
  return (data: string) => {
    api.generate?.(data, { small: true });
    console.log("\n二维码链接：");
    console.log(data);
  };
}
