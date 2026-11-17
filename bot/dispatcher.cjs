'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn, spawnSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');

const BAD_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const ALLOWED_MIRROR_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'PermissionRequest',
  'PermissionDenied',
  'Stop',
  'StopFailure',
]);
const DISPATCH_SESSION_TTL = 24 * 60 * 60_000;
const MAX_JOBS_HISTORY = 200;
const DEFAULT_DSH_POLL_MS = 1200;
const DEFAULT_DSH_TIMEOUT_MS = 120_000;

function expandHome(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

function stripAnsi(str) {
  return String(str || '').replace(/\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '');
}

function cleanMeta(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  const valid = [];
  const seen = new Set();
  for (const raw of images) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const resolved = path.resolve(expandHome(raw));
    if (seen.has(resolved)) continue;
    try {
      if (fs.statSync(resolved).isFile()) {
        seen.add(resolved);
        valid.push(resolved);
      }
    } catch {}
  }
  return valid;
}

function isExecutableFile(filePath) {
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findBinary(name, explicitCandidates = []) {
  const home = os.homedir();
  const candidates = [];

  for (const item of explicitCandidates) {
    if (!item || typeof item !== 'string') continue;
    const expanded = expandHome(item);
    if (!expanded) continue;
    if (expanded.includes(path.sep) || expanded.includes('/')) {
      candidates.push(expanded);
    } else {
      const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
      for (const dir of pathEntries) {
        candidates.push(path.join(dir, expanded));
      }
    }
  }

  candidates.push(
    path.join(home, '.local', 'bin', name),
    path.join('/opt/homebrew/bin', name),
    path.join('/usr/local/bin', name),
  );

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    candidates.push(path.join(expandHome(dir), name));
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (isExecutableFile(resolved)) return resolved;
  }
  return null;
}

function sanitizeWorkspace(targetDir, allowedWorkspaces) {
  if (typeof targetDir !== 'string' || !targetDir.trim()) {
    throw new Error('工作目录不能为空');
  }
  const expandedTarget = expandHome(targetDir);
  const resolvedTarget = path.resolve(expandedTarget);

  let realTarget;
  try {
    realTarget = fs.realpathSync(resolvedTarget);
  } catch {
    throw new Error(`工作目录不存在: ${targetDir}`);
  }

  let stat;
  try {
    stat = fs.statSync(realTarget);
  } catch {
    throw new Error(`无法访问工作目录: ${targetDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`目标路径不是目录: ${targetDir}`);
  }

  const roots = Array.isArray(allowedWorkspaces) && allowedWorkspaces.length > 0
    ? allowedWorkspaces
    : [os.homedir()];

  const realRoots = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) continue;
    try {
      const realRoot = fs.realpathSync(path.resolve(expandHome(root)));
      if (fs.statSync(realRoot).isDirectory()) realRoots.push(realRoot);
    } catch {}
  }

  const allowed = realRoots.some(root => (
    realTarget === root ||
    realTarget.startsWith(root === path.sep ? root : root + path.sep)
  ));
  if (!allowed) {
    throw new Error(`工作目录不在允许的工作区白名单内: ${targetDir}`);
  }
  return realTarget;
}

function mirrorInboxEvent({
  dataDir,
  provider,
  sessionId,
  event,
  workspace,
  tool,
  toolId,
  notification,
  terminationReason,
  hasError,
  at,
} = {}) {
  if (!dataDir || typeof dataDir !== 'string') return null;
  if (typeof provider !== 'string' || !/^[a-z0-9-]+$/.test(provider) || BAD_IDS.has(provider)) {
    throw new Error(`无效的 provider: ${provider}`);
  }
  if (!ALLOWED_MIRROR_EVENTS.has(event)) {
    throw new Error(`不支持的镜像事件类型: ${event}`);
  }
  const cleanSession = cleanMeta(String(sessionId || ''), 256);
  if (!cleanSession || BAD_IDS.has(cleanSession)) {
    throw new Error('sessionId 无效');
  }

  const eventId = randomBytes(16).toString('hex');
  const payload = {
    v: 1,
    provider,
    sessionId: cleanSession,
    event,
    id: eventId,
    at: Number.isFinite(at) ? at : Date.now(),
  };

  if (typeof workspace === 'string' && workspace.trim()) {
    const cleanWs = cleanMeta(path.basename(workspace.trim().replace(/[/\\]+$/, '')), 64);
    if (cleanWs) payload.workspace = cleanWs;
  }
  if (typeof tool === 'string' && tool.trim()) {
    const cleanTool = cleanMeta(tool, 100);
    if (cleanTool) payload.tool = cleanTool;
  }
  if (typeof toolId === 'string' && toolId.trim()) {
    const cleanToolId = cleanMeta(toolId, 256);
    if (cleanToolId && !BAD_IDS.has(cleanToolId)) payload.toolId = cleanToolId;
  }
  if (typeof notification === 'string' && notification.trim()) {
    const cleanNote = cleanMeta(notification, 64);
    if (cleanNote) payload.notification = cleanNote;
  }
  if (typeof terminationReason === 'string' && terminationReason.trim()) {
    const cleanReason = cleanMeta(terminationReason, 64);
    if (cleanReason) payload.terminationReason = cleanReason;
  }
  if (hasError) payload.hasError = true;

  const inboxDir = path.join(dataDir, provider, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
  const finalPath = path.join(inboxDir, `${eventId}.json`);
  const tmpPath = path.join(inboxDir, `.${eventId}.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, finalPath);
  return { path: finalPath, event: payload };
}

function parseClaudeStreamLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return null;

  const sessionId = typeof obj.session_id === 'string' && obj.session_id.trim()
    ? obj.session_id.trim()
    : null;
  const tools = [];
  const toolResults = [];
  const textParts = [];

  const content = obj.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
        tools.push({
          name: block.name,
          id: typeof block.id === 'string' ? block.id : '',
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          isError: Boolean(block.is_error),
        });
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        textParts.push(block.text);
      }
    }
  } else if (typeof obj.delta?.text === 'string' && obj.delta.text) {
    textParts.push(obj.delta.text);
  }

  let resultText = '';
  if (obj.type === 'result') {
    if (typeof obj.result === 'string') {
      resultText = obj.result;
    } else if (Array.isArray(obj.errors)) {
      resultText = obj.errors.filter(e => typeof e === 'string').join('\n');
    }
  }

  let deltaText = '';
  let thinkingDelta = '';
  if (obj.type === 'stream_event' && obj.event && typeof obj.event === 'object') {
    const ev = obj.event;
    if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta === 'object') {
      if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
        deltaText = ev.delta.text;
      } else if (ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
        thinkingDelta = ev.delta.thinking;
      }
    }
  }

  const isError = Boolean(
    obj.is_error ||
    (obj.type === 'result' && typeof obj.subtype === 'string' && obj.subtype && obj.subtype !== 'success')
  );

  return {
    raw: obj,
    type: obj.type,
    subtype: typeof obj.subtype === 'string' ? obj.subtype : '',
    sessionId,
    tools,
    toolResults,
    text: obj.type === 'result' ? resultText : textParts.join('\n'),
    deltaText,
    thinkingDelta,
    isResult: obj.type === 'result',
    isError,
  };
}

function parseOpencodeJsonLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return null;

  const sessionId = typeof obj.sessionID === 'string' && obj.sessionID.trim()
    ? obj.sessionID.trim()
    : (typeof obj.sessionId === 'string' && obj.sessionId.trim() ? obj.sessionId.trim() : null);
  const part = obj.part && typeof obj.part === 'object' ? obj.part : null;
  const text = obj.type === 'text' && typeof part?.text === 'string'
    ? part.text
    : (typeof obj.text === 'string' ? obj.text : '');

  let tool = '';
  let toolId = '';
  let toolStatus = '';
  if ((obj.type === 'tool_use' || part?.type === 'tool' || part?.type === 'tool_use') && part) {
    tool = String(part.tool || part.name || '').trim();
    toolId = typeof part.callID === 'string' ? part.callID : (typeof part.id === 'string' ? part.id : '');
    toolStatus = typeof part.state?.status === 'string' ? part.state.status : '';
  }

  let errorMessage = '';
  if (obj.type === 'error') {
    errorMessage = obj.error?.data?.message || obj.error?.message || obj.message || 'OpenCode 发生错误';
  }

  return {
    raw: obj,
    type: obj.type,
    sessionId,
    text,
    tool,
    toolId,
    toolStatus,
    errorMessage: typeof errorMessage === 'string' ? errorMessage : '',
  };
}

function parseCodexJsonLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;

  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return null;

  const type = obj.type;
  const item = obj.item && typeof obj.item === 'object' ? obj.item : null;
  const sessionId = typeof obj.thread_id === 'string' && obj.thread_id.trim()
    ? obj.thread_id.trim()
    : null;

  let text = '';
  if (item && (item.type === 'agent_message' || item.type === 'message')) {
    if (typeof item.text === 'string') {
      text = item.text;
    } else if (Array.isArray(item.content)) {
      text = item.content
        .map(part => (typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n');
    }
  }

  let tool = '';
  let toolSummary = '';
  const toolId = item && typeof item.id === 'string' ? item.id : '';
  if (item && !['agent_message', 'message', 'reasoning'].includes(item.type)) {
    if (item.type === 'command_execution') {
      tool = 'command_execution';
      toolSummary = typeof item.command === 'string' && item.command.trim()
        ? `执行命令: ${item.command.trim().slice(0, 60)}`
        : '执行命令';
    } else if (item.type === 'file_change') {
      tool = 'file_change';
      const count = Array.isArray(item.changes) ? item.changes.length : 0;
      toolSummary = count > 0 ? `修改文件 (${count} 个)` : '修改文件';
    } else if (item.type === 'mcp_tool_call') {
      tool = String(item.tool || item.server || 'mcp_tool_call');
      toolSummary = `调用工具: ${tool}`;
    } else if (item.type === 'web_search') {
      tool = 'web_search';
      toolSummary = '网页搜索';
    } else if (typeof item.type === 'string' && item.type) {
      tool = item.type;
      toolSummary = `执行 ${item.type}`;
    }
  }

  let errorMessage = '';
  if (type === 'turn.failed') {
    errorMessage = obj.error?.message || 'Codex 执行失败';
  } else if (type === 'error') {
    errorMessage = obj.message || obj.error?.message || 'Codex 发生错误';
  }

  return {
    raw: obj,
    type,
    sessionId,
    itemType: typeof item?.type === 'string' ? item.type : '',
    text,
    tool,
    toolId,
    toolSummary,
    hasError: Boolean(
      errorMessage ||
      item?.status === 'failed' ||
      (typeof item?.exit_code === 'number' && item.exit_code !== 0)
    ),
    errorMessage,
  };
}

class TaskDispatcher {
  constructor({
    dataDir,
    providers,
    allowedWorkspaces,
    defaultCwd,
    sandboxMode,
    onMirrorEvent,
    dshPollIntervalMs,
    dshTimeoutMs,
  } = {}) {
    this.dataDir = dataDir || process.env.AGENT_PET_DATA || process.env.DSH_COMPANION_DATA || path.join(os.homedir(), '.dsh', 'companion');
    this.providers = providers || null;
    this.onMirrorEvent = typeof onMirrorEvent === 'function' ? onMirrorEvent : null;
    this.dshPollIntervalMs = Number.isFinite(dshPollIntervalMs) && dshPollIntervalMs > 0 ? dshPollIntervalMs : DEFAULT_DSH_POLL_MS;
    this.dshTimeoutMs = Number.isFinite(dshTimeoutMs) && dshTimeoutMs > 0 ? dshTimeoutMs : DEFAULT_DSH_TIMEOUT_MS;
    this.jobs = new Map();
    this.dispatchedSessionIds = new Set();
    this.dispatchedSessionTimestamps = new Map();
    this._pySdkCache = null;

    this.allowedWorkspaces = [os.homedir()];
    this.defaultCwd = os.homedir();
    this.sandboxMode = 'workspace-write';
    this.updateOptions({ allowedWorkspaces, defaultCwd, sandboxMode });
  }

  updateOptions({ allowedWorkspaces, defaultCwd, sandboxMode } = {}) {
    if (allowedWorkspaces !== undefined) {
      const cleaned = Array.isArray(allowedWorkspaces)
        ? allowedWorkspaces.map(w => String(w || '').trim()).filter(Boolean)
        : [];
      this.allowedWorkspaces = cleaned.length > 0 ? cleaned : [os.homedir()];
    }
    if (defaultCwd !== undefined) {
      const trimmed = typeof defaultCwd === 'string' ? defaultCwd.trim() : '';
      this.defaultCwd = trimmed ? expandHome(trimmed) : os.homedir();
    }
    if (sandboxMode !== undefined) {
      const mode = String(sandboxMode || '').trim();
      if (['workspace-write', 'auto', 'full', 'read-only'].includes(mode)) {
        this.sandboxMode = mode;
      }
    }
  }

  validateWorkspace(targetDir) {
    return sanitizeWorkspace(targetDir, this.allowedWorkspaces);
  }

  _probePythonAntigravity() {
    const pyBin = findBinary('python3', [process.env.PYTHON3_BIN, '/opt/homebrew/bin/python3', '/usr/bin/python3']);
    if (!pyBin) return null;

    const cacheKey = `${pyBin}:${process.env.PYTHONPATH || ''}`;
    if (this._pySdkCache && this._pySdkCache.key === cacheKey && Date.now() - this._pySdkCache.at < 15_000) {
      return this._pySdkCache.available ? pyBin : null;
    }

    let available = false;
    try {
      const res = spawnSync(pyBin, ['-c', 'import google.antigravity'], {
        timeout: 2500,
        stdio: 'ignore',
      });
      available = res.status === 0;
    } catch {
      available = false;
    }
    this._pySdkCache = { key: cacheKey, available, at: Date.now() };
    return available ? pyBin : null;
  }

  probeEngines() {
    const claudePath = findBinary('claude', [process.env.CLAUDE_BIN]);
    const codexPath = findBinary('codex', [process.env.CODEX_BIN]);
    const opencodePath = findBinary('opencode', [
      process.env.OPENCODE_BIN,
      '/Applications/OpenCode.app/Contents/Resources/opencode-cli',
    ]) || findBinary('opencode-cli', [process.env.OPENCODE_BIN]);
    const workbuddyAiCandidates = [
      process.env.WORKBUDDY_AI_BIN,
      '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    ].filter(Boolean);
    let workbuddyAiPath = null;
    for (const candidate of workbuddyAiCandidates) {
      const resolved = path.resolve(expandHome(candidate));
      if (isExecutableFile(resolved)) {
        workbuddyAiPath = resolved;
        break;
      }
    }
    const agyPath = findBinary('agy', [process.env.AGY_BIN]);

    let antigravity;
    if (agyPath) {
      antigravity = { available: true, mode: 'cli', path: agyPath, label: 'Antigravity' };
    } else {
      const pyBin = this._probePythonAntigravity();
      if (pyBin) {
        antigravity = { available: true, mode: 'python-sdk', path: pyBin, label: 'Antigravity' };
      } else {
        antigravity = {
          available: false,
          mode: 'gui-only',
          path: null,
          label: 'Antigravity',
          note: '本机仅检测到 Antigravity 桌面端（未安装 agy CLI 或 google-antigravity SDK），支持状态通知与打开应用',
        };
      }
    }

    const bridgeFile = this.dataDir ? path.join(this.dataDir, 'dsh-bridge.json') : '';
    const hasBridgeFile = Boolean(bridgeFile && fs.existsSync(bridgeFile));
    const dshConnected = Boolean(this.providers?.snapshot?.sources?.find(s => s.id === 'dsh')?.connected);
    const hasLegacy = Boolean(this.providers?.legacy?.endpoint && this.providers?.legacy?.token);
    const dshAvailable = Boolean(this.providers && (hasBridgeFile || dshConnected || hasLegacy));

    return {
      claude: {
        available: Boolean(claudePath),
        path: claudePath,
        label: 'Claude Code',
      },
      codex: {
        available: Boolean(codexPath),
        path: codexPath,
        label: 'Codex',
      },
      opencode: {
        available: Boolean(opencodePath),
        path: opencodePath,
        label: 'OpenCode',
      },
      'workbuddy-ai': {
        available: Boolean(workbuddyAiPath),
        path: workbuddyAiPath,
        label: 'WorkBuddy AI',
      },
      antigravity,
      dsh: {
        available: dshAvailable,
        path: hasBridgeFile ? bridgeFile : null,
        label: 'DSH',
        ...(dshAvailable ? {} : { note: '未检测到运行中的 DSH 桥接' }),
      },
    };
  }

  _markDispatched(provider, id) {
    const clean = cleanMeta(String(id || ''), 256);
    if (!clean) return;
    const now = Date.now();
    for (const [key, ts] of this.dispatchedSessionTimestamps.entries()) {
      if (now - ts > DISPATCH_SESSION_TTL) {
        this.dispatchedSessionTimestamps.delete(key);
        this.dispatchedSessionIds.delete(key);
      }
    }
    const keys = [clean, `${provider}:${clean}`];
    for (const key of keys) {
      this.dispatchedSessionIds.add(key);
      this.dispatchedSessionTimestamps.set(key, now);
    }
  }

  isDispatchedSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    if (this.dispatchedSessionIds.has(sessionId)) return true;
    const idx = sessionId.indexOf(':');
    if (idx > 0 && this.dispatchedSessionIds.has(sessionId.slice(idx + 1))) return true;
    return false;
  }

  _buildChildEnv(engine) {
    const home = os.homedir();
    const extraPath = [
      path.join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
    const currentPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const mergedPath = [...new Set([...extraPath, ...currentPath])].join(path.delimiter);
    const env = {
      ...process.env,
      PATH: mergedPath,
      AGENT_PET_DATA: this.dataDir,
    };
    if (engine === 'claude' || engine === 'workbuddy-ai') {
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
    }
    return env;
  }

  _createMirrorSession(provider, workspace, initialSessionId) {
    let lastAt = 0;
    let activeSessionId = initialSessionId || null;

    const nextAt = () => {
      const now = Date.now();
      lastAt = now > lastAt ? now : lastAt + 1;
      return lastAt;
    };

    const emit = (targetSessionId, event, extra = {}) => {
      if (!targetSessionId || !this.dataDir) return;
      try {
        const res = mirrorInboxEvent({
          dataDir: this.dataDir,
          provider,
          sessionId: targetSessionId,
          event,
          workspace,
          at: nextAt(),
          ...extra,
        });
        if (res?.event) this.onMirrorEvent?.(res.event);
      } catch {}
    };

    return {
      get sessionId() {
        return activeSessionId;
      },
      start(tempId) {
        activeSessionId = activeSessionId || tempId;
        emit(activeSessionId, 'SessionStart');
        emit(activeSessionId, 'UserPromptSubmit');
      },
      adoptSessionId(realId) {
        if (!realId || realId === activeSessionId) return;
        const previousId = activeSessionId;
        activeSessionId = realId;
        if (previousId) emit(previousId, 'SessionEnd');
        emit(activeSessionId, 'SessionStart');
        emit(activeSessionId, 'UserPromptSubmit');
      },
      emit(event, extra = {}) {
        emit(activeSessionId, event, extra);
      },
    };
  }

  _recordJob(job) {
    this.jobs.set(job.jobId, job);
    if (this.jobs.size > MAX_JOBS_HISTORY) {
      for (const [id, entry] of this.jobs.entries()) {
        if (this.jobs.size <= MAX_JOBS_HISTORY) break;
        if (entry.status !== 'running') this.jobs.delete(id);
      }
    }
  }

  async dispatch({ engine, prompt, cwd, sessionId, images, onProgress } = {}) {
    const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!cleanPrompt) throw new Error('任务内容不能为空');

    const rawEngine = String(engine || 'claude').trim().toLowerCase();
    const normalizedEngine = rawEngine === 'agy'
      ? 'antigravity'
      : (rawEngine === 'workbuddyai' ? 'workbuddy-ai' : rawEngine);
    if (!['claude', 'codex', 'opencode', 'workbuddy-ai', 'antigravity', 'dsh'].includes(normalizedEngine)) {
      throw new Error(`不支持的执行引擎: ${engine}`);
    }

    const validatedCwd = this.validateWorkspace(cwd || this.defaultCwd || os.homedir());
    const validImages = normalizeImages(images);
    const jobId = `job-${randomUUID().slice(0, 12)}`;
    const job = {
      jobId,
      engine: normalizedEngine,
      cwd: validatedCwd,
      promptPreview: cleanPrompt.replace(/\s+/g, ' ').slice(0, 80),
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null,
      images: validImages,
      error: null,
      toolsUsed: [],
      cancelled: false,
      child: null,
      abortController: new AbortController(),
    };
    this._recordJob(job);
    this._markDispatched(normalizedEngine, jobId);
    if (job.sessionId) this._markDispatched(normalizedEngine, job.sessionId);

    try {
      switch (normalizedEngine) {
        case 'claude':
          return await this._dispatchClaude(job, cleanPrompt, onProgress);
        case 'codex':
          return await this._dispatchCodex(job, cleanPrompt, onProgress);
        case 'opencode':
          return await this._dispatchOpencode(job, cleanPrompt, onProgress);
        case 'workbuddy-ai':
          return await this._dispatchWorkbuddyAi(job, cleanPrompt, onProgress);
        case 'antigravity':
          return await this._dispatchAntigravity(job, cleanPrompt, onProgress);
        case 'dsh':
          return await this._dispatchDsh(job, cleanPrompt, onProgress);
      }
    } catch (err) {
      if (!job.cancelled) {
        job.status = 'failed';
        job.endedAt = Date.now();
        job.error = err.message;
      }
      throw err;
    }
  }

  _dispatchClaude(job, prompt, onProgress) {
    const probes = this.probeEngines();
    const bin = probes.claude?.path;
    if (!bin) {
      throw new Error('未检测到 claude CLI，请先安装 Claude Code 或设置 CLAUDE_BIN');
    }
    return this._dispatchStreamJsonCli(job, prompt, onProgress, {
      engine: 'claude',
      label: 'Claude Code',
      bin,
    });
  }

  _dispatchWorkbuddyAi(job, prompt, onProgress) {
    const probes = this.probeEngines();
    const bin = probes['workbuddy-ai']?.path;
    if (!bin) {
      throw new Error('未检测到 WorkBuddy AI CLI，请确认已安装 WorkBuddy AI.app 或设置 WORKBUDDY_AI_BIN');
    }
    return this._dispatchStreamJsonCli(job, prompt, onProgress, {
      engine: 'workbuddy-ai',
      label: 'WorkBuddy AI',
      bin,
    });
  }

  _dispatchStreamJsonCli(job, prompt, onProgress, { engine, label, bin }) {
    const images = Array.isArray(job.images) ? job.images : [];
    const effectivePrompt = images.length > 0
      ? `[附加图片路径: ${images.join(', ')} — 请先读取查看图片内容]\n${prompt}`
      : prompt;
    const args = ['-p', effectivePrompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (job.sessionId) args.push('--resume', job.sessionId);
    const addedDirs = new Set();
    for (const imgPath of images) {
      const dir = path.dirname(imgPath);
      if (!addedDirs.has(dir)) {
        addedDirs.add(dir);
        args.push('--add-dir', dir);
      }
    }
    if (this.sandboxMode === 'auto') args.push('--permission-mode', 'acceptEdits');
    else if (this.sandboxMode === 'full') args.push('--dangerously-skip-permissions');

    const mirror = this._createMirrorSession(engine, job.cwd, job.sessionId);
    mirror.start(job.jobId);

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let partialText = '';
      let lastAssistantText = '';
      let finalResultText = '';
      let resultIsError = false;
      const toolsSet = new Set();

      const child = spawn(bin, args, {
        cwd: job.cwd,
        env: this._buildChildEnv(engine),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      job.child = child;
      child.stdin?.end();

      const handleLine = line => {
        const parsed = parseClaudeStreamLine(line);
        if (!parsed) return;

        if (parsed.sessionId && parsed.sessionId !== job.sessionId) {
          job.sessionId = parsed.sessionId;
          this._markDispatched(engine, parsed.sessionId);
          mirror.adoptSessionId(parsed.sessionId);
        }

        if (parsed.deltaText) {
          partialText += parsed.deltaText;
          try {
            onProgress?.({ type: 'delta', deltaText: partialText });
          } catch {}
        }

        for (const t of parsed.tools) {
          if (!toolsSet.has(t.name)) {
            toolsSet.add(t.name);
            job.toolsUsed.push(t.name);
          }
          mirror.emit('PreToolUse', { tool: t.name, toolId: t.id || t.name });
          try {
            onProgress?.({ type: 'tool', tool: t.name, text: `🔧 正在使用 ${t.name}` });
          } catch {}
        }

        for (const tr of parsed.toolResults) {
          mirror.emit(tr.isError ? 'PostToolUseFailure' : 'PostToolUse', {
            toolId: tr.id || 'tool',
            hasError: tr.isError,
          });
        }

        if (parsed.isResult) {
          finalResultText = parsed.text || lastAssistantText || partialText;
          resultIsError = parsed.isError;
          partialText = '';
        } else if (parsed.text) {
          lastAssistantText = parsed.text;
          partialText = '';
          const preview = cleanMeta(parsed.text, 120);
          if (preview) {
            try {
              onProgress?.({ type: 'text', text: `💬 ${preview}`, deltaText: parsed.text });
            } catch {}
          }
        }
      };

      child.stdout.on('data', chunk => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });

      child.stderr.on('data', chunk => {
        if (stderrBuf.length < 16384) stderrBuf += chunk.toString('utf8');
      });

      child.on('error', err => {
        if (settled) return;
        settled = true;
        job.child = null;
        job.endedAt = Date.now();
        if (job.cancelled) {
          job.status = 'cancelled';
          mirror.emit('Stop', { terminationReason: 'USER_CANCELED' });
          resolve({
            jobId: job.jobId,
            engine,
            status: 'cancelled',
            sessionId: job.sessionId,
            text: lastAssistantText || partialText || '任务已取消',
            toolsUsed: [...job.toolsUsed],
          });
          return;
        }
        job.status = 'failed';
        job.error = err.message;
        mirror.emit('StopFailure', { hasError: true });
        reject(err);
      });

      child.on('close', code => {
        if (stdoutBuf.trim()) handleLine(stdoutBuf);
        stdoutBuf = '';
        if (settled) return;
        settled = true;
        job.child = null;
        job.endedAt = Date.now();

        const outputText = (finalResultText || lastAssistantText || partialText).trim();
        if (job.cancelled) {
          job.status = 'cancelled';
          mirror.emit('Stop', { terminationReason: 'USER_CANCELED' });
          resolve({
            jobId: job.jobId,
            engine,
            status: 'cancelled',
            sessionId: job.sessionId,
            text: outputText || '任务已取消',
            toolsUsed: [...job.toolsUsed],
          });
          return;
        }

        if (code === 0 && !resultIsError) {
          job.status = 'completed';
          mirror.emit('Stop');
          resolve({
            jobId: job.jobId,
            engine,
            status: 'completed',
            sessionId: job.sessionId,
            text: outputText,
            toolsUsed: [...job.toolsUsed],
          });
          return;
        }

        const errMsg = (resultIsError ? outputText : '') || stderrBuf.trim() || `${label} 退出码 ${code}`;
        job.status = 'failed';
        job.error = errMsg;
        mirror.emit('StopFailure', { hasError: true });
        resolve({
          jobId: job.jobId,
          engine,
          status: 'failed',
          sessionId: job.sessionId,
          text: outputText,
          error: errMsg,
          toolsUsed: [...job.toolsUsed],
        });
      });
    });
  }

  _dispatchCodex(job, prompt, onProgress) {
    const probes = this.probeEngines();
    const bin = probes.codex.path;
    if (!bin) {
      throw new Error('未检测到 codex CLI，请先安装 Codex 或设置 CODEX_BIN');
    }

    const images = Array.isArray(job.images) ? job.images : [];
    let args;
    if (job.sessionId) {
      // `codex exec resume` rejects `-C` and `-s`, so use process cwd + `--full-auto`.
      args = ['exec', 'resume', '--json', '--skip-git-repo-check'];
      if (this.sandboxMode === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
      else args.push('--full-auto');
      for (const imgPath of images) {
        args.push('-i', imgPath);
      }
      args.push(job.sessionId, prompt);
    } else {
      args = ['exec', '--json', '-C', job.cwd, '--skip-git-repo-check'];
      if (this.sandboxMode === 'full') {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      } else if (this.sandboxMode === 'auto') {
        args.push('--full-auto');
      } else if (this.sandboxMode === 'read-only') {
        args.push('-s', 'read-only');
      } else {
        args.push('-s', 'workspace-write', '--full-auto');
      }
      for (const imgPath of images) {
        args.push('-i', imgPath);
      }
      args.push(prompt);
    }

    const mirror = this._createMirrorSession('codex', job.cwd, job.sessionId);
    mirror.start(job.jobId);

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let lastAgentMessage = '';
      let turnError = '';
      const toolsSet = new Set();

      const child = spawn(bin, args, {
        cwd: job.cwd,
        env: this._buildChildEnv('codex'),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      job.child = child;
      child.stdin?.end();

      const handleLine = line => {
        const parsed = parseCodexJsonLine(line);
        if (!parsed) return;

        if (parsed.type === 'thread.started' && parsed.sessionId) {
          job.sessionId = parsed.sessionId;
          this._markDispatched('codex', parsed.sessionId);
          mirror.adoptSessionId(parsed.sessionId);
          return;
        }

        if (parsed.type === 'item.started' && parsed.tool) {
          if (!toolsSet.has(parsed.tool)) {
            toolsSet.add(parsed.tool);
            job.toolsUsed.push(parsed.tool);
          }
          mirror.emit('PreToolUse', { tool: parsed.tool, toolId: parsed.toolId || parsed.tool });
          try {
            onProgress?.({ type: 'tool', tool: parsed.tool, text: `🔧 ${parsed.toolSummary || parsed.tool}` });
          } catch {}
          return;
        }

        if (parsed.type === 'item.updated' && (parsed.itemType === 'agent_message' || parsed.itemType === 'message') && parsed.text) {
          lastAgentMessage = parsed.text;
          try {
            onProgress?.({ type: 'delta', deltaText: parsed.text });
          } catch {}
          return;
        }

        if (parsed.type === 'item.completed') {
          if (parsed.itemType === 'agent_message' || parsed.itemType === 'message') {
            if (parsed.text) {
              lastAgentMessage = parsed.text;
              const preview = cleanMeta(parsed.text, 120);
              if (preview) {
                try {
                  onProgress?.({ type: 'text', text: `💬 ${preview}`, deltaText: parsed.text });
                } catch {}
              }
            }
          } else if (parsed.tool) {
            if (!toolsSet.has(parsed.tool)) {
              toolsSet.add(parsed.tool);
              job.toolsUsed.push(parsed.tool);
            }
            mirror.emit(parsed.hasError ? 'PostToolUseFailure' : 'PostToolUse', {
              tool: parsed.tool,
              toolId: parsed.toolId || parsed.tool,
              hasError: parsed.hasError,
            });
          }
          return;
        }

        if (parsed.type === 'turn.failed' || parsed.type === 'error') {
          if (parsed.errorMessage) turnError = parsed.errorMessage;
        }
      };

      child.stdout.on('data', chunk => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });

      child.stderr.on('data', chunk => {
        if (stderrBuf.length < 16384) stderrBuf += chunk.toString('utf8');
      });

      child.on('error', err => {
        if (settled) return;
        settled = true;
        job.child = null;
        job.endedAt = Date.now();
        if (job.cancelled) {
          job.status = 'cancelled';
          mirror.emit('Stop', { terminationReason: 'USER_CANCELED' });
          resolve({
            jobId: job.jobId,
            engine: 'codex',
            status: 'cancelled',
            sessionId: job.sessionId,
            text: lastAgentMessage || '任务已取消',
            toolsUsed: [...job.toolsUsed],
          });
          return;
        }
        job.status = 'failed';
        job.error = err.message;
        mirror.emit('StopFailure', { hasError: true });
        reject(err);
      });

      child.on('close', code => {
        if (stdoutBuf.trim()) handleLine(stdoutBuf);
        stdoutBuf = '';
        if (settled) return;
        settled = true;
        job.child = null;
        job.endedAt = Date.now();

        const outputText = lastAgentMessage.trim();
        if (job.cancelled) {
          job.status = 'cancelled';
          mirror.emit('Stop', { terminationReason: 'USER_CANCELED' });
          resolve({
            jobId: job.jobId,
            engine: 'codex',
            status: 'cancelled',
            sessionId: job.sessionId,
            text: outputText || '任务已取消',
            toolsUsed: [...job.toolsUsed],
          });
          return;
        }

        if (code === 0 && !turnError) {
          job.status = 'completed';
          mirror.emit('Stop');
          resolve({
            jobId: job.jobId,
            engine: 'codex',
            status: 'completed',
            sessionId: job.sessionId,
            text: outputText,
            toolsUsed: [...job.toolsUsed],
          });
          return;
        }

        const errMsg = turnError || stderrBuf.trim() || `Codex 退出码 ${code}`;
        job.status = 'failed';
        job.error = errMsg;
        mirror.emit('StopFailure', { hasError: true });
        resolve({
          jobId: job.jobId,
          engine: 'codex',
          status: 'failed',
          sessionId: job.sessionId,
          text: outputText,
          error: errMsg,
          toolsUsed: [...job.toolsUsed],
        });
      });
    });
  }

  _dispatchOpencode(job, prompt, onProgress) {
    const probes = this.probeEngines();
    const bin = probes.opencode?.path;
    if (!bin) {
      throw new Error('未检测到 opencode CLI，请先安装 OpenCode 或设置 OPENCODE_BIN');
    }

    const args = ['run', '--auto', '--format', 'json'];
    if (job.sessionId) args.push('-s', job.sessionId);
    const images = Array.isArray(job.images) ? job.images : [];
    for (const imgPath of images) {
      args.push('-f', imgPath);
    }
    args.push(prompt);

    const mirror = this._createMirrorSession('opencode', job.cwd, job.sessionId);
    mirror.start(job.jobId);

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdoutBuf = '';
      let jsonText = '';
      let plainStdout = '';
      let stderrText = '';
      let turnError = '';
      const toolsSet = new Set();

      const child = spawn(bin, args, {
        cwd: job.cwd,
        env: this._buildChildEnv('opencode'),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      job.child = child;
      child.stdin?.end();

      const handleLine = rawLine => {
        const parsed = parseOpencodeJsonLine(rawLine);
        if (!parsed) {
          const cleanLine = stripAnsi(rawLine);
          if (cleanLine.trim()) {
            plainStdout += (plainStdout ? '\n' : '') + cleanLine;
            const preview = cleanMeta(cleanLine, 120);
            if (preview) {
              try {
                onProgress?.({ type: 'text', text: `💬 ${preview}`, deltaText: plainStdout });
              } catch {}
            }
          }
          return;
        }

        if (parsed.sessionId && parsed.sessionId !== job.sessionId) {
          job.sessionId = parsed.sessionId;
          this._markDispatched('opencode', parsed.sessionId);
          mirror.adoptSessionId(parsed.sessionId);
        }

        if (parsed.tool) {
          if (!toolsSet.has(parsed.tool)) {
            toolsSet.add(parsed.tool);
            job.toolsUsed.push(parsed.tool);
          }
          if (parsed.toolStatus === 'completed' || parsed.toolStatus === 'error') {
            mirror.emit(parsed.toolStatus === 'error' ? 'PostToolUseFailure' : 'PostToolUse', {
              tool: parsed.tool,
              toolId: parsed.toolId || parsed.tool,
              hasError: parsed.toolStatus === 'error',
            });
          } else {
            mirror.emit('PreToolUse', { tool: parsed.tool, toolId: parsed.toolId || parsed.tool });
            try {
              onProgress?.({ type: 'tool', tool: parsed.tool, text: `🔧 正在使用 ${parsed.tool}` });
            } catch {}
          }
        }

        if (parsed.text) {
          jsonText = jsonText ? `${jsonText}\n${parsed.text}` : parsed.text;
          const preview = cleanMeta(parsed.text, 120);
          try {
            onProgress?.({ type: 'text', text: `💬 ${preview}`, deltaText: jsonText });
          } catch {}
        }

        if (parsed.errorMessage) {
          turnError = parsed.errorMessage;
        }
      };

      child.stdout.on('data', chunk => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });

      child.stderr.on('data', chunk => {
        if (stderrText.length < 16384) stderrText += chunk.toString('utf8');
      });

      child.on('error', err => {
        if (settled) return;
        settled = true;
        job.child = null;
        job.endedAt = Date.now();
        const fallbackText = (jsonText || plainStdout).trim();
        if (job.cancelled) {
          job.status = 'cancelled';
          mirror.emit('Stop', { terminationReason: 'USER_CANCELED' });
          resolve({
            jobId: job.jobId,
            engine: 'opencode',
            status: 'cancelled',
            sessionId: job.sessionId || (`opencode-${job.jobId}`),
            text: fallbackText || '任务已取消',
            toolsUsed: [...job.toolsUsed],
          });
          return;
        }
        job.status = 'failed';
        job.error = err.message;
        mirror.emit('StopFailure', { hasError: true });
        reject(err);
      });

      child.on('close', code => {
        if (stdoutBuf.trim()) handleLine(stdoutBuf);
        stdoutBuf = '';
        if (settled) return;
        settled = true;
        job.child = null;
        job.endedAt = Date.now();

        const output = (jsonText || plainStdout).trim();
        const finalSessionId = job.sessionId || (`opencode-${job.jobId}`);
        if (job.cancelled) {
          job.status = 'cancelled';
          mirror.emit('Stop', { terminationReason: 'USER_CANCELED' });
          resolve({
            jobId: job.jobId,
            engine: 'opencode',
            status: 'cancelled',
            sessionId: finalSessionId,
            text: output || '任务已取消',
            toolsUsed: [...job.toolsUsed],
          });
          return;
        }

        if (code === 0 && !turnError) {
          job.sessionId = finalSessionId;
          this._markDispatched('opencode', finalSessionId);
          job.status = 'completed';
          mirror.emit('Stop');
          resolve({
            jobId: job.jobId,
            engine: 'opencode',
            status: 'completed',
            sessionId: finalSessionId,
            text: output || '已完成任务',
            toolsUsed: [...job.toolsUsed],
          });
          return;
        }

        const errMsg = turnError || stripAnsi(stderrText).trim() || output || `OpenCode 退出码 ${code}`;
        job.status = 'failed';
        job.error = errMsg;
        mirror.emit('StopFailure', { hasError: true });
        resolve({
          jobId: job.jobId,
          engine: 'opencode',
          status: 'failed',
          sessionId: finalSessionId,
          text: output,
          error: errMsg,
          toolsUsed: [...job.toolsUsed],
        });
      });
    });
  }

  _dispatchAntigravity(job, prompt, onProgress) {
    const probes = this.probeEngines();
    const info = probes.antigravity;
    if (!info.available) {
      throw new Error('当前未检测到 Antigravity CLI (agy) 或 Python SDK，仅支持桌面端状态监听与 /open antigravity 打开应用；直接派活请使用 @claude、@codex 或 @dsh');
    }

    const mirror = this._createMirrorSession('antigravity', job.cwd, job.sessionId);
    mirror.start(job.jobId);

    let bin;
    let args;
    let stdinText = null;

    const images = Array.isArray(job.images) ? job.images : [];
    const effectivePrompt = images.length > 0
      ? `[附加图片路径: ${images.join(', ')}]\n${prompt}`
      : prompt;

    if (info.mode === 'cli') {
      bin = info.path;
      args = job.sessionId ? ['-p', effectivePrompt, '--resume', job.sessionId] : ['-p', effectivePrompt];
    } else {
      bin = info.path;
      const pyScript = [
        'import asyncio, os, sys',
        'from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig',
        'async def main():',
        '    prompt = sys.stdin.read()',
        `    cfg = LocalAgentConfig(${this.sandboxMode === 'read-only' ? '' : 'capabilities=CapabilitiesConfig()'})`,
        '    async with Agent(cfg) as agent:',
        '        resp = await agent.chat(prompt)',
        '        async for token in resp:',
        '            sys.stdout.write(token)',
        '            sys.stdout.flush()',
        'asyncio.run(main())',
      ].join('\n');
      args = ['-c', pyScript];
      stdinText = effectivePrompt;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let stdoutText = '';
      let stderrText = '';

      const child = spawn(bin, args, {
        cwd: job.cwd,
        env: this._buildChildEnv('antigravity'),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      job.child = child;
      if (stdinText !== null) child.stdin?.end(stdinText);
      else child.stdin?.end();

      child.stdout.on('data', chunk => {
        const piece = chunk.toString('utf8');
        stdoutText += piece;
        const preview = cleanMeta(piece, 120);
        if (preview) {
          try {
            onProgress?.({ type: 'text', text: `💬 ${preview}` });
          } catch {}
        }
      });

      child.stderr.on('data', chunk => {
        if (stderrText.length < 16384) stderrText += chunk.toString('utf8');
      });

      child.on('error', err => {
        if (settled) return;
        settled = true;
        job.child = null;
        job.endedAt = Date.now();
        if (job.cancelled) {
          job.status = 'cancelled';
          mirror.emit('Stop', { terminationReason: 'USER_CANCELED' });
          resolve({
            jobId: job.jobId,
            engine: 'antigravity',
            status: 'cancelled',
            sessionId: job.sessionId,
            text: stdoutText.trim() || '任务已取消',
            toolsUsed: [],
          });
          return;
        }
        job.status = 'failed';
        job.error = err.message;
        mirror.emit('StopFailure', { hasError: true });
        reject(err);
      });

      child.on('close', code => {
        if (settled) return;
        settled = true;
        job.child = null;
        job.endedAt = Date.now();

        const outputText = stdoutText.trim();
        if (job.cancelled) {
          job.status = 'cancelled';
          mirror.emit('Stop', { terminationReason: 'USER_CANCELED' });
          resolve({
            jobId: job.jobId,
            engine: 'antigravity',
            status: 'cancelled',
            sessionId: job.sessionId,
            text: outputText || '任务已取消',
            toolsUsed: [],
          });
          return;
        }

        if (code === 0) {
          job.status = 'completed';
          mirror.emit('Stop');
          resolve({
            jobId: job.jobId,
            engine: 'antigravity',
            status: 'completed',
            sessionId: job.sessionId,
            text: outputText,
            toolsUsed: [],
          });
          return;
        }

        const errMsg = stderrText.trim() || `Antigravity 退出码 ${code}`;
        job.status = 'failed';
        job.error = errMsg;
        mirror.emit('StopFailure', { hasError: true });
        resolve({
          jobId: job.jobId,
          engine: 'antigravity',
          status: 'failed',
          sessionId: job.sessionId,
          text: outputText,
          error: errMsg,
          toolsUsed: [],
        });
      });
    });
  }

  async _dispatchDsh(job, prompt, onProgress) {
    if (!this.providers || typeof this.providers.dsh !== 'function') {
      throw new Error('DSH 桥接不可用，请确认 DSH 正在运行');
    }

    let activeSessionId = job.sessionId;
    let baselineSeq = -1;
    let baselineAssistantCount = 0;

    if (activeSessionId) {
      const baselineConv = await this.providers.dsh({ action: 'conversation', sessionId: activeSessionId }).catch(() => null);
      if (baselineConv) {
        if (Number.isFinite(baselineConv.lastSeq)) baselineSeq = baselineConv.lastSeq;
        if (Array.isArray(baselineConv.messages)) {
          baselineAssistantCount = baselineConv.messages.filter(m => m.role === 'assistant').length;
        }
      }
      await this.providers.dsh({
        action: 'prompt',
        sessionId: activeSessionId,
        requestId: randomUUID(),
        content: [{ type: 'text', text: prompt }],
        text: prompt,
      });
    } else {
      const candidateId = `session-${randomUUID()}`;
      const created = await this.providers.dsh({
        action: 'create',
        sessionId: candidateId,
        text: prompt,
        cwd: job.cwd,
      });
      activeSessionId = created?.sessionId || created?.id || candidateId;
      job.sessionId = activeSessionId;
      this._markDispatched('dsh', activeSessionId);

      // Real DSH `create` yields an idle empty session and requires an explicit `prompt` RPC;
      // a test mock that handles `text` inside `create` will already reflect non-idle or messages.
      const probeConv = await this.providers.dsh({ action: 'conversation', sessionId: activeSessionId }).catch(() => null);
      const alreadySubmitted = Boolean(
        created?.promptAccepted ||
        created?.started ||
        (probeConv && (probeConv.status !== 'idle' || (Array.isArray(probeConv.messages) && probeConv.messages.length > 0)))
      );
      if (!alreadySubmitted) {
        await this.providers.dsh({
          action: 'prompt',
          sessionId: activeSessionId,
          requestId: randomUUID(),
          content: [{ type: 'text', text: prompt }],
          text: prompt,
        });
      }
    }

    job.sessionId = activeSessionId;
    this._markDispatched('dsh', activeSessionId);

    const deadline = Date.now() + this.dshTimeoutMs;
    let lastDetail = '';
    let sawRunning = false;

    const sleepAbortable = ms => new Promise(resolve => {
      if (job.cancelled || job.abortController.signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        job.abortController.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      job.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });

    while (Date.now() < deadline) {
      if (job.cancelled) {
        job.status = 'cancelled';
        job.endedAt = Date.now();
        return {
          jobId: job.jobId,
          engine: 'dsh',
          status: 'cancelled',
          sessionId: activeSessionId,
          text: '任务已取消',
          toolsUsed: [],
        };
      }

      const [listRes, conv] = await Promise.all([
        this.providers.dsh({ action: 'list' }).catch(() => null),
        this.providers.dsh({ action: 'conversation', sessionId: activeSessionId }).catch(() => null),
      ]);

      if (job.cancelled) continue;

      const listItem = Array.isArray(listRes?.items)
        ? listRes.items.find(row => row.sessionId === activeSessionId || row.sessionId === `dsh:${activeSessionId}`)
        : null;

      const status = conv?.status || listItem?.status || '';
      const detail = conv?.detail || listItem?.detail || '';
      if (status === 'running') sawRunning = true;

      if (detail && detail !== lastDetail && ['running', 'waiting'].includes(status)) {
        lastDetail = detail;
        try {
          onProgress?.({ type: 'status', text: status === 'waiting' ? `⏳ ${detail}` : detail });
        } catch {}
      }

      const assistantMsgs = Array.isArray(conv?.messages)
        ? conv.messages.filter(m => m.role === 'assistant' && typeof m.text === 'string' && m.text.trim())
        : [];
      const hasNewReply = assistantMsgs.length > baselineAssistantCount ||
        (Number.isFinite(conv?.lastSeq) && conv.lastSeq > baselineSeq && assistantMsgs.length > 0);

      if (status === 'ready' || status === 'completed' || (!status && hasNewReply)) {
        if (hasNewReply || sawRunning || baselineSeq < 0) {
          const replyText = assistantMsgs.length
            ? assistantMsgs[assistantMsgs.length - 1].text
            : (typeof conv?.text === 'string' ? conv.text : (typeof conv?.reply === 'string' ? conv.reply : ''));
          job.status = 'completed';
          job.endedAt = Date.now();
          return {
            jobId: job.jobId,
            engine: 'dsh',
            status: 'completed',
            sessionId: activeSessionId,
            text: (replyText || detail || '本轮已完成').trim(),
            toolsUsed: [],
          };
        }
      }

      if (status === 'blocked' || status === 'failed') {
        const errMsg = detail || 'DSH 执行受阻';
        job.status = 'failed';
        job.endedAt = Date.now();
        job.error = errMsg;
        return {
          jobId: job.jobId,
          engine: 'dsh',
          status: 'failed',
          sessionId: activeSessionId,
          text: '',
          error: errMsg,
          toolsUsed: [],
        };
      }

      if (status === 'cancelled' || status === 'aborted') {
        job.status = 'cancelled';
        job.endedAt = Date.now();
        return {
          jobId: job.jobId,
          engine: 'dsh',
          status: 'cancelled',
          sessionId: activeSessionId,
          text: '任务已取消',
          toolsUsed: [],
        };
      }

      await sleepAbortable(this.dshPollIntervalMs);
    }

    job.status = 'failed';
    job.endedAt = Date.now();
    job.error = '等待 DSH 回复超时';
    return {
      jobId: job.jobId,
      engine: 'dsh',
      status: 'failed',
      sessionId: activeSessionId,
      text: '',
      error: '等待 DSH 回复超时，请在桌面端查看该会话',
      toolsUsed: [],
    };
  }

  async stopJob(jobId) {
    let target = null;
    if (jobId) {
      const candidate = this.jobs.get(jobId);
      if (!candidate || candidate.status !== 'running') {
        return { stopped: false, reason: '未找到运行中的任务', jobId };
      }
      target = candidate;
    } else {
      const reversed = [...this.jobs.values()].reverse();
      target = reversed.find(j => j.status === 'running') || null;
      if (!target) {
        return { stopped: false, reason: '当前没有运行中的任务' };
      }
    }

    target.cancelled = true;
    target.status = 'cancelled';
    target.endedAt = Date.now();
    target.abortController?.abort();

    if (target.child) {
      const child = target.child;
      try { child.kill('SIGTERM'); } catch {}
      const killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        } catch {}
      }, 3000);
      killTimer.unref?.();
    }

    if (target.engine === 'dsh' && target.sessionId && this.providers) {
      await this.providers.dsh({ action: 'cancel', sessionId: target.sessionId }).catch(() => {});
    }

    return {
      stopped: true,
      jobId: target.jobId,
      engine: target.engine,
      sessionId: target.sessionId || null,
    };
  }

  _runGit(validatedCwd, args, { allowFail = false, timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd: validatedCwd,
          env: this._buildChildEnv('git'),
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        },
        (err, stdout = '', stderr = '') => {
          if (err) {
            const msg = String(stderr || err.message || '').trim();
            if (allowFail) {
              resolve({ ok: false, stdout: String(stdout), stderr: msg });
              return;
            }
            if (/not a git repository/i.test(msg)) {
              reject(new Error(`当前目录不是 Git 仓库: ${validatedCwd}`));
              return;
            }
            reject(new Error(msg || `git ${args[0]} 执行失败`));
            return;
          }
          resolve({ ok: true, stdout: String(stdout), stderr: String(stderr) });
        }
      );
    });
  }

  async gitDiff(cwd, subpath = '') {
    const validatedCwd = this.validateWorkspace(cwd || this.defaultCwd || os.homedir());
    const cleanSubpath = typeof subpath === 'string' ? subpath.trim() : '';
    const pathArgs = cleanSubpath ? ['--', cleanSubpath] : [];

    const [statusRes, porcelainRes, headRes] = await Promise.all([
      this._runGit(validatedCwd, ['status', '-sb', ...pathArgs]),
      this._runGit(validatedCwd, ['status', '--porcelain', ...pathArgs]),
      this._runGit(validatedCwd, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }),
    ]);

    const diffBaseArgs = headRes.ok ? ['HEAD'] : [];
    const [statRes, diffRes] = await Promise.all([
      this._runGit(validatedCwd, ['diff', '--stat', ...diffBaseArgs, ...pathArgs]),
      this._runGit(validatedCwd, ['diff', ...diffBaseArgs, ...pathArgs]),
    ]);

    const porcelain = porcelainRes.stdout.trim();
    const statText = statRes.stdout.trim();
    const diffText = diffRes.stdout.trim();
    if (!porcelain && !statText && !diffText) {
      return `✨ 工作区干净，暂无未提交改动 (${validatedCwd})`;
    }

    const sections = [`📁 ${validatedCwd}`];
    const statusText = statusRes.stdout.trim();
    if (statusText) sections.push(`📌 状态：\n${statusText}`);
    if (statText) sections.push(`📊 统计：\n${statText}`);
    if (diffText) {
      const prefix = sections.join('\n\n');
      const budget = Math.max(300, 3000 - prefix.length - 40);
      const clipped = diffText.length > budget
        ? `${diffText.slice(0, budget).trimEnd()}\n…(diff 已截断)`
        : diffText;
      sections.push(`📝 改动详情：\n${clipped}`);
    }

    const result = sections.join('\n\n');
    return result.length > 3000 ? `${result.slice(0, 2985).trimEnd()}\n…(已截断)` : result;
  }

  async gitLog(cwd, count = 5) {
    const validatedCwd = this.validateWorkspace(cwd || this.defaultCwd || os.homedir());
    const parsed = Number(count);
    const n = Math.max(1, Math.min(20, Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5));
    const res = await this._runGit(validatedCwd, ['log', '-n', String(n), '--oneline', '--decorate'], { allowFail: true });
    if (!res.ok) {
      if (/does not have any commits yet|your current branch .* does not have any commits/i.test(res.stderr)) {
        return `📜 当前仓库尚无提交记录 (${validatedCwd})`;
      }
      if (/not a git repository/i.test(res.stderr)) {
        throw new Error(`当前目录不是 Git 仓库: ${validatedCwd}`);
      }
      throw new Error(res.stderr || 'git log 执行失败');
    }
    const text = res.stdout.trim();
    if (!text) return `📜 当前仓库尚无提交记录 (${validatedCwd})`;
    return `📜 最近 ${n} 条提交记录 (${validatedCwd})：\n${text}`;
  }

  async gitCommit(cwd, message) {
    const validatedCwd = this.validateWorkspace(cwd || this.defaultCwd || os.homedir());
    const cleanMsg = typeof message === 'string' ? message.trim() : '';
    if (!cleanMsg) {
      throw new Error('提交说明不能为空');
    }

    await this._runGit(validatedCwd, ['add', '-A']);
    const porcelainRes = await this._runGit(validatedCwd, ['status', '--porcelain']);
    if (!porcelainRes.stdout.trim()) {
      return `✨ 工作区干净，没有需要提交的改动 (${validatedCwd})`;
    }

    const commitRes = await this._runGit(validatedCwd, ['commit', '-m', cleanMsg]);
    const output = (commitRes.stdout || commitRes.stderr || '').trim();
    return `✅ 提交成功 (${validatedCwd})：\n${output}`;
  }

  async gitRevert(cwd, confirmed = false) {
    const validatedCwd = this.validateWorkspace(cwd || this.defaultCwd || os.homedir());
    const [statusRes, porcelainRes] = await Promise.all([
      this._runGit(validatedCwd, ['status', '-sb']),
      this._runGit(validatedCwd, ['status', '--porcelain']),
    ]);

    if (!porcelainRes.stdout.trim()) {
      return `✨ 工作区干净，没有可撤销的未提交改动 (${validatedCwd})`;
    }

    if (confirmed !== true) {
      return [
        `⚠️ 以下未提交改动将被丢弃 (${validatedCwd})：`,
        statusRes.stdout.trim(),
        '',
        '如确认丢弃所有未提交修改并清理未跟踪文件，请发送：/revert confirm',
      ].join('\n');
    }

    const headRes = await this._runGit(validatedCwd, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
    if (headRes.ok) {
      await this._runGit(validatedCwd, ['checkout', '--', '.']);
    } else {
      await this._runGit(validatedCwd, ['rm', '-rf', '--cached', '.'], { allowFail: true });
    }
    const cleanRes = await this._runGit(validatedCwd, ['clean', '-fd']);
    const extra = cleanRes.stdout.trim();
    return `↩️ 已撤销工作区未提交改动并清理未跟踪文件 (${validatedCwd})${extra ? `\n${extra}` : ''}`;
  }

  listJobs(limit = 20) {
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
    return [...this.jobs.values()]
      .reverse()
      .slice(0, max)
      .map(job => ({
        jobId: job.jobId,
        engine: job.engine,
        cwd: job.cwd,
        promptPreview: job.promptPreview,
        status: job.status,
        startedAt: job.startedAt,
        endedAt: job.endedAt || null,
        sessionId: job.sessionId || null,
        error: job.error || null,
        toolsUsed: Array.isArray(job.toolsUsed) ? [...job.toolsUsed] : [],
      }));
  }
}

module.exports = {
  TaskDispatcher,
  parseClaudeStreamLine,
  parseCodexJsonLine,
  parseOpencodeJsonLine,
  sanitizeWorkspace,
  mirrorInboxEvent,
};
