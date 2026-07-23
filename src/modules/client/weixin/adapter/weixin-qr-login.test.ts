import { afterEach, describe, expect, it, vi } from "vitest";
import { loginWithWeixinQr } from "./weixin-qr-login";

const mocks = vi.hoisted(() => ({
  loginWithQrMock: vi.fn(async () => ({
    connected: true,
    bot_id: "bot-account",
    bot_token: "bot-token",
    base_url: "https://ilinkai.weixin.qq.com",
  })),
  qrGenerateMock: vi.fn(function (this: { error?: string }, _data: string, _opts?: { small?: boolean }) {
    if (this?.error == null) {
      throw new Error("missing renderer context");
    }
  }),
  constructed: [] as Array<{ token: string; config: Record<string, unknown> }>,
}));

vi.mock("qrcode-terminal", () => ({
  default: {
    error: "L",
    generate: mocks.qrGenerateMock,
  },
}));

vi.mock("@openilink/openilink-sdk-node", () => {
  class FakeClient {
    loginWithQr = mocks.loginWithQrMock;

    constructor(token = "", config: Record<string, unknown> = {}) {
      mocks.constructed.push({ token, config });
    }
  }

  return { Client: FakeClient };
});

describe("loginWithWeixinQr", () => {
  afterEach(() => {
    mocks.loginWithQrMock.mockReset();
    mocks.loginWithQrMock.mockImplementation(async () => ({
      connected: true,
      bot_id: "bot-account",
      bot_token: "bot-token",
      base_url: "https://ilinkai.weixin.qq.com",
    }));
    mocks.qrGenerateMock.mockReset();
    mocks.constructed.length = 0;
  });

  it("renders a terminal QR and returns credentials from a successful QR login", async () => {
    mocks.loginWithQrMock.mockImplementationOnce(async (callbacks) => {
      callbacks?.on_qrcode?.("https://liteapp.weixin.qq.com/q/demo");
      return {
        connected: true,
        bot_id: "bot-account",
        bot_token: "bot-token",
        base_url: "https://ilinkai.weixin.qq.com",
      };
    });

    const result = await loginWithWeixinQr({
      baseUrl: "https://ilinkai.weixin.qq.com",
      timeoutMs: 1234,
    });

    expect(result).toEqual({
      accountId: "bot-account",
      token: "bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
    });
    expect(mocks.constructed[0]).toEqual({
      token: "",
      config: { base_url: "https://ilinkai.weixin.qq.com" },
    });
    expect(mocks.loginWithQrMock).toHaveBeenCalledWith(expect.any(Object), 1234);
    expect(mocks.qrGenerateMock).toHaveBeenCalledWith("https://liteapp.weixin.qq.com/q/demo", { small: true });
  });

  it("throws when QR login does not connect", async () => {
    mocks.loginWithQrMock.mockResolvedValueOnce({
      connected: false,
      message: "login timeout",
    });

    await expect(loginWithWeixinQr()).rejects.toThrow("Weixin QR login failed: login timeout");
  });
});
