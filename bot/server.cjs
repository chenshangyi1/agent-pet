#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConnectorRegistry } = require('../connectors/registry.cjs');
const { Providers } = require('../runtime/providers.cjs');
const { BotService } = require('./service.cjs');

const POLL_INTERVAL_MS = 2000;

async function startBotServer(options = {}) {
  const rootDir = options.rootDir || path.dirname(__dirname);
  const dataDir = options.dataDir
    || process.env.AGENT_PET_DATA
    || process.env.DSH_COMPANION_DATA
    || path.join(os.homedir(), '.dsh', 'companion');

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const registry = new ConnectorRegistry({ rootDir, dataDir });
  const providers = new Providers(dataDir, {}, { enabledProviders: registry.enabledIds() });
  const botService = new BotService({
    rootDir,
    dataDir,
    providers,
  });

  const state = await botService.start();

  try {
    await providers.refresh();
    await botService.onSnapshot(providers.snapshot);
  } catch {}

  let polling = false;
  const pollTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      await providers.refresh();
      await botService.onSnapshot(providers.snapshot);
    } catch {}
    finally {
      polling = false;
    }
  }, options.pollIntervalMs || POLL_INTERVAL_MS);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  const enginesSummary = Object.entries(state.engines || {})
    .map(([id, info]) => `${id}:${info?.available ? 'ok' : 'no'}`)
    .join(', ');

  process.stdout.write(`[bot] Agent Pet Bot Gateway started\n`);
  process.stdout.write(`[bot] Config: ${botService.configPath}\n`);
  process.stdout.write(`[bot] Pairing Code: ${state.config.pairingCode}\n`);
  process.stdout.write(`[bot] Engines: ${enginesSummary}\n`);
  process.stdout.write(`[bot] QQ: ${state.channels.qq.enabled ? `${state.channels.qq.status} (${state.channels.qq.detail})` : 'disabled'}\n`);
  process.stdout.write(`[bot] WeCom: ${state.channels.wecom.enabled ? `${state.channels.wecom.status} (${state.channels.wecom.detail})` : 'disabled'}\n`);

  const shutdown = async signal => {
    clearInterval(pollTimer);
    process.stdout.write(`\n[bot] Received ${signal}, shutting down...\n`);
    await botService.stop().catch(() => {});
    process.exit(0);
  };

  if (options.attachSignals !== false) {
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  }

  return {
    botService,
    providers,
    registry,
    stop: async () => {
      clearInterval(pollTimer);
      await botService.stop();
    },
  };
}

if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: node bot/server.cjs\n');
    process.stdout.write('Runs the standalone Agent Pet QQ / WeCom Bot Gateway.\n');
    process.exit(0);
  }
  startBotServer().catch(err => {
    process.stderr.write(`[bot] Fatal error: ${err?.stack || err?.message || String(err)}\n`);
    process.exit(1);
  });
}

module.exports = { startBotServer };
