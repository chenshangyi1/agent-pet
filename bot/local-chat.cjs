'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CATALOG_BY_ID } = require('../connectors/catalog.cjs');

const MAX_LIST_FILES = 20;
const MAX_SCAN_ENTRIES = 4000;
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.cache']);

const MIME_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
};

const PROVIDER_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  dsh: 'DSH',
};

const DIRECT_ENGINES = new Set(['claude', 'codex', 'opencode']);
const VALID_ENGINES = new Set(['claude', 'codex', 'opencode', 'dsh']);
const MAX_DISCOVER_FILES = 15;
const MAX_DISCOVER_WORKSPACES = 12;
const MAX_DISCOVER_SESSIONS = 10;
const JSONL_HEAD_BYTES = 65536;

function safeRealpath(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return null;
  try {
    return fs.realpathSync(path.resolve(targetPath.trim()));
  } catch {
    return null;
  }
}

function isExistingDirectory(dirPath) {
  if (!dirPath) return false;
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readHeadLines(filePath, maxBytes = JSONL_HEAD_BYTES) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    if (bytesRead <= 0) return [];
    return buf.subarray(0, bytesRead).toString('utf8').split('\n');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function collectRecentJsonlFiles(rootDir, maxDepth = 4, limit = MAX_DISCOVER_FILES) {
  if (!isExistingDirectory(rootDir)) return [];
  const found = [];
  const stack = [{ dir: rootDir, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          stack.push({ dir: fullPath, depth: depth + 1 });
        }
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(fullPath);
          found.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
        } catch {}
      }
    }
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, limit);
}

function collectSubdirectories(rootDir, maxDepth = 2) {
  if (!isExistingDirectory(rootDir)) return [];
  const dirs = [];
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      dirs.push(fullPath);
      if (depth + 1 < maxDepth) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }
  return dirs;
}

function isBoilerplateUserText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  return (
    trimmed.startsWith('# AGENTS.md')
    || trimmed.startsWith('<INSTRUCTIONS>')
    || trimmed.startsWith('<environment_context>')
    || trimmed.startsWith('<user_instructions>')
    || trimmed.startsWith('<permissions instructions>')
    || trimmed.startsWith('<app-context>')
    || trimmed.startsWith('<turn_aborted>')
    || trimmed.startsWith('<local-command-caveat>')
  );
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === 'string' && block.trim()) {
        parts.push(block.trim());
      } else if (block && typeof block === 'object' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim());
      }
    }
    return parts.join(' ').trim();
  }
  return '';
}

function parseCodexSessionMeta(filePath, mtimeMs) {
  const lines = readHeadLines(filePath, JSONL_HEAD_BYTES);
  let id = null;
  let cwd = null;
  let snippet = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'session_meta' && obj.payload && typeof obj.payload === 'object') {
      if (!id) id = obj.payload.id || obj.payload.session_id || null;
      if (!cwd && typeof obj.payload.cwd === 'string' && obj.payload.cwd.trim()) {
        cwd = obj.payload.cwd.trim();
      }
    } else if (!snippet && obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
      const candidate = extractTextFromContent(obj.payload.message);
      if (!isBoilerplateUserText(candidate)) {
        snippet = candidate.replace(/\s+/g, ' ').slice(0, 36);
      }
    } else if (!snippet && obj.type === 'response_item' && obj.payload?.type === 'message' && obj.payload?.role === 'user') {
      const candidate = extractTextFromContent(obj.payload.content);
      if (!isBoilerplateUserText(candidate)) {
        snippet = candidate.replace(/\s+/g, ' ').slice(0, 36);
      }
    }
    if (id && cwd && snippet) break;
  }

  if (!id) return null;
  const fallbackName = cwd ? path.basename(cwd) : 'Codex';
  return {
    sessionId: id,
    cliSessionId: id,
    provider: 'codex',
    cwd: cwd || '',
    title: snippet || `${fallbackName || 'Codex'} · ${id.slice(0, 8)}`,
    updatedAt: mtimeMs,
    filePath,
  };
}

function parseClaudeSessionMeta(filePath, mtimeMs) {
  const sessionId = path.basename(filePath, '.jsonl');
  if (!sessionId) return null;
  const lines = readHeadLines(filePath, JSONL_HEAD_BYTES);
  let cwd = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const candidateCwd = obj.cwd || obj.attachment?.snapshot?.workingDirectory;
    if (typeof candidateCwd === 'string' && candidateCwd.trim()) {
      cwd = candidateCwd.trim();
      break;
    }
  }

  const base = cwd ? path.basename(cwd) : 'Claude';
  return {
    sessionId,
    cliSessionId: sessionId,
    provider: 'claude',
    cwd,
    title: `${base || 'Claude'} · ${sessionId.slice(0, 8)}`,
    updatedAt: mtimeMs,
    filePath,
  };
}

