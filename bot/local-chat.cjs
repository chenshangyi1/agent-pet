'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

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
};

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
  constructor({ dispatcher, getConfig } = {}) {
    this.dispatcher = dispatcher || null;
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.sessions = new Map();
    this.sessionAliases = new Map();
    this.selectedEngine = null;
  }

  _defaultCwd() {
    const cfg = this.getConfig() || {};
    return (typeof cfg.defaultCwd === 'string' && cfg.defaultCwd.trim())
      || this.dispatcher?.defaultCwd
      || os.homedir();
  }

  resolveEngine(preferredSource = 'auto') {
    const preferred = String(preferredSource || '').trim().toLowerCase();
    if (preferred === 'claude' || preferred === 'codex') {
      return preferred;
    }
    if (this.selectedEngine === 'claude' || this.selectedEngine === 'codex') {
      return this.selectedEngine;
    }
    const cfgEngine = String(this.getConfig()?.defaultEngine || '').trim().toLowerCase();
    if (cfgEngine === 'claude' || cfgEngine === 'codex') {
      return cfgEngine;
    }
    const probes = this.dispatcher?.probeEngines ? this.dispatcher.probeEngines() : {};
    if (probes.claude?.available) return 'claude';
    if (probes.codex?.available) return 'codex';
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
      providerLabel: PROVIDER_LABELS[engine] || engine,
      cliSessionId: null,
      title: '本地对话',
      cwd: this._defaultCwd(),
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

  _extractPromptAndImages(body = {}) {
    const textParts = [];
    const dispatchImages = [];
    const tempFiles = [];

    if (typeof body.text === 'string' && body.text.trim()) {
      textParts.push(body.text.trim());
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
          else if (part.trim()) textParts.push(part.trim());
          continue;
        }
        if (typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          textParts.push(part.text.trim());
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
      else textParts.push(body.content.trim());
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
      const rawModel = typeof body.model === 'string'
        ? body.model
        : (body.model?.model || body.model?.id || '');
      const normalized = String(rawModel || '').trim().toLowerCase();
      if (normalized === 'claude' || normalized === 'codex') {
        this.selectedEngine = normalized;
        const target = this._resolveSession(body.sessionId);
        if (target) {
          target.model = normalized;
          if (target.messages.length === 0) {
            target.provider = normalized;
            target.providerLabel = PROVIDER_LABELS[normalized] || normalized;
          }
        }
      }
      return { model: this.selectedEngine || this.resolveEngine(currentSource) };
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
      const files = listWorkspaceFiles(this._defaultCwd(), body.query || '', MAX_LIST_FILES);
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
      return { cancelled: true };
    }

    if (action === 'create' || action === 'prompt') {
      const engine = this.resolveEngine(currentSource);
      let session = this._resolveSession(body.sessionId);
      if (!session) {
        session = this._createSession(engine, body.sessionId || null);
      }

      const { text: promptText, images, tempFiles } = this._extractPromptAndImages(body);
      if (!promptText && images.length === 0) {
        if (action === 'create') {
          return { sessionId: session.sessionId, status: session.status };
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

      const dispatchEngine = session.provider || engine;
      const runPromise = this.dispatcher.dispatch({
        engine: dispatchEngine,
        prompt: effectivePrompt,
        cwd: session.cwd,
        sessionId: session.cliSessionId,
        images,
        onProgress: ev => {
          if (session.status !== 'running') return;
          if (ev?.tool) {
            session.detail = `正在使用 ${ev.tool}`;
            session.lastSeq += 1;
            session.updatedAt = Date.now();
          } else if (ev?.text) {
            session.detail = String(ev.text).slice(0, 80);
            session.lastSeq += 1;
            session.updatedAt = Date.now();
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
          }
          if (res?.status === 'cancelled' || session.status === 'cancelled') {
            if (session.status !== 'cancelled') {
              session.status = 'cancelled';
              session.statusText = '已取消';
              session.detail = res?.text || '任务已取消';
              session.lastSeq += 1;
              session.updatedAt = Date.now();
            }
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
        })
        .finally(() => {
          for (const f of tempFiles) {
            fs.promises.unlink(f).catch(() => {});
          }
        });

      return { sessionId: session.sessionId, status: 'running' };
    }

    throw new Error(`不支持的本地对话操作: ${action}`);
  }
}

module.exports = {
  LocalChatBridge,
  listWorkspaceFiles,
  parseDataUrlImage,
};
