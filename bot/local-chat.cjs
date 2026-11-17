'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { URL, pathToFileURL } = require('node:url');
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
  'workbuddy-ai': 'WorkBuddy AI',
  dsh: 'DSH',
};

const DIRECT_ENGINES = new Set(['claude', 'codex', 'opencode', 'workbuddy-ai']);
const VALID_ENGINES = new Set(['claude', 'codex', 'opencode', 'workbuddy-ai', 'dsh']);
const MAX_DISCOVER_FILES = 15;
const MAX_DISCOVER_WORKSPACES = 12;
const MAX_DISCOVER_SESSIONS = 10;
const MAX_EXTRA_WORKSPACES = 20;
const MAX_EXTRA_CACHE_ITEMS = 60;
const MAX_EXTRA_SCAN_ENTRIES = 6000;
const EXTRA_SCAN_CACHE_TTL_MS = 30_000;
const JSONL_HEAD_BYTES = 65536;

const VSCODE_FORK_APP_NAMES = {
  cursor: 'Cursor',
  kiro: 'Kiro',
  trae: 'Trae',
  'trae-cn': 'Trae CN',
  'qoder-cn': ['Qoder CN', 'com.qodercn.app.stable', 'com.qodercn.app'],
  qoder: ['Qoder', 'com.qoder.app.stable', 'com.qoder.app'],
  windsurf: 'Windsurf',
  codebuddy: 'CodeBuddy',
  'codebuddy-cn': 'CodeBuddy CN',
  copilot: 'Code',
};

const WORKBUDDY_PLAYGROUND_DIR_RE = /[\\/]WorkBuddy(?:\sAI)?[\\/]\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;

const PROJECT_MARKERS = ['.git', 'package.json', 'Package.swift', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
const EXTRA_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'Library',
  'Applications',
  'dist',
  'build',
  '.next',
  '.cache',
  'DerivedData',
  '__pycache__',
  'venv',
]);

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

function readJsonSafe(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function querySqliteJson(dbPath, sql) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) return [];
  const resolved = path.resolve(dbPath.trim());
  try {
    if (!fs.statSync(resolved).isFile()) return [];
  } catch {
    return [];
  }

  const attempts = [
    resolved,
    `${pathToFileURL(resolved).href}?mode=ro`,
    `${pathToFileURL(resolved).href}?immutable=1`,
  ];
  for (const target of attempts) {
    try {
      const raw = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', target, sql], {
        timeout: 1500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const trimmed = String(raw || '').trim();
      if (!trimmed) return [];
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Retry with read-only URI options when WAL/locked DBs reject bare -readonly.
    }
  }
  return [];
}

function getSqliteColumns(dbPath, tableName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(tableName || ''))) {
    return new Set();
  }
  const rows = querySqliteJson(dbPath, `PRAGMA table_info(${tableName});`);
  const cols = new Set();
  for (const row of rows) {
    if (row && typeof row.name === 'string' && row.name) {
      cols.add(row.name);
    }
  }
  return cols;
}

