const fs = require('node:fs/promises');
const path = require('node:path');
const { applyEvent, HISTORY_TTL } = require('./hook-state.cjs');

const MAX_FILES = 30;
const INTERESTING = /"(session_meta|task_started|task_complete|turn_aborted|function_call|function_call_output|custom_tool_call|custom_tool_call_output)"/;
const UUID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function listRecentRollouts(dir, minMtime) {
  const found = [];
  async function walk(current, depth) {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch { return; }
    // Sort newest names (YYYY/MM/DD and rollout timestamps) descending so old folders are skipped early.
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) await walk(full, depth + 1);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
        try {
          const stat = await fs.stat(full);
          if (stat.mtimeMs >= minMtime) found.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {}
      }
      if (found.length >= MAX_FILES * 2) return;
    }
  }
  await walk(dir, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
}

class CodexSessionReader {
  constructor(sessionsDir) {
    this.sessionsDir = sessionsDir;
    this.files = new Map();
  }

  async poll(store, now = Date.now()) {
    if (!this.sessionsDir) return false;
    const recent = await listRecentRollouts(this.sessionsDir, now - HISTORY_TTL);
    const activePaths = new Set(recent.map(item => item.path));
    for (const known of this.files.keys()) {
      if (!activePaths.has(known)) this.files.delete(known);
    }

    let changed = false;
    for (const file of recent) {
      let state = this.files.get(file.path);
      if (!state || file.size < state.offset) {
        const match = path.basename(file.path).match(UUID_IN_NAME);
        state = { offset: 0, partial: '', lineNo: 0, sessionId: match ? match[1] : '', workspace: '' };
        this.files.set(file.path, state);
      }
      if (file.size === state.offset) continue;

      let text = '';
      let handle;
      try {
        handle = await fs.open(file.path, 'r');
        const len = file.size - state.offset;
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await handle.read(buf, 0, len, state.offset);
        state.offset += bytesRead;
        text = buf.toString('utf8', 0, bytesRead);
      } catch {
        continue;
      } finally {
        await handle?.close().catch(() => {});
      }

      const combined = state.partial + text;
      const lines = combined.split('\n');
      state.partial = combined.endsWith('\n') ? '' : (lines.pop() ?? '');

      for (const rawLine of lines) {
        state.lineNo += 1;
        const line = rawLine.trim();
        if (!line || !INTERESTING.test(line)) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const type = obj?.type;
        const payload = obj?.payload && typeof obj.payload === 'object' ? obj.payload : null;
        if (!type || !payload) continue;

        const parsedAt = Date.parse(obj.timestamp);
        const at = Number.isFinite(parsedAt) ? parsedAt : file.mtimeMs;
        let eventName = '';
        let tool = '';
        let toolId = '';
        let terminationReason = '';

        if (type === 'session_meta') {
          if (typeof payload.id === 'string' && payload.id.trim()) state.sessionId = cleanText(payload.id, 256);
          const cwd = typeof payload.cwd === 'string' ? payload.cwd.replace(/[/\\]+$/, '') : '';
          if (cwd) state.workspace = cleanText(path.basename(cwd), 64);
          eventName = 'SessionStart';
        } else if (type === 'event_msg') {
          if (payload.type === 'task_started') eventName = 'UserPromptSubmit';
          else if (payload.type === 'task_complete') eventName = 'Stop';
          else if (payload.type === 'turn_aborted') {
            eventName = 'Stop';
            terminationReason = payload.reason === 'interrupted' ? 'USER_CANCELED' : 'ERROR';
          }
        } else if (type === 'response_item') {
          if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
            eventName = 'PreToolUse';
            tool = cleanText(payload.name, 100);
            toolId = cleanText(payload.call_id, 256);
          } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
            eventName = 'PostToolUse';
            toolId = cleanText(payload.call_id, 256);
          }
        }

        if (!eventName || !state.sessionId) continue;
        const ev = {
          v: 1,
          id: `rollout:${state.sessionId}:${state.lineNo}`,
          provider: 'codex',
          sessionId: state.sessionId,
          event: eventName,
          at,
          ...(state.workspace ? { workspace: state.workspace } : {}),
          ...(tool ? { tool } : {}),
          ...(toolId ? { toolId } : {}),
          ...(terminationReason ? { terminationReason } : {}),
        };
        if (applyEvent(store, ev, 'codex')) changed = true;
      }
    }
    return changed;
  }
}

module.exports = { CodexSessionReader };
