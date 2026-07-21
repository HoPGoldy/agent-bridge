import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, AppConfig, ChannelConfig, ClientConfig, FeishuClientConfig } from "../types";
import { DEFAULTS } from "./defaults";

const CONFIG_DIR = path.join(os.homedir(), ".config", "agent-bridge");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

type LegacyFeishuChannelConfig = FeishuClientConfig & { type: "feishu" };

type RawChannelConfig =
  | ChannelConfig
  | LegacyFeishuChannelConfig
  | (Partial<ChannelConfig> & { type?: never });

type RawAppConfig = {
  channels?: Record<string, RawChannelConfig>;
  defaults?: Partial<AppConfig["defaults"]>;
};

function isLegacyFeishuChannelConfig(value: RawChannelConfig): value is LegacyFeishuChannelConfig {
  return typeof (value as LegacyFeishuChannelConfig).type === "string";
}

function normalizeChannelConfig(channel: RawChannelConfig): ChannelConfig {
  if (isLegacyFeishuChannelConfig(channel)) {
    const client: ClientConfig = {
      type: "feishu",
      config: {
        appId: channel.appId,
        appSecret: channel.appSecret,
        domain: channel.domain,
        encryptKey: channel.encryptKey,
        verificationToken: channel.verificationToken,
      },
    };

    const agent: AgentConfig = {
      type: "pi-rpc",
      config: {},
    };

    return { client, agent };
  }

  if (channel.client && channel.agent) {
    return channel as ChannelConfig;
  }

  if (channel.client && !channel.agent) {
    return {
      client: channel.client as ClientConfig,
      agent: {
        type: "pi-rpc",
        config: {},
      },
    };
  }

  throw new Error("Invalid channel config shape");
}

function mergeDefaults(config: RawAppConfig = {}): AppConfig {
  const channels = Object.fromEntries(
    Object.entries(config.channels ?? {}).map(([name, channel]) => [name, normalizeChannelConfig(channel)]),
  );

  return {
    channels,
    defaults: {
      ...DEFAULTS,
      ...(config.defaults ?? {}),
    },
  };
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

export async function loadConfig(): Promise<AppConfig> {
  await ensureConfigDir();
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return mergeDefaults(JSON.parse(raw) as RawAppConfig);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return mergeDefaults();
    }
    throw error;
  }
}

export async function saveConfig(config: Partial<AppConfig>): Promise<void> {
  await ensureConfigDir();
  const merged = mergeDefaults(config);
  await writeFile(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}
