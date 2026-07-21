import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../types";
import { DEFAULTS } from "./defaults";

const CONFIG_DIR = path.join(os.homedir(), ".config", "agent-bridge");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function mergeDefaults(config: Partial<AppConfig> = {}): AppConfig {
  return {
    channels: config.channels ?? {},
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
    return mergeDefaults(JSON.parse(raw) as Partial<AppConfig>);
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
