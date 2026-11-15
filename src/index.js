/** Cordis Host plugin; all task execution goes through SessionController. */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionView, sortSessions } from './session-view.js';

export const name = 'companion';
export const inject = ['sessionController', 'sessions', 'sessionProjections', 'webServer', 'connection'];
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const prefix = '/api/companion';
// DSH itself hands out ids without the `session-` prefix in some workspaces,
// so accept both shapes instead of rejecting a real session.
const SESSION_ID = /^(?:session-)?[a-zA-Z0-9_-]{1,128}$/;
const statusLabels = { waiting: '需要输入', blocked: '受阻', ready: '已完成', running: '正在思考', cancelled: '已取消', idle: '空闲' };
const defaults = {
  electronPath: join(homedir(), '.dsh/electron/Electron.app/Contents/MacOS/Electron'),
  petRoot: join(homedir(), '.dsh/profiles/web/node_modules/dsh-pet'),
  dataDir: join(homedir(), '.dsh/companion'),
  quickChatCwd: join(homedir(), '.dsh/companion/workspace'),
  shortcut: 'Alt+Space',
  launchDesktop: true,
};
export const Config = { '~standard': { version: 1, vendor: 'dsh-companion', validate(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { issues: [{ message: 'companion config must be an object' }] };
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in defaults) || typeof value !== typeof defaults[key] || (typeof value === 'string' && !value.trim()))
      return { issues: [{ message: `invalid companion config: ${key}` }] };
  }
  return { value: { ...defaults, ...raw } };
} } };

