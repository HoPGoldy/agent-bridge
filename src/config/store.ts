import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig, ChannelConfig, ChannelCommonConfig, LocaleCode } from "../types";
import { DEFAULT_LOCALE } from "../i18n";
import { DEFAULTS } from "./defaults";

const CONFIG_DIR = path.join(os.homedir(), ".config", "agent-bridge");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

type RawChannelConfig = Omit<ChannelConfig, "common"> & {
  common?: Partial<ChannelCommonConfig>;
};

type RawAppConfig = {
  channels?: Record<string, RawChannelConfig>;
  defaults?: Partial<AppConfig["defaults"]>;
};

function normalizeLanguage(language: unknown): LocaleCode {
  return language === "en-US" || language === "zh-CN" ? language : DEFAULT_LOCALE;
}

/**
 * Normalizes `defaults.allowedWorkingDirectoryRoots` from raw config input.
 *
 * - `undefined` stays `undefined` (permissive, legacy configs keep working)
 * - a non-array value is a hard config error
 * - entries must be strings; non-string entries are a hard config error
 * - entries are trimmed; empty/whitespace entries are dropped; duplicates are
 *   removed (first occurrence wins, order preserved)
 * - an empty array (or one that normalizes to empty) means permissive
 */
function normalizeAllowedWorkingDirectoryRoots(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error("defaults.allowedWorkingDirectoryRoots must be an array of non-empty strings");
  }

  const seen = new Set<string>();
  const roots: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new Error("defaults.allowedWorkingDirectoryRoots must contain only non-empty strings");
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    roots.push(trimmed);
  }
  return roots;
}

function normalizeChannelConfig(channel: RawChannelConfig): ChannelConfig {
  if (!channel.client || !channel.agent) {
    throw new Error("Invalid channel config shape");
  }
  return {
    common: {
      language: normalizeLanguage(channel.common?.language),
    },
    client: channel.client,
    agent: channel.agent,
  };
}

function mergeDefaults(config: RawAppConfig = {}): AppConfig {
  const channels = Object.fromEntries(
    Object.entries(config.channels ?? {}).map(([name, channel]) => [name, normalizeChannelConfig(channel)]),
  );

  const allowedWorkingDirectoryRoots = normalizeAllowedWorkingDirectoryRoots(
    config.defaults?.allowedWorkingDirectoryRoots,
  );

  return {
    channels,
    defaults: {
      agentIdleTimeoutMs: config.defaults?.agentIdleTimeoutMs ?? DEFAULTS.agentIdleTimeoutMs,
      ...(allowedWorkingDirectoryRoots !== undefined ? { allowedWorkingDirectoryRoots } : {}),
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