function getProviderLabel(id) {
  return PROVIDER_LABELS[id] || CATALOG_BY_ID[id]?.label || id;
}

function stripInlineAgentPrefix(rawText) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return { text: '', inlineEngine: null };
  const match = text.match(/^@(claude|codex|opencode|dsh)(?:\s+([\s\S]*))?$/i);
  if (!match) return { text, inlineEngine: null };
  return {
    text: String(match[2] || '').trim(),
    inlineEngine: match[1].toLowerCase(),
  };
}

function parseDataUrlImage(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, '');
  const ext = MIME_TO_EXT[mime] || '.png';
  return { buffer: Buffer.from(base64, 'base64'), ext };
}

function writeTempImageBuffer(buffer, ext = '.png') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_INLINE_IMAGE_BYTES) {
    return null;
  }
  const filePath = path.join(os.tmpdir(), `agent-pet-img-${randomUUID()}${ext}`);
  fs.writeFileSync(filePath, buffer, { mode: 0o600 });
  return filePath;
}

function listWorkspaceFiles(rootDir, query = '', limit = MAX_LIST_FILES) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(path.resolve(rootDir || os.homedir()));
    if (!fs.statSync(realRoot).isDirectory()) return [];
  } catch {
    return [];
  }

  const needle = String(query || '').trim().toLowerCase();
  const matches = [];
  const queue = [''];
  let visited = 0;

  while (queue.length > 0 && matches.length < limit && visited < MAX_SCAN_ENTRIES) {
    const relDir = queue.shift();
    const absDir = relDir ? path.join(realRoot, relDir) : realRoot;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (visited >= MAX_SCAN_ENTRIES || matches.length >= limit) break;
      visited++;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') {
        if (SKIP_DIRS.has(entry.name) || entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const nextRel = relDir ? path.join(relDir, entry.name) : entry.name;
        queue.push(nextRel);
      } else if (entry.isFile()) {
        const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
        if (!needle || relPath.toLowerCase().includes(needle)) {
          matches.push({ path: relPath, name: entry.name });
        }
      }
    }
  }

  return matches;
}

class LocalChatBridge {
  constructor({ dispatcher, getConfig, onUpdate, codexSessionsDir, claudeProjectsDir } = {}) {
    this.dispatcher = dispatcher || null;
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.onUpdate = typeof onUpdate === 'function' ? onUpdate : null;
    this.sessions = new Map();
    this.sessionAliases = new Map();
    this.selectedEngine = null;
    this.selectedCwd = null;
    this.selectedSessionId = null;
    this._codexSessionsDir = codexSessionsDir || path.join(os.homedir(), '.codex', 'sessions');
    this._claudeProjectsDir = claudeProjectsDir || path.join(os.homedir(), '.claude', 'projects');
  }

  _defaultCwd() {
    const cfg = this.getConfig() || {};
    return (typeof cfg.defaultCwd === 'string' && cfg.defaultCwd.trim())
      || this.dispatcher?.defaultCwd
      || os.homedir();
  }

  currentCwd() {
    return this.selectedCwd || this._defaultCwd();
  }

  _validateOrResolveCwd(targetDir, { allowUserSelection = false } = {}) {
    const raw = typeof targetDir === 'string' ? targetDir.trim() : '';
    if (!raw) throw new Error('工作目录不能为空');
    const expanded = raw === '~'
      ? os.homedir()
      : raw.startsWith('~/')
        ? path.join(os.homedir(), raw.slice(2))
        : raw;
    const real = safeRealpath(expanded);
    if (!real || !isExistingDirectory(real)) {
      throw new Error(`工作目录不存在或不可访问: ${targetDir}`);
    }
    if (this.dispatcher && typeof this.dispatcher.validateWorkspace === 'function') {
      if (allowUserSelection) {
        const list = Array.isArray(this.dispatcher.allowedWorkspaces)
          ? this.dispatcher.allowedWorkspaces
          : [];
        const covered = list.some(root => {
          const realRoot = safeRealpath(root);
          return realRoot && (real === realRoot || real.startsWith(realRoot === path.sep ? realRoot : realRoot + path.sep));
        });
        if (!covered) {
          this.dispatcher.allowedWorkspaces = [...list, real];
        }
      }
      return this.dispatcher.validateWorkspace(real);
    }
    return real;
  }

