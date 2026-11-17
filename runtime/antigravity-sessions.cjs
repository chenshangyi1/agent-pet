'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { applyEvent, ACTIVE_TTL, HISTORY_TTL } = require('./hook-state.cjs');

const execFileAsync = promisify(execFile);
const SQLITE_BIN = '/usr/bin/sqlite3';
const MAX_SESSIONS = 30;
const BAD_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const WANTED_COLS = [
  'conversation_id',
  'title',
  'workspace_uris',
  'last_modified_time',
  'status',
  'not_fully_idle',
  'killed',
];

function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function parseTimestamp(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      return Number.isFinite(num) && num > 0 ? num : 0;
    }
    const iso = trimmed.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T');
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

function extractWorkspace(raw) {
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) list = parsed;
      } catch {}
    } else if (trimmed.startsWith('file://')) {
      list = [trimmed];
    }
  }
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed.startsWith('file://')) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'file:') continue;
      const decoded = decodeURIComponent(url.pathname).replace(/[\r\n\t]+/g, ' ').trim().replace(/[/\\]+$/, '').slice(0, 512);
      if (!decoded) continue;
      const base = cleanText(path.basename(decoded), 64);
      if (base) return { workspace: base, workspacePath: decoded };
    } catch {}
  }
  return { workspace: '', workspacePath: '' };
}