/** Native bearer comparison has no prefix or length truncation. */
export function authorized(header, token) {
  const a = Buffer.from(header ?? '');
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Install routes, child process and event listeners with one lifetime. */
export function apply(ctx, input = {}) {
  const checked = Config['~standard'].validate(input);
  if (checked.issues) throw new Error(checked.issues[0].message);
  const config = checked.value;
  const abort = new AbortController();
  const token = randomBytes(32).toString('base64url');
  let disposed = false, child, server;

  let cache, cacheVersion = -1, version = 0, listFlight, lastListAt = 0;
  const seen = new Map(), folds = new Map(), creates = new Map();
  const log = ctx.logger;
  const signal = (timeoutMs = 20_000) => AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
  const origin = () => ctx.webServer.getOrigin();
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

  async function desktop(command = 'state', value) {
    if (!['state', 'show', 'hide', 'mini', 'scale', 'control-only', 'reset'].includes(command) || ['mini', 'control-only'].includes(command) && typeof value !== 'boolean' || command === 'scale' && ![.7,.8,.9,1,1.1,1.2].includes(value)) throw new Error('桌宠操作无效');
    let connection;
    try { connection = JSON.parse(await readFile(join(config.dataDir, 'desktop-bridge.json'), 'utf8')); }
    catch { throw new Error('桌宠未运行，请打开 Agent Pet'); }
    if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 || !connection.token) throw new Error('桌宠连接无效');
    const response = await fetch(`http://127.0.0.1:${connection.port}/desktop`, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command, value }), signal: signal(5000) });
    if (!response.ok) throw new Error('桌宠暂时未连接');
    return response.json();
  }

  // DSH answers the index request with `303 ./` whenever a token is present,
  // which discards every query parameter and fragment. A session marker placed
  // in the URL therefore never reaches the app, so the target travels through
  // `pendingFocus` and the page claims it from `pending-focus`.
  function focusUrl(authenticated = false) {
    return new URL(authenticated ? ctx.connection.authenticatedUrl(origin()) : origin()).href;
  }
  // One-shot "open this session once the app is ready" mailbox; expires so a
  // stale entry cannot hijack an unrelated tab opened later.
  const PENDING_TTL = 60_000;
  let pendingFocus;
  function takePending() {
    const entry = pendingFocus;
    pendingFocus = undefined;
    if (!entry || Date.now() - entry.at > PENDING_TTL) return {};
    return { sessionId: entry.sessionId };
  }
  function speech() {
    const service = ctx.get?.('speechToText');
    if (!service?.listProviders().length) throw new Error('DSH 尚未配置语音识别服务，请先在 DSH 设置中配置');
    return service;
  }

  async function saveSeen() {
    await mkdir(config.dataDir, { recursive: true });
    const target = join(config.dataDir, 'seen.json');
    await writeFile(target + '.tmp', JSON.stringify(Object.fromEntries(seen)), { mode: 0o600 });
    await rename(target + '.tmp', target);
  }
  let saving = Promise.resolve();
  const markSeen = (id, seq) => {
    seen.set(id, Math.max(seen.get(id) ?? -1, seq));
    version++;
    saving = saving.then(saveSeen).catch(error => log.warn(`companion: 已读状态未保存: ${error.message}`));
  };

  async function list() {
    if (cache && cacheVersion === version && Date.now() - lastListAt < 10_000) return cache;
    if (listFlight) return listFlight;
    const cut = version;
    listFlight = (async () => {
      const { items } = await ctx.sessionController.list({}, signal());
      const rows = items.filter(s => !s.blank && s.origin !== 'subagent').map(s => {
        const session = ctx.sessions.get(s.sessionId);
        const p = session ? ctx.sessionProjections.snapshot(session).values : s.projections?.values ?? {};
        let fold = folds.get(s.sessionId);
        if (session && (!fold || fold.dirty)) {
          fold = { dirty: false, ...sessionView(session.snapshotEvents(), { running: s.running, projections: p, seen: seen.get(s.sessionId) ?? -1 }) };
          folds.set(s.sessionId, fold);
        }
        const view = fold && !fold.dirty ? fold : { status: s.running ? 'running' : 'history', detail: '', unread: false, lastSeq: -1 };
        const title = typeof p.title === 'string' ? p.title : p.title?.title;
        return { sessionId: s.sessionId, title: title || '未命名会话', cwd: s.cwd ?? '', updatedAt: s.updatedAt,
          status: view.status, statusText: view.statusText ?? statusLabels[view.status] ?? '', detail: view.detail,
          unread: view.unread && view.lastSeq > (seen.get(s.sessionId) ?? -1), running: s.running, lastSeq: view.lastSeq,
          ...(view.pending ? { pending: view.pending } : {}),
          ...(view.activity ? { activity: view.activity } : {}),
          ...(view.progress ? { progress: view.progress } : {}) };
      });
      cache = sortSessions(rows); cacheVersion = cut; lastListAt = Date.now();
      return cache;
    })();
    try { return await listFlight; } finally { listFlight = undefined; }
  }

  async function dispatch(action, body = {}) {
    abort.signal.throwIfAborted();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求内容无效');
    const id = body.sessionId;
    if (['conversation', 'prompt', 'cancel', 'focus', 'selectModel', 'skills', 'files'].includes(action) && (typeof id !== 'string' || !SESSION_ID.test(id)))
      throw new Error('请选择有效的 DSH 会话');
    switch (action) {
      case 'desktop': return desktop(body.command, body.value);
      case 'info': return { speechAvailable: Boolean(ctx.get?.('speechToText')?.listProviders().length), shortcut: config.shortcut, quickChatCwd: config.quickChatCwd, connected: true, version: '0.1.0' };
      case 'list': return { items: await list() };
      case 'pending-focus': return takePending();
      case 'models': return ctx.sessionController.modelCatalog();
      // `$` skills and `@` file references are session-scoped, cold-readable
      // catalogues. Use only the already-live Agent for file references so the
      // pet never activates a cold session just to show a completion list.
      case 'skills': {
        try {
          const service = ctx.get?.('sessionSkillCatalog');
          if (typeof service?.list !== 'function') return { skills: [], unavailable: true };
          return await service.list({ sessionId: id }, signal(10_000));
        } catch (error) { log.warn(`companion: 技能目录读取失败: ${error.message}`); return { skills: [], unavailable: true }; }
      }
      case 'files': {
        try {
          const service = ctx.get?.('sessionFileReferences');
          const agent = ctx.get?.('agents')?.get?.(id);
          if (typeof service?.list !== 'function' || !agent) return { candidates: [], unavailable: true };
          const query = typeof body.query === 'string' ? body.query.slice(0, 200) : '';
          return { candidates: await service.list(agent, query, signal(10_000)) };
        } catch (error) { log.warn(`companion: 文件引用读取失败: ${error.message}`); return { candidates: [], unavailable: true }; }
      }
      case 'create': {
        if (typeof id !== 'string' || !/^session-[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('新会话编号无效');
        if (!creates.has(id)) {
          if (creates.size >= 1024) throw new Error('新建会话过于频繁，请重新打开小伙伴');
          const pending = ctx.sessionController.create({ sessionId: id, cwd: config.quickChatCwd });
          creates.set(id, pending);
          pending.catch(() => creates.delete(id));
        }
        const created = await creates.get(id);
        version++;
        return created;
      }
      case 'conversation': {
        const [inspection, projection] = await Promise.all([
          ctx.sessionController.inspect(id, signal(60_000)), ctx.sessionController.projections({ sessionId: id }, signal(60_000)),
        ]);
        if (!inspection) throw new Error('会话已不存在');
        const running = (await list()).find(s => s.sessionId === id)?.running ?? false;
        const view = sessionView(inspection.events, { running, projections: projection?.values ?? {}, seen: seen.get(id) ?? -1 });
        folds.set(id, { dirty: false, ...view });
        version++;
        if ((seen.get(id) ?? -1) < view.lastSeq) markSeen(id, view.lastSeq);
        return { ...view, cwd: inspection.meta.cwd };
      }
      case 'prompt': {
        if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.requestId)) throw new Error('消息编号无效，请重新发送');
        if (!Array.isArray(body.content) || body.content.length === 0 || body.content.length > 6 || body.content.filter(p => p?.type === 'image').length > 5 || body.content.some(p =>
          !p || !(p.type === 'text' && typeof p.text === 'string' && p.text.length <= 100_000 ||
          p.type === 'image' && ['image/jpeg','image/png','image/webp'].includes(p.mediaType) && typeof p.data === 'string' && p.data.length <= 8_000_000)))
          throw new Error('消息只支持文字和最多 5 张图片');
        const result = await ctx.sessionController.prompt({ requestId: body.requestId, sessionId: id, mode: 'queue',
          content: body.content, clientTimeZone: body.clientTimeZone }, signal());
        version++;
        return result;
      }
      case 'cancel': version++; return ctx.sessionController.cancel({ sessionId: id });
      case 'selectModel': {
        if (!body.model || typeof body.model.provider !== 'string' || !body.model.provider || typeof body.model.model !== 'string' || !body.model.model) throw new Error('请选择有效的模型');
        return ctx.sessionController.selectModel({ sessionId: id, provider: body.model.provider, model: body.model.model });
      }
      case 'home': return { url: ctx.connection.authenticatedUrl(origin()) };
      case 'focus': {
        const fold = folds.get(id);
        if (fold && !fold.dirty) markSeen(id, fold.lastSeq);
        pendingFocus = { sessionId: id, at: Date.now() };
        return { url: focusUrl(true), sessionId: id };
      }
      case 'hear': {
        if (typeof body.audio !== 'string' || body.audio.length > 1_050_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)) throw new Error('语音格式无效或录音过长');
        const audio = Buffer.from(body.audio, 'base64');
        if (audio.length < 44 || audio.length > 768_044 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE' ||
          audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16000 || audio.readUInt16LE(34) !== 16 ||
          audio.toString('ascii', 36, 40) !== 'data' || audio.readUInt32LE(40) !== audio.length - 44) throw new Error('语音需要 16kHz 单声道 WAV 格式，最长 24 秒');
        const service = speech();
        const result = await service.transcribe(service.resolve({ audio, language: 'zh' }), AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]));
        if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('没有识别到语音，请重新录制');
        return { text: result.text };
      }
      default: throw new Error('不支持的操作');
    }
  }

  ctx.on('session/event', (session) => { folds.set(session.id, { dirty: true }); version++; });
  ctx.on('api-session/status', (id) => { folds.set(id, { dirty: true }); version++; });
  ctx.on('api-session/added', () => { version++; });
  ctx.on('api-session/removed', (id) => { folds.delete(id); version++; });

  const csp = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
  const assets = { '/': [join(root, 'runtime/app.html'), 'text/html'],
    '/ui.js': [join(root, 'runtime/ui.js'), 'text/javascript'], '/ui.css': [join(root, 'runtime/ui.css'), 'text/css'],
    '/audio.js': [join(root, 'runtime/audio.js'), 'text/javascript'],
    '/icon-dsh': [join(root, 'assets/icons/dsh.png'), 'image/png'],
    '/icon-antigravity': [join(root, 'assets/icons/antigravity.png'), 'image/png'],
    '/icon-workbuddy': [join(root, 'assets/icons/workbuddy.png'), 'image/png'],
    '/icon-codex': [join(root, 'assets/icons/codex.png'), 'image/png'],
    '/portrait': [join(config.petRoot, 'assets/main-character.png'), 'image/png'] };
  const animations = { idle: '待机呼吸休闲', running: '工作状态-忙碌点按', waiting: '工作状态-原地踱步张望', blocked: '工作状态-垂头叹气冒汗', ready: '工作状态-雀跃庆祝' };
  for (const [key, file] of Object.entries(animations)) assets['/animation-' + key] = [join(config.petRoot, 'assets/webm', file + '.webm'), 'video/webm'];
  for (const [suffix, [file, type]] of Object.entries(assets)) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/companion' + suffix,
      handler: async (req, res) => {
        if (!ctx.connection.authorizeIndex(req, res)) return;
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
        try {
          const data = await readFile(file);
          res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': csp });
          res.end(data);
        } catch (error) { log.warn(`companion: 资源读取失败: ${error.message}`); res.writeHead(500); res.end('资源暂时无法读取'); }
      },
    }));
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: prefix + '/action', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      if (request.headers.get('origin') && request.headers.get('origin') !== origin()) return json({ error: '跨站请求被拒绝' }, 403);
      try {
        const body = await request.json();
        const result = await dispatch(body.action, body);
        // Authentication URLs belong to native main, never page JSON or logs.
        return json(body.action === 'focus' ? { sessionId: body.sessionId } : body.action === 'home' ? { url: origin() } : result);
      } catch (error) { return json({ error: error.message }, 400); }
    },
  }));

  ctx.effect(() => {
    async function start() {
      await mkdir(config.quickChatCwd, { recursive: true });
      await mkdir(config.dataDir, { recursive: true });
      try {
        const stored = JSON.parse(await readFile(join(config.dataDir, 'seen.json'), 'utf8'));
        for (const [id, seq] of Object.entries(stored)) if (Number.isSafeInteger(seq)) seen.set(id, seq);
      } catch (error) { if (error.code !== 'ENOENT') log.warn('companion: 已读记录无法读取，将重新标记'); }
      if (disposed) return;
      server = createServer(async (req, res) => {
        if (!authorized(req.headers.authorization, token)) { res.writeHead(401); res.end(); return; }
        if (req.method !== 'POST' || req.url !== '/action') { res.writeHead(404); res.end(); return; }
        const parts = []; let size = 0;
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 42_000_000) throw new Error('请求内容过大');
            parts.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(parts).toString());
          const data = await dispatch(body.action, body);
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
        } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
      });
      server.headersTimeout = 10_000; server.requestTimeout = 70_000;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      if (disposed) { server.close(); return; }
      const address = server.address();
      await writeFile(join(config.dataDir, 'runtime.json'), JSON.stringify({ hostPid: process.pid, port: address.port, preview: origin() + '/companion/' }), { mode: 0o600 });
      // Private discovery file lets an independently launched pet reconnect after
      // a DSH restart. Credentials never enter the renderer or runtime.json.
      const connectionPath = join(config.dataDir, 'dsh-bridge.json');
      await writeFile(connectionPath + '.tmp', JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}/action`, token, hostPid: process.pid }), { mode: 0o600 });
      await rename(connectionPath + '.tmp', connectionPath);
      if (config.launchDesktop) {
        const env = { ...process.env, DSH_COMPANION_DATA: config.dataDir, DSH_COMPANION_PET_ROOT: config.petRoot, DSH_COMPANION_SHORTCUT: config.shortcut, AGENT_PET_ELECTRON: config.electronPath };
        delete env.ELECTRON_RUN_AS_NODE;
        // A short launcher exits after spawning the desktop, reparenting it to
        // launchd. Service managers can then stop DSH without killing its pet.
        child = spawn(process.execPath, [join(root, 'scripts/start.cjs')], { env, detached: true, stdio: 'ignore' });
        child.on('error', () => log.warn('companion: 桌宠启动失败，请手动打开 Agent Pet'));
        child.unref();
      }
      log.info('companion: 桌宠已连接 DSH');
    }
    start().catch(error => { if (!disposed) log.error(`companion: 启动失败: ${error.message}`); });
    return async () => {
      disposed = true; abort.abort();
      server?.closeAllConnections(); server?.close();
      try {
        const file = join(config.dataDir, 'dsh-bridge.json');
        const saved = JSON.parse(await readFile(file, 'utf8'));
        if (saved.token === token) await unlink(file);
      } catch {}
      // The desktop is independent; shutting down DSH does not terminate it.
      await saving;

    };
  });
}