  discoverWorkspaces() {
    const candidates = [];
    const pushCandidate = dir => {
      if (typeof dir === 'string' && dir.trim()) {
        candidates.push(dir.trim());
      }
    };

    pushCandidate(this.currentCwd());
    pushCandidate(this._defaultCwd());
    for (const s of this.sessions.values()) {
      pushCandidate(s.cwd);
    }

    const recentCodexFiles = collectRecentJsonlFiles(this._codexSessionsDir, 4, MAX_DISCOVER_FILES);
    for (const { filePath, mtimeMs } of recentCodexFiles) {
      const meta = parseCodexSessionMeta(filePath, mtimeMs);
      if (meta?.cwd) pushCandidate(meta.cwd);
    }

    const home = os.homedir();
    for (const dir of collectSubdirectories(path.join(home, 'AI', 'Codex'), 2)) {
      pushCandidate(dir);
    }
    for (const dir of collectSubdirectories(path.join(home, 'AI'), 2)) {
      pushCandidate(dir);
    }

    pushCandidate(process.cwd());

    const activeReal = safeRealpath(this.currentCwd()) || this.currentCwd();
    const seen = new Set();
    const out = [];

    for (const cand of candidates) {
      if (out.length >= MAX_DISCOVER_WORKSPACES) break;
      const real = safeRealpath(cand);
      if (!real || seen.has(real) || !isExistingDirectory(real)) continue;
      if (this.dispatcher && typeof this.dispatcher.validateWorkspace === 'function') {
        try {
          this.dispatcher.validateWorkspace(real);
        } catch {
          continue;
        }
      }
      seen.add(real);
      out.push({
        path: real,
        name: path.basename(real) || real,
        active: real === activeReal,
      });
    }

    return out;
  }

  discoverSessions({ engine, cwd } = {}) {
    const reqEng = String(engine || '').trim().toLowerCase();
    const eng = VALID_ENGINES.has(reqEng) ? reqEng : this.resolveEngine('auto');
    const filterCwd = cwd || this.currentCwd();
    const normFilterCwd = safeRealpath(filterCwd) || filterCwd;

    const selectedObj = this.selectedSessionId ? this._resolveSession(this.selectedSessionId) : null;
    const selectedCliId = selectedObj?.cliSessionId || null;

    const items = [];
    const seenCliIds = new Set();

    for (const s of this.sessions.values()) {
      if (s.provider !== eng) continue;
      if (s.cliSessionId) seenCliIds.add(s.cliSessionId);
      const normSessionCwd = safeRealpath(s.cwd) || s.cwd || '';
      items.push({
        sessionId: s.sessionId,
        cliSessionId: s.cliSessionId || null,
        provider: eng,
        cwd: s.cwd || this.currentCwd(),
        title: s.title || '本地对话',
        updatedAt: Number(s.updatedAt || 0),
        matchesCwd: Boolean(normFilterCwd && normSessionCwd === normFilterCwd),
        active: s.sessionId === this.selectedSessionId,
      });
    }

    if (eng === 'codex') {
      const files = collectRecentJsonlFiles(this._codexSessionsDir, 4, MAX_DISCOVER_FILES);
      for (const { filePath, mtimeMs } of files) {
        const meta = parseCodexSessionMeta(filePath, mtimeMs);
        if (!meta || seenCliIds.has(meta.cliSessionId)) continue;
        seenCliIds.add(meta.cliSessionId);
        const normCwd = safeRealpath(meta.cwd) || meta.cwd || '';
        items.push({
          sessionId: meta.sessionId,
          cliSessionId: meta.cliSessionId,
          provider: 'codex',
          cwd: meta.cwd || this.currentCwd(),
          title: meta.title,
          updatedAt: meta.updatedAt,
          matchesCwd: Boolean(normFilterCwd && normCwd === normFilterCwd),
          active: meta.sessionId === this.selectedSessionId || (Boolean(selectedCliId) && meta.cliSessionId === selectedCliId),
        });
      }
    } else if (eng === 'claude') {
      const files = collectRecentJsonlFiles(this._claudeProjectsDir, 2, MAX_DISCOVER_FILES);
      for (const { filePath, mtimeMs } of files) {
        const meta = parseClaudeSessionMeta(filePath, mtimeMs);
        if (!meta || seenCliIds.has(meta.cliSessionId)) continue;
        seenCliIds.add(meta.cliSessionId);
        const normCwd = safeRealpath(meta.cwd) || meta.cwd || '';
        items.push({
          sessionId: meta.sessionId,
          cliSessionId: meta.cliSessionId,
          provider: 'claude',
          cwd: meta.cwd || this.currentCwd(),
          title: meta.title,
          updatedAt: meta.updatedAt,
          matchesCwd: Boolean(normFilterCwd && normCwd === normFilterCwd),
          active: meta.sessionId === this.selectedSessionId || (Boolean(selectedCliId) && meta.cliSessionId === selectedCliId),
        });
      }
    }

    items.sort((a, b) => {
      if (a.matchesCwd !== b.matchesCwd) return a.matchesCwd ? -1 : 1;
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    });

    return items.slice(0, MAX_DISCOVER_SESSIONS);
  }