async function querySqliteJson(resolved, sql) {
  const fileUri = pathToFileURL(resolved).href;
  const attempts = [
    resolved,
    `${fileUri}?mode=ro`,
    `${fileUri}?immutable=1`,
  ];
  for (const target of attempts) {
    try {
      const { stdout } = await execFileAsync(SQLITE_BIN, ['-readonly', '-json', target, sql], {
        timeout: 1500,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      const trimmed = String(stdout || '').trim();
      if (!trimmed) return [];
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Retry with read-only / immutable URI options when WAL or locks reject bare -readonly.
    }
  }
  return null;
}

class AntigravitySessionReader {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.seen = new Map();
    this.seq = 0;
  }

  async poll(store, now = Date.now()) {
    if (typeof this.dbPath !== 'string' || !this.dbPath.trim()) return false;
    const resolved = path.resolve(this.dbPath.trim());
    try {
      const st = await fs.stat(resolved);
      if (!st.isFile()) return false;
    } catch {
      return false;
    }

    const pragmaRows = await querySqliteJson(resolved, 'PRAGMA table_info(conversation_summaries);');
    if (!Array.isArray(pragmaRows) || pragmaRows.length === 0) return false;
    const cols = new Set();
    for (const row of pragmaRows) {
      if (row && typeof row.name === 'string' && row.name) cols.add(row.name);
    }
    if (!cols.has('conversation_id')) return false;

    const selectCols = WANTED_COLS.filter(col => cols.has(col));
    const whereClause = cols.has('parent_conversation_id')
      ? "WHERE (parent_conversation_id IS NULL OR parent_conversation_id = '')"
      : '';
    const orderClause = cols.has('last_modified_time')
      ? 'ORDER BY last_modified_time DESC'
      : 'ORDER BY rowid DESC';
    const sql = `SELECT ${selectCols.join(', ')} FROM conversation_summaries ${whereClause} ${orderClause} LIMIT ${MAX_SESSIONS};`;

    const rows = await querySqliteJson(resolved, sql);
    if (!Array.isArray(rows)) return false;

    const activeIds = new Set();
    let changed = false;

    for (const row of rows) {
      const id = cleanText(row?.conversation_id, 256);
      if (!id || BAD_IDS.has(id)) continue;
      activeIds.add(id);

      const prior = Object.hasOwn(store, id) ? store[id] : undefined;
      const prev = this.seen.get(id);
      const parsedAt = cols.has('last_modified_time') ? parseTimestamp(row.last_modified_time) : 0;
      const modifiedAt = parsedAt > 0 ? parsedAt : now;

      if (parsedAt > 0 && now - parsedAt >= HISTORY_TTL && !prev?.running && !prev?.waiting && !prior) {
        this.seen.set(id, { running: false, waiting: false });
        continue;
      }

      const rawStatus = typeof row.status === 'string' ? row.status.trim().toUpperCase() : '';
      const isWaiting = /WAIT|PERMISSION/.test(rawStatus);
      const notFullyIdle = Number(row.not_fully_idle) === 1 || row.not_fully_idle === true;
      const isRunning = !isWaiting && (rawStatus === 'CASCADE_RUN_STATUS_RUNNING' || notFullyIdle);
      const killed = Number(row.killed) === 1 || row.killed === true;
      const isError = /ERROR|FAIL/.test(rawStatus);

      const { workspace, workspacePath } = cols.has('workspace_uris')
        ? extractWorkspace(row.workspace_uris)
        : { workspace: '', workspacePath: '' };
      const sessionTitle = cols.has('title') ? cleanText(row.title, 80) : '';
      const monotonicAt = () => Math.min(now, Math.max(modifiedAt, prior ? Number(prior.updatedAt || 0) + 1 : 0));

      const emit = (eventName, extra = {}, eventAt = modifiedAt) => {
        this.seq += 1;
        const ev = {
          v: 1,
          id: `agydb:${id}:${eventAt}:${this.seq}`,
          provider: 'antigravity',
          sessionId: id,
          event: eventName,
          at: eventAt,
          ...(workspace ? { workspace } : {}),
          ...(workspacePath ? { workspacePath } : {}),
          ...(sessionTitle ? { sessionTitle } : {}),
          ...extra,
        };
        if (applyEvent(store, ev, 'antigravity')) changed = true;
      };

      if (isRunning) {
        const isHookOrigin = prior && !String(prior.eventId || '').startsWith('agydb:');
        const hookRunningProtected = prior
          && prior.status === 'running'
          && (prior.updatedAt >= modifiedAt || (isHookOrigin && now - prior.updatedAt <= ACTIVE_TTL));
        // Real hooks signal ask_question waiting while Antigravity DB status stays RUNNING.
        const hookWaitingProtected = prior
          && prior.status === 'waiting'
          && !prev?.waiting
          && isHookOrigin
          && now - prior.updatedAt <= ACTIVE_TTL;
        if ((!prev?.running || prior?.status !== 'running') && !hookRunningProtected && !hookWaitingProtected) {
          const fromFinished = prior && ['ready', 'idle', 'blocked', 'cancelled'].includes(prior.status);
          emit('PreInvocation', {}, fromFinished ? monotonicAt() : modifiedAt);
        }
      } else if (isWaiting) {
        if (!prev?.waiting || prior?.status !== 'waiting') {
          emit('PermissionRequest');
        }
      } else {
        const wasActiveInDb = Boolean(prev?.running || prev?.waiting);
        const isActiveInStore = Boolean(prior && (prior.status === 'running' || prior.status === 'waiting'));
        if (wasActiveInDb || isActiveInStore) {
          const stopAt = monotonicAt();
          if (killed) {
            emit('Stop', { terminationReason: 'USER_CANCELED' }, stopAt);
          } else if (isError) {
            emit('StopFailure', {}, stopAt);
          } else {
            emit('Stop', {}, stopAt);
          }
        }
      }

      if (sessionTitle && Object.hasOwn(store, id) && !store[id].sessionTitle) {
        store[id].sessionTitle = sessionTitle;
        changed = true;
      }
      if (workspacePath && Object.hasOwn(store, id) && !store[id].workspacePath) {
        store[id].workspacePath = workspacePath;
        changed = true;
      }

      this.seen.set(id, { running: isRunning, waiting: isWaiting });
    }

    for (const known of this.seen.keys()) {
      if (!activeIds.has(known)) this.seen.delete(known);
    }

    return changed;
  }
}

module.exports = { AntigravitySessionReader };
