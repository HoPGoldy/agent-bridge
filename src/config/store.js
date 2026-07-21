import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from './defaults.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'agent-bridge');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function mergeDefaults(config = {}) {
  return {
    channels: config.channels ?? {},
    defaults: {
      ...DEFAULTS,
      ...(config.defaults ?? {}),
    },
  };
}

export function getConfigPath() {
  return CONFIG_PATH;
}

export async function ensureConfigDir() {
  await mkdir(CONFIG_DIR, { recursive: true });
}

export async function loadConfig() {
  await ensureConfigDir();
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return mergeDefaults(JSON.parse(raw));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return mergeDefaults();
    }
    throw error;
  }
}

export async function saveConfig(config) {
  await ensureConfigDir();
  const merged = mergeDefaults(config);
  await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}