  resolveEngine(preferredSource = 'auto') {
    const preferred = String(preferredSource || '').trim().toLowerCase();
    if (DIRECT_ENGINES.has(preferred)) {
      return preferred;
    }
    if (VALID_ENGINES.has(this.selectedEngine)) {
      return this.selectedEngine;
    }
    const cfgEngine = String(this.getConfig()?.defaultEngine || '').trim().toLowerCase();
    if (VALID_ENGINES.has(cfgEngine)) {
      return cfgEngine;
    }
    const probes = this.dispatcher?.probeEngines ? this.dispatcher.probeEngines() : {};
    if (probes.claude?.available) return 'claude';
    if (probes.codex?.available) return 'codex';
    if (probes.opencode?.available) return 'opencode';
    return 'claude';
  }

  isLocalSessionId(sessionId) {
    return typeof sessionId === 'string' && sessionId.startsWith('local:');
  }

  _resolveSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    if (this.sessions.has(sessionId)) return this.sessions.get(sessionId);
    const aliased = this.sessionAliases.get(sessionId);
    if (aliased && this.sessions.has(aliased)) return this.sessions.get(aliased);
    return null;
  }

  _createSession(engine, explicitSessionId = null) {
    const canonicalId = this.isLocalSessionId(explicitSessionId)
      ? explicitSessionId
      : `local:${engine}:${randomUUID()}`;
    if (explicitSessionId && explicitSessionId !== canonicalId) {
      this.sessionAliases.set(explicitSessionId, canonicalId);
    }
    const session = {
      sessionId: canonicalId,
      provider: engine,
      providerLabel: getProviderLabel(engine),
      cliSessionId: null,
      title: '本地对话',
      cwd: this.currentCwd(),
      model: engine,
      status: 'idle',
      statusText: '空闲',
      detail: '等待输入',
      unread: false,
      updatedAt: Date.now(),
      lastSeq: 0,
      activeJobId: null,
      messages: [],
    };
    this.sessions.set(canonicalId, session);
    return session;
  }

  _hydrateHistoricalMessages(session, limit = 20) {
    if (!session || !session.cliSessionId || session.messages.length > 0) return;
    let filePath = null;
    if (session.provider === 'codex') {
      const files = collectRecentJsonlFiles(this._codexSessionsDir, 4, 30);
      for (const f of files) {
        const meta = parseCodexSessionMeta(f.filePath, f.mtimeMs);
        if (meta?.cliSessionId === session.cliSessionId) {
          filePath = f.filePath;
          break;
        }
      }
    } else if (session.provider === 'claude') {
      const files = collectRecentJsonlFiles(this._claudeProjectsDir, 2, 30);
      for (const f of files) {
        if (path.basename(f.filePath, '.jsonl') === session.cliSessionId) {
          filePath = f.filePath;
          break;
        }
      }
    }
    if (!filePath) return;

    try {
      const stat = fs.statSync(filePath);
      const readSize = Math.min(stat.size, 262144);
      const offset = Math.max(0, stat.size - readSize);
      const fd = fs.openSync(filePath, 'r');
      let raw = '';
      try {
        const buf = Buffer.allocUnsafe(readSize);
        const bytesRead = fs.readSync(fd, buf, 0, readSize, offset);
        raw = buf.subarray(0, bytesRead).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      const lines = raw.split('\n');
      if (offset > 0) lines.shift();
      const parsedMsgs = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        let obj;
        try { obj = JSON.parse(trimmed); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;

        if (session.provider === 'codex') {
          if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
            const text = extractTextFromContent(obj.payload.message);
            if (!isBoilerplateUserText(text)) {
              parsedMsgs.push({ role: 'user', text, ts: Date.parse(obj.timestamp) || Date.now() });
            }
          } else if (obj.type === 'event_msg' && obj.payload?.type === 'agent_message') {
            const text = extractTextFromContent(obj.payload.message);
            if (text) parsedMsgs.push({ role: 'assistant', text, ts: Date.parse(obj.timestamp) || Date.now() });
          } else if (obj.type === 'response_item' && obj.payload?.type === 'message') {
            const role = obj.payload.role;
            if (role === 'user' || role === 'assistant') {
              const text = extractTextFromContent(obj.payload.content);
              if (text && (role !== 'user' || !isBoilerplateUserText(text))) {
                const prev = parsedMsgs[parsedMsgs.length - 1];
                if (!prev || prev.role !== role || prev.text !== text) {
                  parsedMsgs.push({ role, text, ts: Date.parse(obj.timestamp) || Date.now() });
                }
              }
            }
          }
        } else if (session.provider === 'claude') {
          if (obj.type === 'user' && obj.message) {
            const text = extractTextFromContent(obj.message.content);
            if (!isBoilerplateUserText(text)) {
              parsedMsgs.push({ role: 'user', text, ts: Date.parse(obj.timestamp) || Date.now() });
            }
          } else if (obj.type === 'assistant' && obj.message) {
            const text = extractTextFromContent(obj.message.content);
            if (text) parsedMsgs.push({ role: 'assistant', text, ts: Date.parse(obj.timestamp) || Date.now() });
          }
        }
      }

      for (const m of parsedMsgs.slice(-limit)) {
        session.lastSeq += 1;
        session.messages.push({
          id: randomUUID(),
          seq: session.lastSeq,
          role: m.role,
          text: m.text,
          createdAt: m.ts,
        });
      }
    } catch {}
  }

  _extractPromptAndImages(body = {}) {
    const textParts = [];
    const dispatchImages = [];
    const tempFiles = [];
    let inlineEngine = null;

    const pushText = raw => {
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      if (!trimmed) return;
      if (!inlineEngine && !trimmed.startsWith('[引用]')) {
        const parsed = stripInlineAgentPrefix(trimmed);
        if (parsed.inlineEngine) {
          inlineEngine = parsed.inlineEngine;
          if (parsed.text) textParts.push(parsed.text);
          return;
        }
      }
      textParts.push(trimmed);
    };

    if (typeof body.text === 'string' && body.text.trim()) {
      pushText(body.text);
    }

    const pushDataUrl = rawUrl => {
      const parsed = parseDataUrlImage(rawUrl);
      if (!parsed) return;
      const tmp = writeTempImageBuffer(parsed.buffer, parsed.ext);
      if (tmp) {
        tempFiles.push(tmp);
        dispatchImages.push(tmp);
      }
    };

    if (Array.isArray(body.content)) {
      for (const part of body.content) {
        if (!part) continue;
        if (typeof part === 'string') {
          if (part.startsWith('data:image/')) pushDataUrl(part);
          else if (part.trim()) pushText(part);
          continue;
        }
        if (typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          pushText(part.text);
        } else if (part.type === 'image') {
          if (typeof part.data === 'string' && part.data.startsWith('data:image/')) {
            pushDataUrl(part.data);
          } else if (typeof part.data === 'string' && part.data.trim()) {
            const ext = MIME_TO_EXT[String(part.mediaType || '').toLowerCase()] || '.png';
            const tmp = writeTempImageBuffer(Buffer.from(part.data, 'base64'), ext);
            if (tmp) {
              tempFiles.push(tmp);
              dispatchImages.push(tmp);
            }
          } else if (typeof part.url === 'string' && part.url.startsWith('data:image/')) {
            pushDataUrl(part.url);
          }
        } else if (part.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
          if (typeof url === 'string' && url.startsWith('data:image/')) {
            pushDataUrl(url);
          }
        }
      }
    } else if (typeof body.content === 'string' && body.content.trim()) {
      if (body.content.startsWith('data:image/')) pushDataUrl(body.content);
      else pushText(body.content);
    }

    if (Array.isArray(body.images)) {
      for (const img of body.images) {
        if (typeof img !== 'string' || !img.trim()) continue;
        if (img.startsWith('data:image/')) {
          pushDataUrl(img);
        } else {
          dispatchImages.push(img.trim());
        }
      }
    }

    return {
      text: textParts.join('\n').trim(),
      images: dispatchImages,
      tempFiles,
      inlineEngine,
    };
  }

  listSessions(source = 'auto') {
    const filter = String(source || 'auto').trim().toLowerCase();
    const out = [];
    for (const s of this.sessions.values()) {
      if (filter !== 'auto' && s.provider !== filter) continue;
      out.push({
        sessionId: s.sessionId,
        provider: s.provider,
        providerLabel: s.providerLabel,
        title: s.title,
        status: s.status,
        statusText: s.statusText,
        detail: s.detail,
        unread: Boolean(s.unread),
        updatedAt: s.updatedAt,
        lastSeq: s.lastSeq,
        capabilities: { reply: true, cancel: true, open: true },
      });
    }
    out.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    return out;
  }

  async handleAction(body = {}, currentSource = 'auto') {
    const action = String(body?.action || '').trim();

    if (action === 'info') {
      return {
        connected: true,
        speechAvailable: true,
        model: this.resolveEngine(currentSource),
        models: ['claude', 'codex'],
      };
    }

    if (action === 'models') {
      const current = this.resolveEngine(currentSource);
      return {
        current,
        models: [
          { id: 'claude', name: 'Claude Code' },
          { id: 'codex', name: 'Codex' },
        ],
        groups: [
          {
            id: 'local',
            name: '本地直连',
            models: [
              { id: 'claude', name: 'Claude Code' },
              { id: 'codex', name: 'Codex' },
            ],
          },
        ],
      };
    }

    if (action === 'selectModel') {
      const candidates = [
        body.targetAgent,
        body.engine,
        typeof body.model === 'string' ? body.model : null,
        body.model?.model,
        body.model?.id,
        body.model?.provider,
      ];
      let normalized = '';
      for (const cand of candidates) {
        const val = String(cand || '').trim().toLowerCase();
        if (VALID_ENGINES.has(val)) {
          normalized = val;
          break;
        }
      }
      if (normalized) {
        this.selectedEngine = normalized;
        const target = this._resolveSession(body.sessionId);
        if (target) {
          target.model = normalized;
          if (target.messages.length === 0) {
            target.provider = normalized;
            target.providerLabel = getProviderLabel(normalized);
          }
        }
      }
      return { model: this.selectedEngine || this.resolveEngine(currentSource) };
    }

    if (action === 'workspaces') {
      return {
        currentCwd: this.currentCwd(),
        workspaces: this.discoverWorkspaces(),
      };
    }

    if (action === 'selectWorkspace') {
      const resolvedCwd = this._validateOrResolveCwd(body.cwd, {
        allowUserSelection: Boolean(body.userSelected || body.browse),
      });
      this.selectedCwd = resolvedCwd;
      this.selectedSessionId = null;
      const reqEng = String(body.targetAgent || body.engine || '').trim().toLowerCase();
      const eng = VALID_ENGINES.has(reqEng) ? reqEng : this.resolveEngine(currentSource);
      this.onUpdate?.({ type: 'workspace', currentCwd: this.selectedCwd });
      return {
        currentCwd: this.selectedCwd,
        workspaces: this.discoverWorkspaces(),
        sessions: this.discoverSessions({ engine: eng, cwd: this.selectedCwd }),
      };
    }

    if (action === 'sessions') {
      const reqEng = String(body.targetAgent || body.engine || '').trim().toLowerCase();
      const eng = VALID_ENGINES.has(reqEng) ? reqEng : this.resolveEngine(currentSource);
      const targetCwd = body.cwd || this.currentCwd();
      return {
        currentCwd: this.currentCwd(),
        currentSessionId: this.selectedSessionId,
        sessions: this.discoverSessions({ engine: eng, cwd: targetCwd }),
      };
    }

    if (action === 'selectSession') {
      if (!body.sessionId || body.sessionId === 'new') {
        this.selectedSessionId = null;
        this.onUpdate?.({ type: 'session', sessionId: null });
        return {
          sessionId: null,
          isNew: true,
          currentCwd: this.currentCwd(),
        };
      }

      const existing = this._resolveSession(body.sessionId);
      if (existing) {
        this.selectedSessionId = existing.sessionId;
        if (existing.cwd) {
          this.selectedCwd = existing.cwd;
        }
        this.onUpdate?.({ type: 'session', sessionId: existing.sessionId });
        return {
          sessionId: existing.sessionId,
          cliSessionId: existing.cliSessionId,
          cwd: this.selectedCwd || existing.cwd || this.currentCwd(),
          title: existing.title,
        };
      }

      const reqEng = String(body.provider || body.targetAgent || body.engine || '').trim().toLowerCase();
      const eng = VALID_ENGINES.has(reqEng) ? reqEng : this.resolveEngine(currentSource);
      const session = this._createSession(eng);
      session.cliSessionId = String(body.cliSessionId || body.sessionId);
      if (typeof body.cwd === 'string' && body.cwd.trim()) {
        try {
          const validCwd = this._validateOrResolveCwd(body.cwd);
          session.cwd = validCwd;
          this.selectedCwd = validCwd;
        } catch {
          session.cwd = this.currentCwd();
        }
      } else {
        session.cwd = this.currentCwd();
      }
      session.title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : '历史会话';
      if (session.cliSessionId) {
        this.sessionAliases.set(session.cliSessionId, session.sessionId);
      }
      this._hydrateHistoricalMessages(session);
      this.selectedSessionId = session.sessionId;
      this.onUpdate?.({ type: 'session', sessionId: session.sessionId });
      return {
        sessionId: session.sessionId,
        cliSessionId: session.cliSessionId,
        cwd: session.cwd,
        title: session.title,
      };
    }

    if (action === 'skills') {
      return {
        skills: [
          { name: 'diff', description: '查看当前工作区 git diff' },
          { name: 'status', description: '查看任务状态' },
        ],
      };
    }

    if (action === 'files') {
      const files = listWorkspaceFiles(this.currentCwd(), body.query || '', MAX_LIST_FILES);
      return { files, candidates: files };
    }

    if (action === 'conversation') {
      const session = this._resolveSession(body.sessionId);
      if (!session) {
        throw new Error('未找到对应的本地会话');
      }
      session.unread = false;
      return {
        sessionId: session.sessionId,
        title: session.title,
        status: session.status,
        detail: session.detail,
        lastSeq: session.lastSeq,
        messages: session.messages.map(m => ({ ...m })),
      };
    }

    if (action === 'focus') {
      const session = this._resolveSession(body.sessionId);
      if (session) session.unread = false;
      return { ok: true, sessionId: session?.sessionId || body.sessionId || null };
    }

    if (action === 'cancel') {
      const session = this._resolveSession(body.sessionId);
      if (!session) {
        return { cancelled: false };
      }
      if (session.activeJobId && this.dispatcher?.stopJob) {
        await this.dispatcher.stopJob(session.activeJobId).catch(() => {});
      }
      session.activeJobId = null;
      session.status = 'cancelled';
      session.statusText = '已取消';
      session.detail = '任务已取消';
      session.lastSeq += 1;
      session.updatedAt = Date.now();
      this.onUpdate?.({ type: 'chat', sessionId: session.sessionId, status: session.status });
      return { cancelled: true };
    }

    if (action === 'create' || action === 'prompt') {
      const { text: promptText, images, tempFiles, inlineEngine } = this._extractPromptAndImages(body);
      const requested = String(inlineEngine || body.targetAgent || body.engine || '').trim().toLowerCase();
      const engine = VALID_ENGINES.has(requested) ? requested : this.resolveEngine(currentSource);
      const lookupId = body.sessionId || this.selectedSessionId || null;
      const existing = this._resolveSession(lookupId);
      let session = existing && existing.provider === engine ? existing : null;
      if (!session) {
        session = this._createSession(engine, existing ? null : (body.sessionId || null));
      }

      if (typeof body.cwd === 'string' && body.cwd.trim()) {
        session.cwd = this._validateOrResolveCwd(body.cwd);
      } else if (!session.cwd) {
        session.cwd = this.currentCwd();
      }

      if (!promptText && images.length === 0) {
        if (action === 'create') {
          return { sessionId: session.sessionId, status: session.status, cwd: session.cwd };
        }
        throw new Error('任务内容不能为空');
      }

      if (!this.dispatcher || typeof this.dispatcher.dispatch !== 'function') {
        for (const f of tempFiles) fs.promises.unlink(f).catch(() => {});
        throw new Error('任务调度器未初始化');
      }

      const effectivePrompt = promptText || '请分析这张图片中的问题并给出解决方案';
      if (session.messages.length === 0 || session.title === '本地对话') {
        session.title = effectivePrompt.replace(/\s+/g, ' ').slice(0, 32);
      }

      session.lastSeq += 1;
      session.messages.push({
        id: randomUUID(),
        seq: session.lastSeq,
        role: 'user',
        text: effectivePrompt,
        createdAt: Date.now(),
      });
      session.status = 'running';
      session.statusText = '正在思考';
      session.detail = '正在思考';
      session.unread = false;
      session.updatedAt = Date.now();
      this.onUpdate?.({ type: 'chat', sessionId: session.sessionId, status: session.status });

      const dispatchEngine = session.provider || engine;
      const dispatchCwd = session.cwd || this.currentCwd();
      const runPromise = this.dispatcher.dispatch({
        engine: dispatchEngine,
        prompt: effectivePrompt,
        cwd: dispatchCwd,
        sessionId: session.cliSessionId,
        images,
        onProgress: ev => {
          if (session.status !== 'running') return;
          if (ev?.tool) {
            session.detail = `正在使用 ${ev.tool}`;
            session.lastSeq += 1;
            session.updatedAt = Date.now();
            this.onUpdate?.({ type: 'chat', sessionId: session.sessionId, status: session.status });
          } else if (ev?.text) {
            session.detail = String(ev.text).slice(0, 80);
            session.lastSeq += 1;
            session.updatedAt = Date.now();
            this.onUpdate?.({ type: 'chat', sessionId: session.sessionId, status: session.status });
          }
        },
      });

      // `dispatch()` records the job synchronously before its first await.
      const jobsList = this.dispatcher.jobs ? [...this.dispatcher.jobs.values()] : [];
      const latestJob = jobsList[jobsList.length - 1];
      if (latestJob && latestJob.status === 'running') {
        session.activeJobId = latestJob.jobId;
      }

      runPromise
        .then(res => {
          session.activeJobId = null;
          if (res?.sessionId) {
            session.cliSessionId = res.sessionId;
            this.sessionAliases.set(res.sessionId, session.sessionId);
          }
          if (res?.status === 'cancelled' || session.status === 'cancelled') {
            if (session.status !== 'cancelled') {
              session.status = 'cancelled';
              session.statusText = '已取消';
              session.detail = res?.text || '任务已取消';
              session.lastSeq += 1;
              session.updatedAt = Date.now();
            }
            this.onUpdate?.({ type: 'chat', sessionId: session.sessionId, status: session.status });
            return;
          }
          if (res?.status === 'failed') {
            const errMsg = res.error || res.text || '执行失败';
            session.lastSeq += 1;
            session.messages.push({
              id: randomUUID(),
              seq: session.lastSeq,
              role: 'assistant',
              text: errMsg,
              createdAt: Date.now(),
            });
            session.status = 'blocked';
            session.statusText = '遇到问题';
            session.detail = errMsg.slice(0, 80);
            session.updatedAt = Date.now();
            this.onUpdate?.({ type: 'chat', sessionId: session.sessionId, status: session.status });
            return;
          }
          const replyText = String(res?.text || '（执行完成，无文本输出）').trim();
          session.lastSeq += 1;
          session.messages.push({
            id: randomUUID(),
            seq: session.lastSeq,
            role: 'assistant',
            text: replyText,
            createdAt: Date.now(),
          });
          session.status = 'ready';
          session.statusText = '已完成';
          session.detail = replyText.slice(0, 80);
          session.unread = true;
          session.updatedAt = Date.now();
          this.onUpdate?.({ type: 'chat', sessionId: session.sessionId, status: session.status });
        })
        .catch(err => {
          session.activeJobId = null;
          if (session.status === 'cancelled') return;
          const errMsg = err?.message || String(err);
          session.lastSeq += 1;
          session.messages.push({
            id: randomUUID(),
            seq: session.lastSeq,
            role: 'assistant',
            text: errMsg,
            createdAt: Date.now(),
          });
          session.status = 'blocked';
          session.statusText = '遇到问题';
          session.detail = errMsg.slice(0, 80);
          session.updatedAt = Date.now();
          this.onUpdate?.({ type: 'chat', sessionId: session.sessionId, status: session.status });
        })
        .finally(() => {
          for (const f of tempFiles) {
            fs.promises.unlink(f).catch(() => {});
          }
        });

      return { sessionId: session.sessionId, status: 'running', cwd: dispatchCwd };
    }

    throw new Error(`不支持的本地对话操作: ${action}`);
  }
}

module.exports = {
  LocalChatBridge,
  listWorkspaceFiles,
  parseDataUrlImage,
};
