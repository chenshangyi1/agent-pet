'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { applyEvent, sessionRows, HISTORY_TTL, PROVIDERS } = require('./hook-state.cjs');
const { CodexSessionReader } = require('./codex-sessions.cjs');

const rank = { waiting: 0, blocked: 1, running: 2, ready: 3, unknown: 4, idle: 5, history: 6, cancelled: 7 };
const HOOK_PROVIDERS = Object.keys(PROVIDERS);
const SOURCE_META = [
  { id: 'dsh', label: 'DSH', emptyDetail: '未连接' },
  { id: 'workbuddy', label: 'WorkBuddy', emptyDetail: '等待首个任务' },
  { id: 'antigravity', label: 'Antigravity', emptyDetail: '等待首个任务' },
  { id: 'codex', label: 'Codex', emptyDetail: '等待首个任务' },
];

function sortRows(rows) {
  return rows.sort((a, b) => (rank[a.status] ?? 6) - (rank[b.status] ?? 6) || Number(b.updatedAt) - Number(a.updatedAt));
}

class Providers {
  constructor(dataDir, legacy = {}, options = {}) {
    this.dataDir = dataDir;
    this.legacy = legacy;
    this.hookStores = Object.fromEntries(HOOK_PROVIDERS.map(id => [id, { ready: false, sessions: {} }]));
    const defaultCompanionDir = path.join(os.homedir(), '.dsh', 'companion');
    const codexSessionsDir = options.codexSessionsDir !== undefined
      ? options.codexSessionsDir
      : process.env.CODEX_HOME
        ? path.join(process.env.CODEX_HOME, 'sessions')
        : path.resolve(dataDir) === path.resolve(defaultCompanionDir)
          ? path.join(os.homedir(), '.codex', 'sessions')
          : null;
    this.codexReader = codexSessionsDir ? new CodexSessionReader(codexSessionsDir) : null;
    this.flight = null;
    this.snapshot = { items: [], sources: [] };
  }

  async dsh(body) {
    let connection;
    try { connection = JSON.parse(await fs.readFile(path.join(this.dataDir, 'dsh-bridge.json'), 'utf8')); }
    catch { connection = this.legacy; }
    if (!/^http:\/\/127\.0\.0\.1:\d+\/action$/.test(connection.endpoint ?? '') || !connection.token) throw new Error('DSH 未连接');
    const response = await fetch(connection.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(body.action === 'list' ? 2200 : ['hear', 'conversation'].includes(body.action) ? 70_000 : 25_000),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || 'DSH 暂时未连接');
    return result;
  }

  async readHookProvider(providerId) {
    const state = this.hookStores[providerId];
    if (!state) return [];
    const root = path.join(this.dataDir, providerId);
    const inbox = path.join(root, 'inbox');
    if (!state.ready) {
      try {
        const stored = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
        state.sessions = stored.sessions ?? {};
      } catch {}
      state.ready = true;
    }
    let names = [];
    try { names = (await fs.readdir(inbox)).filter(name => /^[a-f0-9]{32}\.json$/.test(name)).slice(0, 1000); } catch {}
    const events = [];
    for (const name of names) {
      try {
        const file = path.join(inbox, name);
        if ((await fs.stat(file)).size < 4096) events.push({ name, data: JSON.parse(await fs.readFile(file, 'utf8')) });
      } catch {}
    }
    events.sort((a, b) => a.data.at - b.data.at);
    for (const event of events) applyEvent(state.sessions, event.data, providerId);
    let rolloutChanged = false;
    if (providerId === 'codex' && this.codexReader) {
      rolloutChanged = await this.codexReader.poll(state.sessions);
    }
    for (const [key, row] of Object.entries(state.sessions)) {
      if (Date.now() - row.updatedAt > HISTORY_TTL) delete state.sessions[key];
    }
    if (names.length || rolloutChanged) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(root, 'state.json.tmp'), JSON.stringify({ sessions: state.sessions }), { mode: 0o600 });
      await fs.rename(path.join(root, 'state.json.tmp'), path.join(root, 'state.json'));
      // Only acknowledge after the state snapshot is durable enough to replay.
      if (names.length) await Promise.all(names.map(name => fs.unlink(path.join(inbox, name)).catch(() => {})));
    }
    return sessionRows(state.sessions, providerId);
  }

  async refresh() {
    if (this.flight) return this.flight;
    this.flight = this.load().finally(() => { this.flight = null; });
    return this.flight;
  }

  async load() {
    const [dshResult, ...hookResults] = await Promise.allSettled([
      this.dsh({ action: 'list' }),
      ...HOOK_PROVIDERS.map(id => this.readHookProvider(id)),
    ]);
    const dsh = dshResult.status === 'fulfilled' ? dshResult.value.items ?? [] : [];
    const hookRows = HOOK_PROVIDERS.flatMap((_, index) => (hookResults[index].status === 'fulfilled' ? hookResults[index].value : []));
    const items = sortRows([
      ...dsh.map(row => ({ ...row, provider: 'dsh', providerLabel: 'DSH', capabilities: { reply: true, cancel: true, open: true } })),
      ...hookRows,
    ]);
    const sources = SOURCE_META.map(meta => {
      const rows = items.filter(row => row.provider === meta.id);
      const current = rows.find(row => !['history', 'idle', 'cancelled'].includes(row.status)
        && (row.status !== 'ready' || row.unread && Date.now() - Number(row.updatedAt) < 600_000));
      const connected = meta.id === 'dsh' ? dshResult.status === 'fulfilled' : rows.length > 0;
      return {
        id: meta.id,
        label: meta.label,
        connected,
        status: current?.status ?? 'idle',
        detail: current?.statusText || (connected ? '空闲' : meta.emptyDetail),
        activityCount: rows.filter(row => ['running', 'waiting', 'blocked'].includes(row.status)).length,
      };
    });
    this.snapshot = { items, sources };
    return this.snapshot;
  }

  list(source = 'auto') {
    return { ...this.snapshot, items: this.snapshot.items.filter(row => source === 'auto' || row.provider === source) };
  }
}

module.exports = { Providers, sortRows };
