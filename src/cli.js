#!/usr/bin/env node
import process from 'node:process';
import { getConfigAdapter, listConfigAdapters } from './config/adapters/index.js';
import { createPromptContext } from './config/prompt.js';
import { loadConfig, saveConfig, getConfigPath } from './config/store.js';
import { runChannel } from './core/channel-runner.js';

function printUsage() {
  console.log(`agent-bridge\n\nCommands:\n  add\n  ls\n  remove <channel-name>\n  start <channel-name>`);
}

async function cmdAdd() {
  const config = await loadConfig();
  const ctx = createPromptContext();
  try {
    const type = await ctx.select('Select IM adapter', listConfigAdapters().map((adapter) => ({
      label: adapter.type,
      value: adapter.type,
    })));

    const name = await ctx.input('Channel name', {
      required: true,
      validate: (value) => {
        if (!value) return 'Channel name is required';
        if (config.channels[value]) return 'Channel name already exists';
        return null;
      },
    });

    const adapter = getConfigAdapter(type);
    if (!adapter) {
      throw new Error(`No config adapter for type: ${type}`);
    }

    const channelConfig = await adapter.collect(ctx);
    await adapter.validate(channelConfig);

    config.channels[name] = channelConfig;
    await saveConfig(config);
    console.log(`Saved channel ${name} to ${getConfigPath()}`);
  } finally {
    ctx.close();
  }
}

async function cmdList() {
  const config = await loadConfig();
  const names = Object.keys(config.channels).sort();
  if (names.length === 0) {
    console.log('No channels configured.');
    return;
  }

  for (const name of names) {
    const channel = config.channels[name];
    const adapter = getConfigAdapter(channel.type);
    const summary = adapter?.summarize?.(channel) ?? `type=${channel.type}`;
    console.log(`${name}\t${summary}`);
  }
}

async function cmdRemove(channelName) {
  if (!channelName) {
    throw new Error('channel-name is required');
  }
  const config = await loadConfig();
  if (!config.channels[channelName]) {
    throw new Error(`Unknown channel: ${channelName}`);
  }
  delete config.channels[channelName];
  await saveConfig(config);
  console.log(`Removed channel ${channelName}`);
}

async function cmdStart(channelName) {
  if (!channelName) {
    throw new Error('channel-name is required');
  }
  const config = await loadConfig();
  const channelConfig = config.channels[channelName];
  if (!channelConfig) {
    throw new Error(`Unknown channel: ${channelName}`);
  }

  const runner = await runChannel({
    channelName,
    channelConfig,
    defaults: config.defaults,
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runner.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void stop();
  });
  process.on('SIGTERM', () => {
    void stop();
  });

  await new Promise(() => {});
}

async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'add':
      await cmdAdd();
      break;
    case 'ls':
      await cmdList();
      break;
    case 'remove':
      await cmdRemove(args[0]);
      break;
    case 'start':
      await cmdStart(args[0]);
      break;
    case '-h':
    case '--help':
    case undefined:
      printUsage();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