function isSyntheticInternalPath(dirPath, appSupportDir = null) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return false;
  let candidate = dirPath.trim();
  if (candidate.startsWith('file://')) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch {}
  }
  const normalized = candidate.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return false;

  if (
    normalized.includes('/CodexBar/ClaudeProbe')
    || normalized.includes('/Trae CN/solo-lite')
    || normalized.includes('/Trae/solo-lite')
    || normalized.includes('solo-lite-runtime.code-workspace')
    || normalized.includes('solo-lite-default-workspace')
    || normalized.includes('/Library/Application Support/')
    || normalized.endsWith('/Library/Application Support')
  ) {
    return true;
  }

  const checkRoots = [path.join(os.homedir(), 'Library', 'Application Support')];
  if (appSupportDir) checkRoots.push(appSupportDir);

  const realTarget = safeRealpath(candidate) || path.resolve(candidate);
  for (const root of checkRoots) {
    const realRoot = safeRealpath(root) || path.resolve(root);
    if (!realRoot) continue;
    if (realTarget === realRoot || realTarget.startsWith(realRoot === path.sep ? realRoot : `${realRoot}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

function isWorkbuddyPlaygroundPath(dirPath, playgroundSet = null) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return false;
  const trimmed = dirPath.trim().replace(/[\\/]+$/, '');
  if (WORKBUDDY_PLAYGROUND_DIR_RE.test(trimmed)) return true;
  if (playgroundSet && playgroundSet.size > 0) {
    const real = safeRealpath(trimmed) || trimmed;
    if (playgroundSet.has(real) || playgroundSet.has(trimmed)) return true;
  }
  return false;
}

function parseFileUri(uri, { parentIfFile = false } = {}) {
  if (typeof uri !== 'string') return null;
  const trimmed = uri.trim();
  if (!trimmed || !trimmed.startsWith('file://')) return null;
  try {
    const urlObj = new URL(trimmed);
    if (urlObj.protocol !== 'file:') return null;
    let decoded = decodeURIComponent(urlObj.pathname);
    if (!decoded) return null;
    if (parentIfFile) {
      if (decoded.endsWith('.code-workspace')) {
        decoded = path.dirname(decoded);
      } else {
        try {
          if (fs.statSync(decoded).isFile()) {
            decoded = path.dirname(decoded);
          }
        } catch {}
      }
    }
    const real = safeRealpath(decoded);
    return real && isExistingDirectory(real) ? real : null;
  } catch {
    return null;
  }
}

function resolveWorkspaceCandidate(raw, { parentIfFile = false } = {}) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('file://')) {
    return parseFileUri(trimmed, { parentIfFile });
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return null;
  }
  const expanded = trimmed === '~'
    ? os.homedir()
    : trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed;
  let candidate = expanded;
  if (parentIfFile && candidate.endsWith('.code-workspace')) {
    candidate = path.dirname(candidate);
  }
  const real = safeRealpath(candidate);
  return real && isExistingDirectory(real) ? real : null;
}

function parseWorkspaceUris(raw) {
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {}
  }
  const resolved = [];
  for (const uri of list) {
    const dir = parseFileUri(uri);
    if (dir) resolved.push(dir);
  }
  return resolved;
}

function hasProjectMarker(dirPath) {
  for (const marker of PROJECT_MARKERS) {
    try {
      if (fs.existsSync(path.join(dirPath, marker))) return true;
    } catch {}
  }
  return false;
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
  const match = text.match(/^@(claude|codex|opencode|workbuddy-ai|dsh)(?:\s+([\s\S]*))?$/i);
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
  constructor({
    dispatcher,
    getConfig,
    onUpdate,
    providers,
    codexSessionsDir,
    claudeProjectsDir,
    appSupportDir,
    opencodeDbPath,
    zcodeDir,
    workbuddyDbPath,
    workbuddyAiDbPath,
    antigravityDbPath,
    antigravityConfigDir,
    claudeJsonPath,
    codexGlobalStatePath,
    qoderCnProjectsDir,
    qoderProjectsDir,
    kiroDir,
    copilotDir,
    extraScanRoots,
  } = {}) {
    this.dispatcher = dispatcher || null;
    this.providers = providers || dispatcher?.providers || null;
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.onUpdate = typeof onUpdate === 'function' ? onUpdate : null;
    this.sessions = new Map();
    this.sessionAliases = new Map();
    this.selectedEngine = null;
    this.selectedCwd = null;
    this.selectedSessionId = null;
    const home = os.homedir();
    this._codexSessionsDir = codexSessionsDir || path.join(home, '.codex', 'sessions');
    this._claudeProjectsDir = claudeProjectsDir || path.join(home, '.claude', 'projects');
    this._appSupportDir = appSupportDir || path.join(home, 'Library', 'Application Support');
    this._opencodeDbPath = opencodeDbPath || path.join(home, '.local', 'share', 'opencode', 'opencode.db');
    this._zcodeDir = zcodeDir || path.join(home, '.zcode', 'v2');
    this._workbuddyDbPath = workbuddyDbPath || path.join(home, '.workbuddy', 'workbuddy.db');
    this._workbuddyAiDbPath = workbuddyAiDbPath || path.join(home, '.workbuddy-ai', 'workbuddy.db');
    this._antigravityDbPath = antigravityDbPath || path.join(home, '.gemini', 'antigravity', 'conversation_summaries.db');
    this._antigravityConfigDir = antigravityConfigDir || path.join(home, '.gemini', 'config');
    this._claudeJsonPath = claudeJsonPath || path.join(home, '.claude.json');
    this._codexGlobalStatePath = codexGlobalStatePath || path.join(home, '.codex', '.codex-global-state.json');
    this._qoderCnProjectsDir = qoderCnProjectsDir || path.join(home, '.qoder-cn', 'projects');
    this._qoderProjectsDir = qoderProjectsDir || path.join(home, '.qoder', 'projects');
    this._kiroDir = kiroDir || path.join(home, '.kiro');
    this._copilotDir = copilotDir || path.join(home, '.copilot');
    this._extraScanRoots = Array.isArray(extraScanRoots)
      ? extraScanRoots
      : [
        path.join(home, 'AI'),
        path.join(home, 'AI', 'Codex'),
        path.join(home, 'Desktop'),
        path.join(home, 'Documents'),
        path.join(home, 'Projects'),
        path.join(home, 'Developer'),
        path.join(home, 'Code'),
        path.join(home, 'workspace'),
        home,
      ];
    this._extraCache = null;
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

  _isAllowedWorkspace(real) {
    if (!real || !isExistingDirectory(real)) return false;
    if (this.dispatcher && typeof this.dispatcher.validateWorkspace === 'function') {
      try {
        this.dispatcher.validateWorkspace(real);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  _resolveTargetEngine(engine) {
    const reqEng = String(engine || '').trim().toLowerCase();
    return reqEng && reqEng !== 'auto' ? reqEng : this.resolveEngine('auto');
  }

  _collectVscodeForkWorkspaces(appNames, pushCandidate) {
    const names = Array.isArray(appNames) ? appNames : [appNames];
    for (const appName of names) {
      if (!appName) continue;
      const userDir = path.join(this._appSupportDir, appName, 'User');
      const globalStorage = path.join(userDir, 'globalStorage');
      const storage = readJsonSafe(path.join(globalStorage, 'storage.json'));
      if (storage && typeof storage === 'object') {
        const openedWindows = Array.isArray(storage.windowsState?.openedWindows)
          ? storage.windowsState.openedWindows
          : [];
        for (const win of openedWindows) {
          if (!win || typeof win !== 'object') continue;
          const uri = win.folder || win.workspaceIdentifier?.configURIPath;
          if (uri) {
            pushCandidate(uri, { isOpen: true, parentIfFile: !win.folder });
          }
        }

        const backupFolders = Array.isArray(storage.backupWorkspaces?.folders)
          ? storage.backupWorkspaces.folders
          : [];
        for (const item of backupFolders) {
          if (item?.folderUri) {
            pushCandidate(item.folderUri, { isOpen: true });
          }
        }
        const backupWorkspaces = Array.isArray(storage.backupWorkspaces?.workspaces)
          ? storage.backupWorkspaces.workspaces
          : [];
        for (const item of backupWorkspaces) {
          if (item?.configURIPath) {
            pushCandidate(item.configURIPath, { isOpen: true, parentIfFile: true });
          }
        }

        const lastActive = storage.windowsState?.lastActiveWindow;
        if (lastActive && typeof lastActive === 'object') {
          const uri = lastActive.folder || lastActive.workspaceIdentifier?.configURIPath;
          if (uri) {
            pushCandidate(uri, { isOpen: false, parentIfFile: !lastActive.folder });
          }
        }
      }

      const vscdbPath = path.join(globalStorage, 'state.vscdb');
      const itemCols = getSqliteColumns(vscdbPath, 'ItemTable');
      if (itemCols.has('value') && itemCols.has('key')) {
        const rows = querySqliteJson(
          vscdbPath,
          "SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList' LIMIT 1;",
        );
        if (rows[0]?.value) {
          try {
            const parsed = JSON.parse(rows[0].value);
            const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
            for (const entry of entries) {
              if (!entry || typeof entry !== 'object') continue;
              if (entry.folderUri) {
                pushCandidate(entry.folderUri, { isOpen: false });
              } else if (entry.workspace?.configPath) {
                pushCandidate(entry.workspace.configPath, { isOpen: false, parentIfFile: true });
              }
            }
          } catch {}
        }
      }

      const wsStorageDir = path.join(userDir, 'workspaceStorage');
      if (isExistingDirectory(wsStorageDir)) {
        const wsFiles = [];
        let entries = [];
        try {
          entries = fs.readdirSync(wsStorageDir, { withFileTypes: true });
        } catch {}
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const wsJsonPath = path.join(wsStorageDir, entry.name, 'workspace.json');
          try {
            const stat = fs.statSync(wsJsonPath);
            if (stat.isFile()) {
              wsFiles.push({ filePath: wsJsonPath, mtimeMs: stat.mtimeMs });
            }
          } catch {}
        }
        wsFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const { filePath } of wsFiles) {
          const data = readJsonSafe(filePath);
          if (!data || typeof data !== 'object') continue;
          const raw = data.folder || data.workspace;
          if (typeof raw === 'string' && raw.trim()) {
            pushCandidate(raw, { isOpen: false, parentIfFile: !data.folder });
          }
        }
      }
    }
  }

  _collectQoderProjects(projectsDir, pushCandidate) {
    if (!isExistingDirectory(projectsDir)) return;
    let subdirs = [];
    try {
      subdirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return;
    }

    const projectDirs = [];
    for (const entry of subdirs) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const subPath = path.join(projectsDir, entry.name);
      let files = [];
      try {
        files = fs.readdirSync(subPath, { withFileTypes: true });
      } catch {
        continue;
      }
      const jsonls = [];
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const fullPath = path.join(subPath, f.name);
        try {
          const stat = fs.statSync(fullPath);
          jsonls.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
        } catch {}
      }
      if (jsonls.length === 0) continue;
      jsonls.sort((a, b) => b.mtimeMs - a.mtimeMs);
      projectDirs.push({ newestMtimeMs: jsonls[0].mtimeMs, jsonls });
    }

    projectDirs.sort((a, b) => b.newestMtimeMs - a.newestMtimeMs);
    for (const proj of projectDirs.slice(0, 40)) {
      let found = false;
      for (const { filePath } of proj.jsonls.slice(0, 3)) {
        const lines = readHeadLines(filePath, 16384);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('{')) continue;
          let obj;
          try { obj = JSON.parse(trimmed); } catch { continue; }
          if (obj && obj.type === 'workspace-directories' && Array.isArray(obj.directories)) {
            for (const dir of obj.directories) {
              if (typeof dir === 'string' && dir.trim()) {
                pushCandidate(dir, { isOpen: false });
              }
            }
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }
  }

  _collectKiroWorkspaceRoots(pushCandidate) {
    const rootsDir = path.join(this._kiroDir, 'workspace-roots');
    if (!isExistingDirectory(rootsDir)) return;
    const files = [];
    const stack = [{ dir: rootsDir, depth: 0 }];
    while (stack.length > 0) {
      const { dir, depth } = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 2) stack.push({ dir: fullPath, depth: depth + 1 });
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(fullPath);
            files.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
          } catch {}
        }
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const pushFromValue = val => {
      if (typeof val === 'string' && val.trim()) {
        pushCandidate(val, { isOpen: false });
      } else if (Array.isArray(val)) {
        for (const item of val) pushFromValue(item);
      } else if (val && typeof val === 'object') {
        for (const key of ['root', 'path', 'folder', 'workspace', 'folderUri', 'roots']) {
          if (val[key] !== undefined) pushFromValue(val[key]);
        }
      }
    };

    for (const { filePath } of files) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        if (!raw) continue;
        if (raw.startsWith('{') || raw.startsWith('[')) {
          try {
            pushFromValue(JSON.parse(raw));
            continue;
          } catch {}
        }
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('/') || trimmed.startsWith('file://') || trimmed.startsWith('~/')) {
            pushCandidate(trimmed, { isOpen: false });
          }
        }
      } catch {}
    }
  }

  _collectCopilotIdeWorkspaces(pushCandidate) {
    const ideDir = path.join(this._copilotDir, 'ide');
    if (!isExistingDirectory(ideDir)) return;
    const files = [];
    let entries = [];
    try {
      entries = fs.readdirSync(ideDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(ideDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        files.push({ filePath: fullPath, mtimeMs: stat.mtimeMs });
      } catch {}
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const { filePath } of files) {
      const data = readJsonSafe(filePath);
      if (!data || typeof data !== 'object') continue;
      const folderLists = [data.workspaceFolders, data.folders].filter(Array.isArray);
      for (const list of folderLists) {
        for (const item of list) {
          const cand = typeof item === 'string' ? item : (item?.uri || item?.path || item?.folder);
          if (cand) pushCandidate(cand, { isOpen: false });
        }
      }
      for (const key of ['cwd', 'workspacePath', 'folder', 'rootPath']) {
        if (typeof data[key] === 'string' && data[key].trim()) {
          pushCandidate(data[key], { isOpen: false });
        }
      }
    }
  }

  _collectAntigravityWorkspaces(pushCandidate) {
    const cols = getSqliteColumns(this._antigravityDbPath, 'conversation_summaries');
    if (cols.has('workspace_uris') && cols.has('last_modified_time')) {
      const hasStatus = cols.has('status');
      const hasNotFullyIdle = cols.has('not_fully_idle');
      const openExpr = hasStatus && hasNotFullyIdle
        ? "MAX(CASE WHEN status = 'CASCADE_RUN_STATUS_RUNNING' OR not_fully_idle = 1 THEN 1 ELSE 0 END) AS is_open"
        : hasStatus
          ? "MAX(CASE WHEN status = 'CASCADE_RUN_STATUS_RUNNING' THEN 1 ELSE 0 END) AS is_open"
          : hasNotFullyIdle
            ? 'MAX(CASE WHEN not_fully_idle = 1 THEN 1 ELSE 0 END) AS is_open'
            : '0 AS is_open';
      const rows = querySqliteJson(
        this._antigravityDbPath,
        `SELECT workspace_uris, MAX(last_modified_time) AS ts, ${openExpr} FROM conversation_summaries WHERE workspace_uris IS NOT NULL AND workspace_uris != '' GROUP BY workspace_uris ORDER BY ts DESC LIMIT 20;`,
      );
      for (const row of rows) {
        const isOpen = Boolean(Number(row?.is_open || 0));
        for (const dir of parseWorkspaceUris(row?.workspace_uris)) {
          pushCandidate(dir, { isOpen });
        }
      }
    }

    const appStorage = readJsonSafe(path.join(this._appSupportDir, 'Antigravity', 'app_storage.json'));
    const lastCreatedProjectId = typeof appStorage?.lastCreatedProjectId === 'string'
      ? appStorage.lastCreatedProjectId
      : '';
    const projectsOrder = Array.isArray(appStorage?.projectsOrder) ? appStorage.projectsOrder : [];
    const orderRank = new Map();
    projectsOrder.forEach((id, idx) => {
      if (typeof id === 'string' && id && !orderRank.has(id)) orderRank.set(id, idx);
    });

    const projectsDir = path.join(this._antigravityConfigDir, 'projects');
    if (isExistingDirectory(projectsDir)) {
      let files = [];
      try {
        files = fs.readdirSync(projectsDir, { withFileTypes: true });
      } catch {}
      const projectEntries = [];
      for (const entry of files) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        if (entry.name === 'outside-of-project.json') continue;
        const fullPath = path.join(projectsDir, entry.name);
        const data = readJsonSafe(fullPath);
        if (!data || typeof data !== 'object' || data.sidecar || data.id === 'outside-of-project') continue;
        const resources = Array.isArray(data.projectResources?.resources) ? data.projectResources.resources : [];
        const uris = [];
        for (const res of resources) {
          if (!res || typeof res !== 'object') continue;
          if (typeof res.folderUri === 'string' && res.folderUri.trim()) uris.push(res.folderUri.trim());
          if (typeof res.gitFolder?.folderUri === 'string' && res.gitFolder.folderUri.trim()) {
            uris.push(res.gitFolder.folderUri.trim());
          }
        }
        if (uris.length === 0) continue;
        const projId = typeof data.id === 'string' && data.id ? data.id : path.basename(entry.name, '.json');
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch {}
        projectEntries.push({
          uris,
          isLastCreated: Boolean(lastCreatedProjectId && projId === lastCreatedProjectId),
          orderIdx: orderRank.has(projId) ? orderRank.get(projId) : Infinity,
          mtimeMs,
        });
      }
      projectEntries.sort((a, b) => {
        if (a.isLastCreated !== b.isLastCreated) return a.isLastCreated ? -1 : 1;
        if (a.orderIdx !== b.orderIdx) return a.orderIdx - b.orderIdx;
        return b.mtimeMs - a.mtimeMs;
      });
      for (const item of projectEntries) {
        for (const uri of item.uris) {
          pushCandidate(uri, { isOpen: false });
        }
      }
    }

    this._collectVscodeForkWorkspaces('Antigravity', pushCandidate);
  }

  _collectWorkbuddyWorkspaces(dbPath, pushCandidate, hasRealCandidate) {
    const playgroundSet = new Set();
    const playgroundCandidates = [];

    const spaceCols = getSqliteColumns(dbPath, 'spaces');
    if (spaceCols.size > 0) {
      const pathExpr = spaceCols.has('path')
        ? 'path'
        : (spaceCols.has('primary_folder_path') && spaceCols.has('create_folder_path'))
          ? "COALESCE(NULLIF(primary_folder_path, ''), create_folder_path)"
          : spaceCols.has('primary_folder_path')
            ? 'primary_folder_path'
            : spaceCols.has('create_folder_path')
              ? 'create_folder_path'
              : null;
      if (pathExpr) {
        const conds = [`${pathExpr} IS NOT NULL`, `${pathExpr} != ''`];
        if (spaceCols.has('status')) conds.push("(status IS NULL OR status = 'active')");
        if (spaceCols.has('deleted_at')) conds.push('(deleted_at IS NULL OR deleted_at <= 0)');
        const orderExpr = spaceCols.has('updated_at') ? 'MAX(updated_at)' : '1';
        const rows = querySqliteJson(
          dbPath,
          `SELECT ${pathExpr} AS path, ${orderExpr} AS ts FROM spaces WHERE ${conds.join(' AND ')} GROUP BY ${pathExpr} ORDER BY ts DESC LIMIT 20;`,
        );
        for (const row of rows) {
          if (row?.path) pushCandidate(row.path, { isOpen: false });
        }
      }
    }

    const sessionCols = getSqliteColumns(dbPath, 'sessions');
    const hasIsPlayground = sessionCols.has('is_playground');
    const deletedCond = sessionCols.has('deleted_at') ? 'deleted_at IS NULL AND ' : '';
    const sessionTsExpr = sessionCols.has('last_activity_at') && sessionCols.has('updated_at')
      ? 'MAX(COALESCE(last_activity_at, updated_at))'
      : sessionCols.has('updated_at')
        ? 'MAX(updated_at)'
        : '1';

    if (hasIsPlayground && sessionCols.has('cwd')) {
      const realRows = querySqliteJson(
        dbPath,
        `SELECT cwd, ${sessionTsExpr} AS ts FROM sessions WHERE ${deletedCond}cwd IS NOT NULL AND cwd != '' AND COALESCE(is_playground, 0) = 0 GROUP BY cwd ORDER BY ts DESC LIMIT 20;`,
      );
      for (const row of realRows) {
        if (row?.cwd && !isWorkbuddyPlaygroundPath(row.cwd)) {
          pushCandidate(row.cwd, { isOpen: false });
        }
      }

      const pgRows = querySqliteJson(
        dbPath,
        `SELECT cwd, ${sessionTsExpr} AS ts FROM sessions WHERE ${deletedCond}cwd IS NOT NULL AND cwd != '' AND is_playground = 1 GROUP BY cwd ORDER BY ts DESC LIMIT 50;`,
      );
      for (const row of pgRows) {
        if (!row?.cwd) continue;
        const real = safeRealpath(row.cwd);
        if (real) playgroundSet.add(real);
        playgroundSet.add(row.cwd.trim());
        playgroundCandidates.push(row.cwd);
      }
    }

    const wsCols = getSqliteColumns(dbPath, 'workspaces');
    if (wsCols.has('path')) {
      const orderCol = wsCols.has('last_opened_at')
        ? 'last_opened_at'
        : (wsCols.has('updated_at') ? 'updated_at' : 'rowid');
      const rows = querySqliteJson(
        dbPath,
        `SELECT path, ${orderCol} AS ts FROM workspaces WHERE path IS NOT NULL AND path != '' ORDER BY ${orderCol} DESC LIMIT 30;`,
      );
      for (const row of rows) {
        if (!row?.path) continue;
        if (isWorkbuddyPlaygroundPath(row.path, playgroundSet)) {
          playgroundCandidates.push(row.path);
        } else {
          pushCandidate(row.path, { isOpen: false });
        }
      }
    }

    if (!hasRealCandidate() && !hasIsPlayground && sessionCols.has('cwd')) {
      const fallbackRows = querySqliteJson(
        dbPath,
        `SELECT cwd, ${sessionTsExpr} AS ts FROM sessions WHERE ${deletedCond}cwd IS NOT NULL AND cwd != '' GROUP BY cwd ORDER BY ts DESC LIMIT 20;`,
      );
      for (const row of fallbackRows) {
        if (!row?.cwd) continue;
        if (isWorkbuddyPlaygroundPath(row.cwd, playgroundSet)) {
          playgroundCandidates.push(row.cwd);
        } else {
          pushCandidate(row.cwd, { isOpen: false });
        }
      }
    }

    if (!hasRealCandidate()) {
      for (const pgPath of playgroundCandidates) {
        pushCandidate(pgPath, { isOpen: false });
      }
    }
  }

  _collectClaudeWorkspaces(pushCandidate) {
    const files = collectRecentJsonlFiles(this._claudeProjectsDir, 2, 60);
    for (const { filePath, mtimeMs } of files) {
      const meta = parseClaudeSessionMeta(filePath, mtimeMs);
      if (meta?.cwd) pushCandidate(meta.cwd, { isOpen: false });
    }
    const claudeJson = readJsonSafe(this._claudeJsonPath);
    if (claudeJson?.projects && typeof claudeJson.projects === 'object') {
      const entries = Object.entries(claudeJson.projects)
        .map(([dir, info]) => ({ dir, ts: Number(info?.lastSessionModified || 0) }))
        .sort((a, b) => b.ts - a.ts);
      for (const { dir } of entries) {
        pushCandidate(dir, { isOpen: false });
      }
    }
  }

  _collectCodexWorkspaces(pushCandidate) {
    const gs = readJsonSafe(this._codexGlobalStatePath);
    if (gs && typeof gs === 'object') {
      for (const [key, val] of Object.entries(gs)) {
        if (key === 'active-workspace-roots' || key.startsWith('electron-owner-value:active-workspace-roots:')) {
          if (Array.isArray(val)) {
            for (const root of val) {
              if (typeof root === 'string') pushCandidate(root, { isOpen: true });
            }
          }
        }
      }
    }

    const files = collectRecentJsonlFiles(this._codexSessionsDir, 4, 60);
    for (const { filePath, mtimeMs } of files) {
      const meta = parseCodexSessionMeta(filePath, mtimeMs);
      if (meta?.cwd) pushCandidate(meta.cwd, { isOpen: false });
    }

    if (gs && typeof gs === 'object') {
      if (gs['local-projects'] && typeof gs['local-projects'] === 'object') {
        const projects = Object.values(gs['local-projects'])
          .filter(p => p && typeof p === 'object')
          .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
        for (const proj of projects) {
          if (Array.isArray(proj.rootPaths)) {
            for (const rp of proj.rootPaths) {
              if (typeof rp === 'string') pushCandidate(rp, { isOpen: false });
            }
          }
          if (typeof proj.path === 'string') pushCandidate(proj.path, { isOpen: false });
          if (typeof proj.rootPath === 'string') pushCandidate(proj.rootPath, { isOpen: false });
        }
      }

      for (const [key, val] of Object.entries(gs)) {
        if (key === 'electron-saved-workspace-roots' || key.startsWith('electron-owner-value:electron-saved-workspace-roots:')) {
          if (Array.isArray(val)) {
            for (const root of val) {
              if (typeof root === 'string') pushCandidate(root, { isOpen: false });
            }
          }
        }
      }
    }
  }

  discoverWorkspaces({ engine, includeExtra = false, providers } = {}) {
    const targetEngine = this._resolveTargetEngine(engine);
    const activeProviders = providers || this.providers || this.dispatcher?.providers || null;
    const activeReal = safeRealpath(this.currentCwd()) || this.currentCwd();
    const homeReal = safeRealpath(os.homedir()) || os.homedir();

    const ordered = [];
    const byReal = new Map();
    const deferredRoots = [];
    const byRootReal = new Map();

    const addEntry = (list, map, real, isOpen) => {
      const existing = map.get(real);
      if (existing) {
        if (isOpen && !existing.isOpen) existing.isOpen = true;
        return false;
      }
      const entry = { real, isOpen: Boolean(isOpen) };
      map.set(real, entry);
      list.push(entry);
      return true;
    };

    const pushCandidate = (raw, { isOpen = false, parentIfFile = false, allowRoot = false } = {}) => {
      if (typeof raw !== 'string' || !raw.trim()) return false;
      if (isSyntheticInternalPath(raw, this._appSupportDir)) return false;
      const real = resolveWorkspaceCandidate(raw, { parentIfFile });
      if (!real || isSyntheticInternalPath(real, this._appSupportDir) || !this._isAllowedWorkspace(real)) {
        return false;
      }
      if (!allowRoot && (real === homeReal || real === '/')) {
        addEntry(deferredRoots, byRootReal, real, isOpen);
        return false;
      }
      return addEntry(ordered, byReal, real, isOpen);
    };

    // 1. Live sessions for targetEngine only (never cross-contaminate with this.selectedCwd).
    for (const s of this.sessions.values()) {
      if (s.provider !== targetEngine || !s.cwd) continue;
      pushCandidate(s.cwd, { isOpen: ['running', 'waiting', 'blocked'].includes(s.status) });
    }
    const snapshotItems = Array.isArray(activeProviders?.snapshot?.items)
      ? activeProviders.snapshot.items
      : [];
    for (const item of snapshotItems) {
      if (!item || item.provider !== targetEngine) continue;
      const itemCwd = item.cwd || item.workingDirectory || item.workspacePath;
      if (itemCwd) {
        pushCandidate(itemCwd, { isOpen: ['running', 'waiting', 'blocked'].includes(item.status) });
      }
    }

    // 2. Agent-specific opened & recent project discovery.
    const vscodeAppName = VSCODE_FORK_APP_NAMES[targetEngine];
    if (vscodeAppName) {
      this._collectVscodeForkWorkspaces(vscodeAppName, pushCandidate);
      if (targetEngine === 'qoder-cn') {
        this._collectQoderProjects(this._qoderCnProjectsDir, pushCandidate);
      } else if (targetEngine === 'qoder') {
        this._collectQoderProjects(this._qoderProjectsDir, pushCandidate);
      } else if (targetEngine === 'kiro') {
        this._collectKiroWorkspaceRoots(pushCandidate);
      } else if (targetEngine === 'copilot') {
        this._collectCopilotIdeWorkspaces(pushCandidate);
      }
    } else if (targetEngine === 'opencode') {
      const ocCols = getSqliteColumns(this._opencodeDbPath, 'project');
      if (ocCols.has('worktree')) {
        const rows = querySqliteJson(
          this._opencodeDbPath,
          'SELECT worktree, COALESCE(time_active, time_updated, time_created) AS ts FROM project ORDER BY ts DESC LIMIT 15;',
        );
        for (const row of rows) {
          if (row?.worktree) pushCandidate(row.worktree, { isOpen: false });
        }
      }
    } else if (targetEngine === 'antigravity') {
      this._collectAntigravityWorkspaces(pushCandidate);
    } else if (targetEngine === 'zcode') {
      const setting = readJsonSafe(path.join(this._zcodeDir, 'setting.json'));
      const recent = Array.isArray(setting?.recentProjects) ? setting.recentProjects : [];
      for (const item of recent) {
        const dir = typeof item === 'string' ? item : item?.path;
        if (dir) pushCandidate(dir, { isOpen: false });
      }
      const zcodeDb = path.join(this._zcodeDir, 'tasks-index.sqlite');
      const taskCols = getSqliteColumns(zcodeDb, 'tasks');
      if (taskCols.has('workspace_path')) {
        const rows = querySqliteJson(
          zcodeDb,
          'SELECT DISTINCT workspace_path, MAX(updated_at) AS ts FROM tasks WHERE workspace_path IS NOT NULL GROUP BY workspace_path ORDER BY ts DESC LIMIT 15;',
        );
        for (const row of rows) {
          if (row?.workspace_path) pushCandidate(row.workspace_path, { isOpen: false });
        }
      }
    } else if (targetEngine === 'workbuddy' || targetEngine === 'workbuddy-ai') {
      const dbPath = targetEngine === 'workbuddy-ai' ? this._workbuddyAiDbPath : this._workbuddyDbPath;
      this._collectWorkbuddyWorkspaces(dbPath, pushCandidate, () => ordered.length > 0);
    } else if (targetEngine === 'claude') {
      this._collectClaudeWorkspaces(pushCandidate);
    } else if (targetEngine === 'codex') {
      this._collectCodexWorkspaces(pushCandidate);
    } else if (targetEngine === 'dsh') {
      const dshItems = typeof activeProviders?.list === 'function'
        ? (activeProviders.list('dsh')?.items || [])
        : snapshotItems.filter(item => item?.provider === 'dsh');
      for (const item of dshItems) {
        const itemCwd = item?.cwd || item?.workingDirectory || item?.workspacePath;
        if (itemCwd) pushCandidate(itemCwd, { isOpen: false });
      }
      pushCandidate(this._defaultCwd(), { isOpen: false });
    }

    // Home/Root去杂: 仅当未发现任何真实项目目录时才回退到 homeDir / _defaultCwd() / process.cwd() / '/'.
    if (ordered.length === 0) {
      for (const root of deferredRoots) {
        if (root.real !== '/') {
          addEntry(ordered, byReal, root.real, root.isOpen);
        }
      }
    }
    if (ordered.length === 0) {
      pushCandidate(this._defaultCwd(), { isOpen: false, allowRoot: true });
      pushCandidate(process.cwd(), { isOpen: false, allowRoot: true });
    }
    if (ordered.length === 0) {
      for (const root of deferredRoots) {
        addEntry(ordered, byReal, root.real, root.isOpen);
      }
    }

    ordered.sort((a, b) => (a.isOpen === b.isOpen ? 0 : a.isOpen ? -1 : 1));

    const out = ordered.slice(0, MAX_DISCOVER_WORKSPACES).map(entry => ({
      path: entry.real,
      name: path.basename(entry.real) || entry.real,
      active: entry.real === activeReal,
      isOpen: Boolean(entry.isOpen),
      sourceEngine: targetEngine,
    }));

    if (includeExtra) {
      const extras = this.discoverExtraWorkspaces({ excludePaths: out.map(w => w.path) });
      for (const ex of extras) {
        out.push({
          ...ex,
          isOpen: false,
          sourceEngine: targetEngine,
        });
      }
    }

    return out;
  }

  _scanExtraWorkspaces() {
    const found = [];
    const seenProjects = new Set();
    const visitedAtDepth = new Map();
    let visitedEntries = 0;

    for (const rawRoot of this._extraScanRoots) {
      if (found.length >= MAX_EXTRA_CACHE_ITEMS || visitedEntries >= MAX_EXTRA_SCAN_ENTRIES) break;
      const rootReal = safeRealpath(rawRoot);
      if (!rootReal || !isExistingDirectory(rootReal)) continue;
      if (rootReal === '/Volumes' || rootReal.startsWith('/Volumes/')) continue;

      const queue = [{ dir: rootReal, depth: 0 }];
      while (queue.length > 0 && found.length < MAX_EXTRA_CACHE_ITEMS && visitedEntries < MAX_EXTRA_SCAN_ENTRIES) {
        const { dir, depth } = queue.shift();
        const prevDepth = visitedAtDepth.get(dir);
        if (prevDepth !== undefined && prevDepth <= depth) continue;
        visitedAtDepth.set(dir, depth);

        if (depth >= 1 && depth <= 3 && hasProjectMarker(dir)) {
          if (!seenProjects.has(dir)) {
            seenProjects.add(dir);
            found.push(dir);
          }
          continue;
        }

        if (depth >= 3) continue;

        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (visitedEntries >= MAX_EXTRA_SCAN_ENTRIES) break;
          visitedEntries += 1;
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.') || EXTRA_SKIP_DIRS.has(entry.name)) continue;
          const child = path.join(dir, entry.name);
          const childReal = safeRealpath(child);
          if (!childReal || childReal === '/Volumes' || childReal.startsWith('/Volumes/')) continue;
          queue.push({ dir: childReal, depth: depth + 1 });
        }
      }
    }

    return found;
  }

  discoverExtraWorkspaces({ excludePaths = [], forceScan = false } = {}) {
    const now = Date.now();
    let basePaths;
    if (!forceScan && this._extraCache && (now - this._extraCache.ts) < EXTRA_SCAN_CACHE_TTL_MS) {
      basePaths = this._extraCache.items;
    } else {
      basePaths = this._scanExtraWorkspaces();
      this._extraCache = { ts: now, items: basePaths };
    }

    const excludeSet = new Set();
    for (const p of Array.isArray(excludePaths) ? excludePaths : []) {
      const real = safeRealpath(p);
      if (real) excludeSet.add(real);
    }

    const activeReal = safeRealpath(this.currentCwd()) || this.currentCwd();
    const out = [];
    for (const projPath of basePaths) {
      if (out.length >= MAX_EXTRA_WORKSPACES) break;
      if (excludeSet.has(projPath) || !isExistingDirectory(projPath)) continue;
      out.push({
        path: projPath,
        name: path.basename(projPath) || projPath,
        active: projPath === activeReal,
        kind: 'extra',
      });
    }
    return out;
  }

  discoverSessions({ engine, cwd } = {}) {
    const eng = this._resolveTargetEngine(engine);
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

    const isSelectedSession = id =>
      id === this.selectedSessionId || (Boolean(selectedCliId) && id === selectedCliId);

    if (eng === 'codex') {
      const files = collectRecentJsonlFiles(this._codexSessionsDir, 4, 60);
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
          active: isSelectedSession(meta.cliSessionId),
        });
      }
    } else if (eng === 'claude') {
      const files = collectRecentJsonlFiles(this._claudeProjectsDir, 2, 60);
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
          active: isSelectedSession(meta.cliSessionId),
        });
      }
    } else if (eng === 'opencode') {
      const ocCols = getSqliteColumns(this._opencodeDbPath, 'session_v2');
      if (ocCols.has('id')) {
        const rows = querySqliteJson(
          this._opencodeDbPath,
          'SELECT id, directory, title, time_updated FROM session_v2 ORDER BY time_updated DESC LIMIT 20;',
        );
        for (const row of rows) {
          const id = row?.id ? String(row.id) : '';
          if (!id || seenCliIds.has(id)) continue;
          seenCliIds.add(id);
          const rowCwd = String(row.directory || '').trim();
          const normCwd = safeRealpath(rowCwd) || rowCwd;
          const base = rowCwd ? path.basename(rowCwd) : 'OpenCode';
          items.push({
            sessionId: id,
            cliSessionId: id,
            provider: 'opencode',
            cwd: rowCwd || this.currentCwd(),
            title: String(row.title || '').trim() || `${base || 'OpenCode'} · ${id.slice(0, 8)}`,
            updatedAt: Number(row.time_updated || 0),
            matchesCwd: Boolean(normFilterCwd && normCwd === normFilterCwd),
            active: isSelectedSession(id),
          });
        }
      }
    } else if (eng === 'zcode') {
      const zcodeDb = path.join(this._zcodeDir, 'tasks-index.sqlite');
      const taskCols = getSqliteColumns(zcodeDb, 'tasks');
      if (taskCols.has('task_id')) {
        const rows = querySqliteJson(
          zcodeDb,
          'SELECT task_id, workspace_path, title, updated_at FROM tasks WHERE deleted = 0 ORDER BY updated_at DESC LIMIT 20;',
        );
        for (const row of rows) {
          const id = row?.task_id ? String(row.task_id) : '';
          if (!id || seenCliIds.has(id)) continue;
          seenCliIds.add(id);
          const rowCwd = String(row.workspace_path || '').trim();
          const normCwd = safeRealpath(rowCwd) || rowCwd;
          const base = rowCwd ? path.basename(rowCwd) : 'ZCode';
          items.push({
            sessionId: id,
            cliSessionId: id,
            provider: 'zcode',
            cwd: rowCwd || this.currentCwd(),
            title: String(row.title || '').trim() || `${base || 'ZCode'} · ${id.slice(0, 8)}`,
            updatedAt: Number(row.updated_at || 0),
            matchesCwd: Boolean(normFilterCwd && normCwd === normFilterCwd),
            active: isSelectedSession(id),
          });
        }
      }
    } else if (eng === 'workbuddy' || eng === 'workbuddy-ai') {
      const dbPath = eng === 'workbuddy-ai' ? this._workbuddyAiDbPath : this._workbuddyDbPath;
      const cols = getSqliteColumns(dbPath, 'sessions');
      if (cols.has('id')) {
        const hasPlayground = cols.has('is_playground');
        const hasLastActivity = cols.has('last_activity_at');
        const hasDeleted = cols.has('deleted_at');
        const selectCols = ['id', 'cwd', 'title', 'updated_at'];
        if (hasLastActivity) selectCols.push('last_activity_at');
        if (hasPlayground) selectCols.push('is_playground');
        const deletedCond = hasDeleted ? 'deleted_at IS NULL' : '1=1';
        const orderExpr = hasLastActivity ? 'COALESCE(last_activity_at, updated_at) DESC' : 'updated_at DESC';

        const rows = [];
        if (hasPlayground) {
          rows.push(...querySqliteJson(
            dbPath,
            `SELECT ${selectCols.join(', ')} FROM sessions WHERE ${deletedCond} AND COALESCE(is_playground, 0) = 0 ORDER BY ${orderExpr} LIMIT 60;`,
          ));
          rows.push(...querySqliteJson(
            dbPath,
            `SELECT ${selectCols.join(', ')} FROM sessions WHERE ${deletedCond} ORDER BY ${orderExpr} LIMIT 80;`,
          ));
        } else {
          rows.push(...querySqliteJson(
            dbPath,
            `SELECT ${selectCols.join(', ')} FROM sessions WHERE ${deletedCond} ORDER BY ${orderExpr} LIMIT 20;`,
          ));
        }

        for (const row of rows) {
          const id = row?.id ? String(row.id) : '';
          if (!id || seenCliIds.has(id)) continue;
          seenCliIds.add(id);
          const rowCwd = String(row.cwd || '').trim();
          const normCwd = safeRealpath(rowCwd) || rowCwd;
          const label = getProviderLabel(eng);
          const base = rowCwd ? path.basename(rowCwd) : label;
          const isPg = hasPlayground
            ? Boolean(Number(row.is_playground || 0))
            : isWorkbuddyPlaygroundPath(rowCwd);
          items.push({
            sessionId: id,
            cliSessionId: id,
            provider: eng,
            cwd: rowCwd || this.currentCwd(),
            title: String(row.title || '').trim() || `${base || label} · ${id.slice(0, 8)}`,
            updatedAt: Number((hasLastActivity ? row.last_activity_at : null) || row.updated_at || 0),
            matchesCwd: Boolean(normFilterCwd && normCwd === normFilterCwd),
            active: isSelectedSession(id),
            _isPlayground: isPg,
          });
        }
      }
    } else if (eng === 'antigravity') {
      const cols = getSqliteColumns(this._antigravityDbPath, 'conversation_summaries');
      if (cols.has('conversation_id') && cols.has('workspace_uris') && cols.has('last_modified_time')) {
        const whereClause = cols.has('parent_conversation_id')
          ? "WHERE (parent_conversation_id IS NULL OR parent_conversation_id = '')"
          : '';
        const rows = querySqliteJson(
          this._antigravityDbPath,
          `SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries ${whereClause} ORDER BY last_modified_time DESC LIMIT 100;`,
        );
        for (const row of rows) {
          const id = row?.conversation_id ? String(row.conversation_id) : '';
          if (!id || seenCliIds.has(id)) continue;
          seenCliIds.add(id);
          const uris = parseWorkspaceUris(row.workspace_uris);
          const matched = normFilterCwd && uris.includes(normFilterCwd);
          const rowCwd = matched ? normFilterCwd : (uris[0] || '');
          const parsedTime = typeof row.last_modified_time === 'number'
            ? row.last_modified_time
            : (Date.parse(String(row.last_modified_time || '')) || 0);
          const base = rowCwd ? path.basename(rowCwd) : 'Antigravity';
          items.push({
            sessionId: id,
            cliSessionId: id,
            provider: 'antigravity',
            cwd: rowCwd || this.currentCwd(),
            title: String(row.title || '').trim() || `${base || 'Antigravity'} · ${id.slice(0, 8)}`,
            updatedAt: parsedTime,
            matchesCwd: Boolean(matched),
            active: isSelectedSession(id),
          });
        }
      }
    }

    items.sort((a, b) => {
      if (a.matchesCwd !== b.matchesCwd) return a.matchesCwd ? -1 : 1;
      if (Boolean(a._isPlayground) !== Boolean(b._isPlayground)) return a._isPlayground ? 1 : -1;
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    });

    return items.slice(0, MAX_DISCOVER_SESSIONS).map(({ _isPlayground, ...rest }) => rest);
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
    if (probes['workbuddy-ai']?.available) return 'workbuddy-ai';
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
      streamingText: '',
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
        cliSessionId: s.cliSessionId || null,
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
      const reqEng = String(body.targetAgent || body.engine || '').trim().toLowerCase();
      const targetAgent = (reqEng && reqEng !== 'auto') ? reqEng : this.resolveEngine(currentSource);
      const agentWorkspaces = this.discoverWorkspaces({ engine: targetAgent });
      const res = {
        currentCwd: this.currentCwd(),
        homeDir: safeRealpath(os.homedir()) || os.homedir(),
        suggestedCwd: agentWorkspaces[0]?.path || this.currentCwd(),
        targetAgent,
        workspaces: agentWorkspaces,
      };
      if (body.includeExtra) {
        res.extraWorkspaces = this.discoverExtraWorkspaces({
          excludePaths: agentWorkspaces.map(w => w.path),
          forceScan: Boolean(body.forceScan),
        });
      }
      return res;
    }

    if (action === 'selectWorkspace') {
      const resolvedCwd = this._validateOrResolveCwd(body.cwd, {
        allowUserSelection: true,
      });
      this.selectedCwd = resolvedCwd;
      this.selectedSessionId = null;
      const reqEng = String(body.targetAgent || body.engine || '').trim().toLowerCase();
      const eng = (reqEng && reqEng !== 'auto') ? reqEng : this.resolveEngine(currentSource);
      this.onUpdate?.({ type: 'workspace', currentCwd: this.selectedCwd });
      return {
        currentCwd: this.selectedCwd,
        targetAgent: eng,
        workspaces: this.discoverWorkspaces({ engine: eng }),
        sessions: this.discoverSessions({ engine: eng, cwd: this.selectedCwd }),
      };
    }

    if (action === 'sessions') {
      const reqEng = String(body.targetAgent || body.engine || '').trim().toLowerCase();
      const eng = (reqEng && reqEng !== 'auto') ? reqEng : this.resolveEngine(currentSource);
      const targetCwd = body.cwd || this.currentCwd();
      return {
        currentCwd: this.currentCwd(),
        targetAgent: eng,
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
      const eng = (reqEng && reqEng !== 'auto') ? reqEng : this.resolveEngine(currentSource);
      const session = this._createSession(eng);
      session.cliSessionId = String(body.cliSessionId || body.sessionId);
      if (typeof body.cwd === 'string' && body.cwd.trim()) {
        try {
          const validCwd = this._validateOrResolveCwd(body.cwd, { allowUserSelection: true });
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
      const files = listWorkspaceFiles(body.cwd || this.currentCwd(), body.query || '', MAX_LIST_FILES);
      return { files, candidates: files };
    }

    if (action === 'conversation') {
      const session = this._resolveSession(body.sessionId);
      if (!session) {
        throw new Error('未找到对应的本地会话');
      }
      session.unread = false;
      const messages = session.messages.map(m => ({ ...m }));
      if (session.status === 'running' && session.streamingText) {
        messages.push({
          id: `streaming:${session.sessionId}`,
          seq: session.lastSeq,
          role: 'assistant',
          text: session.streamingText,
          createdAt: session.updatedAt,
          streaming: true,
        });
      }
      return {
        sessionId: session.sessionId,
        title: session.title,
        status: session.status,
        detail: session.detail,
        lastSeq: session.lastSeq,
        messages,
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
      session.streamingText = '';
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
      session.streamingText = '';
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
          const liveDelta = typeof ev?.deltaText === 'string' ? ev.deltaText.trim() : '';
          if (ev?.tool) {
            session.detail = `正在使用 ${ev.tool}`;
            session.lastSeq += 1;
            session.updatedAt = Date.now();
            this.onUpdate?.({ type: 'chat', sessionId: session.sessionId, status: session.status });
          } else if (liveDelta) {
            session.streamingText = liveDelta;
            const singleLine = liveDelta.replace(/\s+/g, ' ').trim();
            session.detail = `💬 ${singleLine.length > 76 ? `…${singleLine.slice(-76)}` : singleLine}`;
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
          session.streamingText = '';
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
          session.streamingText = '';
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
  querySqliteJson,
  getSqliteColumns,
  isSyntheticInternalPath,
  parseFileUri,
};
