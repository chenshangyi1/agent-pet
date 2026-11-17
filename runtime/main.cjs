'use strict';
/** Transparent pet; only this main process holds the local DSH credential. */
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, shell, screen, dialog } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { Providers, sortRows } = require('./providers.cjs');
const { createNotch } = require('./notch.cjs');
const { layoutPet } = require('./placement.cjs');
const { ConnectorRegistry } = require('../connectors/registry.cjs');
const { CATALOG_BY_ID } = require('../connectors/catalog.cjs');
const { LocalSpeech } = require('./local-speech.cjs');
const { AutoStartManager } = require('./autostart.cjs');
const { BotService } = require('../bot/service.cjs');
app.setName('Agent Pet');
const dataDir = process.env.AGENT_PET_DATA || process.env.DSH_COMPANION_DATA || path.join(homedir(), '.dsh/companion');
const endpoint = process.env.DSH_COMPANION_ENDPOINT;
const token = process.env.DSH_COMPANION_TOKEN;
const hostPid = Number(process.env.DSH_COMPANION_HOST_PID);
function resolveWebmDir() {
  const candidates = [
    path.join(__dirname, '../assets/webm'),
    process.env.DSH_COMPANION_PET_ROOT ? path.join(process.env.DSH_COMPANION_PET_ROOT, 'assets/webm') : null,
    path.join(homedir(), '.dsh/profiles/web/node_modules/dsh-pet/assets/webm'),
  ].filter(Boolean);
  return candidates.find(dir => existsSync(path.join(dir, '待机呼吸休闲.webm')))
    || candidates.find(dir => existsSync(dir))
    || candidates[0];
}
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(dataDir, 'electron'));
const registry = new ConnectorRegistry({ rootDir: path.dirname(__dirname), dataDir });
const localSpeech = new LocalSpeech({ rootDir: path.dirname(__dirname) });
const autoStart = new AutoStartManager({ rootDir: path.dirname(__dirname) });
const providers = new Providers(dataDir, { endpoint, token }, { enabledProviders: registry.enabledIds() });
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
app.on('second-instance', () => { if (process.env.AGENT_PET_SHOW_ON_LAUNCH === '1') showPet(); });
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const settingsFile = path.join(dataDir, 'desktop.json');
let win, managerWin, tray, notch, commandServer, refreshTimer, botService, quitting = false, dragStart, dragTimer, placement;
let settings = { hidden: false, mini: false, controlOnly: false, source: 'auto' };
try { settings = { ...settings, ...JSON.parse(readFileSync(settingsFile, 'utf8')) }; } catch (error) {
  if (error.code !== 'ENOENT') process.stderr.write('[companion] 无法读取桌宠偏好，使用默认值\n');
}
function validSources() { return ['auto', ...registry.enabledIds()]; }
function isReadOnlyConnector(id) {
  const entry = CATALOG_BY_ID[id];
  return Boolean(entry && !entry.replySupported);
}
if (!validSources().includes(settings.source)) settings.source = 'auto';
function save() {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(settingsFile + '.tmp', JSON.stringify(settings), { mode: 0o600 });
  renameSync(settingsFile + '.tmp', settingsFile);
}
function layout(position) {
  // The pet is a floating desktop window, so clamp it to the physical display
  // bounds. `workArea` excludes the macOS menu bar and incorrectly stops the
  // character one menu-bar-height below the top edge.
  const area = screen.getDisplayNearestPoint({ x: Math.round(position.x + 50), y: Math.round(position.y + 65) }).bounds;
  return layoutPet(position, area, petScale());
}
function petScale() {
  return Number.isFinite(settings.petScale) ? Math.max(.65, Math.min(1.25, settings.petScale)) : settings.mini ? .8 : 1;
}
function mode() { return { placement: placement?.content, controlOnly: Boolean(settings.controlOnly), source: settings.source }; }
function positionPet(position) {
  const next = layout(position);
  if (placement && JSON.stringify(next) === JSON.stringify(placement)) return;
  placement = next;
  win.setBounds(placement.bounds);
  settings.petX = placement.position.x; settings.petY = placement.position.y;
  win.webContents.send('companion:mode', mode());
}
function currentPosition() { return placement.position; }
function showPet(focusQuickChat = false) {
  settings.hidden = false;
  if (focusQuickChat) { win.show(); win.focus(); } else win.showInactive();
  win.webContents.send('companion:mode', { ...mode(), notice: true, focusQuickChat });
  save(); notch?.send();
}
function hidePet() { settings.hidden = true; win.hide(); save(); notch?.send(); }
function setPetScale(value) {
  const position = currentPosition();
  settings.petScale = Math.max(.65, Math.min(1.25, value));
  settings.mini = settings.petScale === .8;
  win.webContents.setZoomFactor(settings.petScale);
  positionPet(position); save();
}
function setMini(value) { setPetScale(value ? .8 : 1); }
function setControlOnly(value) { settings.controlOnly = value; win.webContents.send('companion:mode', mode()); save(); }
function resetPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  positionPet({ x: area.x + area.width - 194, y: area.y + area.height - 159 });
  showPet();
}
function desktopState() { return { visible: win.isVisible(), source: settings.source, notchExpanded: notch?.isExpanded() ?? false, mini: Boolean(settings.mini), petScale: petScale(), controlOnly: Boolean(settings.controlOnly), shortcut: process.env.DSH_COMPANION_SHORTCUT || 'Alt+Space' }; }
function updateDrag() {
  if (!dragStart) return;
  const cursor = screen.getCursorScreenPoint();
  const dx = cursor.x - dragStart.cursor.x, dy = cursor.y - dragStart.cursor.y;
  if (Math.abs(dx) + Math.abs(dy) > 5) dragStart.moved = true;
  if (dragStart.moved) positionPet({ x: dragStart.position.x + dx, y: dragStart.position.y + dy });
}
function endDrag() { updateDrag(); clearInterval(dragTimer); dragTimer = undefined; dragStart = undefined; save(); }
function menuTemplate() {
  const enabled = registry.enabledIds().map(id => CATALOG_BY_ID[id]).filter(Boolean);
  const followChoices = [['auto', '自动跟随'], ...enabled.map(entry => [entry.id, entry.label])];
  const openItems = enabled.map(entry => ({
    label: `打开 ${entry.label}`,
    click: () => (entry.id === 'dsh' ? openDsh() : openBundle(entry.id)).catch(err => process.stderr.write(`[companion] 无法打开 ${entry.label}: ${err?.message || '未知错误'}\n`)),
  }));
  return [
    { label: '跟随工具', submenu: followChoices.map(([id, label]) => ({ label, type: 'radio', checked: settings.source === id, click: () => setSource(id) })) },
    { label: '管理 AI Agent...', click: () => openManagerWindow('connectors') },
    { label: 'Bot 派活与通知...', click: () => openManagerWindow('bot') },
    { label: '收回刘海', click: hidePet },
    { label: '打开刘海面板', click: () => notch?.expand(true) },
    ...(openItems.length > 1 ? [{ label: '打开应用', submenu: openItems }] : openItems),
    { label: '桌宠大小', submenu: [.7, .8, .9, 1, 1.1, 1.2].map(value => ({
      label: `${Math.round(value * 100)}%`, type: 'radio', checked: Math.abs(petScale() - value) < .01,
      click: () => setPetScale(value),
    })) },
    { label: '仅显示控制条', type: 'checkbox', checked: Boolean(settings.controlOnly), click: () => setControlOnly(!settings.controlOnly) },
    { label: '重置位置', click: resetPosition },
    { label: '隐藏小鑫', click: hidePet },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: autoStart.isEnabled(),
      click: () => {
        autoStart.setEnabled(!autoStart.isEnabled());
        if (managerWin && !managerWin.isDestroyed() && botService) {
          managerWin.webContents.send('companion:bot-updated', { ...botService.getState(), autoStart: autoStart.isEnabled() });
        }
      },
    },
    { type: 'separator' },
    { label: '退出小鑫', click: () => app.quit() },
  ];
}
function setSource(source) {
  if (!validSources().includes(source)) throw new Error('来源无效');
  settings.source = source;
  if (source !== 'auto' && CATALOG_BY_ID[source]) {
    settings.chatTarget = source;
    if (botService?.localChat && LOCAL_CHAT_ENGINES.has(source)) {
      botService.localChat.selectedEngine = source;
    }
  }
  save(); win?.webContents.send('companion:mode', mode()); notch?.send();
}
function openBundle(providerId) {
  const entry = CATALOG_BY_ID[providerId];
  if (!entry || !entry.bundleId) return Promise.reject(new Error('应用配置无效'));
  return new Promise((resolve, reject) => execFile('/usr/bin/open', ['-b', entry.bundleId], error => error ? reject(new Error(`无法打开 ${entry.label}`)) : resolve({ opened: true })));
}
async function rpc(body) {
  try {
    return await providers.dsh(body);
  } catch (error) {
    const msg = String(error?.message || '');
    if (!msg || msg === 'DSH 未连接' || msg === 'DSH 暂时未连接' || /fetch failed|ECONNREFUSED|AbortError|TimeoutError/i.test(msg)) {
      throw new Error('DSH 尚未运行');
    }
    throw error;
  }
}
const INTERACTIVE_ACTIONS = new Set([
  'create', 'prompt', 'conversation', 'cancel', 'models', 'selectModel', 'skills', 'files',
  'workspaces', 'selectWorkspace', 'sessions', 'selectSession',
]);
const DIRECT_CHAT_SOURCES = new Set(['auto', 'dsh', 'claude', 'codex', 'opencode', 'workbuddy-ai']);
const LOCAL_CHAT_ENGINES = new Set(['claude', 'codex', 'opencode', 'workbuddy-ai', 'dsh']);

function isDshOnline() {
  return Boolean(providers.snapshot?.sources?.find(row => row.id === 'dsh')?.connected);
}

function currentTargetAgent() {
  const saved = typeof settings.chatTarget === 'string' ? settings.chatTarget.trim() : '';
  if (saved && CATALOG_BY_ID[saved]) return saved;
  const probes = botService?.dispatcher?.probeEngines ? botService.dispatcher.probeEngines() : {};
  if (probes.claude?.available) return 'claude';
  if (probes.codex?.available) return 'codex';
  if (probes.opencode?.available) return 'opencode';
  if (probes['workbuddy-ai']?.available) return 'workbuddy-ai';
  return 'dsh';
}

function getChatTargets() {
  const probes = botService?.dispatcher?.probeEngines ? botService.dispatcher.probeEngines() : {};
  const dshOnline = isDshOnline();
  const out = [];
  for (const id of registry.enabledIds()) {
    const entry = CATALOG_BY_ID[id];
    if (!entry) continue;
    let isDirect = false;
    if (id === 'claude') isDirect = Boolean(probes.claude?.available);
    else if (id === 'codex') isDirect = Boolean(probes.codex?.available);
    else if (id === 'opencode') isDirect = Boolean(probes.opencode?.available);
    else if (id === 'workbuddy-ai') isDirect = Boolean(probes['workbuddy-ai']?.available);
    else if (id === 'dsh') isDirect = dshOnline;
    else if (id === 'antigravity') isDirect = Boolean(probes.antigravity?.available);
    out.push({
      id,
      label: entry.label,
      mode: isDirect ? 'direct' : 'launch',
      available: true,
    });
  }
  return out;
}

function copyToClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error('复制到剪贴板失败'))));
    child.stdin.end(String(text || ''), 'utf8');
  });
}

function extractPromptText(body = {}) {
  const parts = [];
  if (typeof body.text === 'string' && body.text.trim()) parts.push(body.text.trim());
  if (Array.isArray(body.content)) {
    for (const part of body.content) {
      if (typeof part === 'string' && !part.startsWith('data:image/') && part.trim()) parts.push(part.trim());
      else if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) parts.push(part.text.trim());
    }
  } else if (typeof body.content === 'string' && !body.content.startsWith('data:image/') && body.content.trim()) {
    parts.push(body.content.trim());
  }
  return parts.join('\n').trim();
}

function parseInlineTarget(body = {}) {
  const check = raw => {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed || trimmed.startsWith('[引用]')) return null;
    const match = trimmed.match(/^@([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    const id = match[1].toLowerCase();
    if (!CATALOG_BY_ID[id]) return null;
    return { id, rest: String(match[2] || '').trim() };
  };
  if (typeof body.text === 'string') {
    const hit = check(body.text);
    if (hit) return hit;
  }
  if (Array.isArray(body.content)) {
    for (const part of body.content) {
      const raw = typeof part === 'string' ? part : (part?.type === 'text' ? part.text : '');
      const hit = check(raw);
      if (hit) return hit;
    }
  } else if (typeof body.content === 'string') {
    const hit = check(body.content);
    if (hit) return hit;
  }
  return null;
}

async function agentAction(body) {
  if (body.action === 'list') {
    await providers.refresh();
    const base = providers.list(settings.source);
    const localItems = botService?.localChat ? botService.localChat.listSessions(settings.source) : [];
    if (!localItems.length) return base;
    const claimedCliKeys = new Set();
    for (const item of localItems) {
      if (item?.provider && item?.cliSessionId) {
        claimedCliKeys.add(`${item.provider}:${item.cliSessionId}`);
      }
    }
    const mergedMap = new Map();
    for (const item of base.items || []) {
      if (!item?.sessionId || claimedCliKeys.has(item.sessionId)) continue;
      mergedMap.set(item.sessionId, item);
    }
    for (const item of localItems) {
      if (!item?.sessionId) continue;
      const prev = mergedMap.get(item.sessionId);
      if (!prev || Number(item.updatedAt || 0) >= Number(prev.updatedAt || 0)) {
        mergedMap.set(item.sessionId, item);
      }
    }
    return { ...base, items: sortRows([...mergedMap.values()]) };
  }
  if (body.action === 'info') {
    let dshConnected = isDshOnline();
    let dshSpeech = false;
    if (['dsh', 'auto'].includes(settings.source) || dshConnected) {
      try {
        const info = await rpc(body);
        dshConnected = true;
        dshSpeech = Boolean(info?.speechAvailable);
      } catch {}
    }
    const targetAgent = currentTargetAgent();
    const localEngine = botService?.localChat?.resolveEngine(settings.source)
      || (['claude', 'codex', 'opencode'].includes(targetAgent) ? targetAgent : 'claude');
    return {
      connected: true,
      dshConnected,
      localEngine,
      targetAgent,
      targets: getChatTargets(),
      speechAvailable: Boolean(dshSpeech || localSpeech.hasRecognizer()),
      source: settings.source,
    };
  }
  if (body.action === 'speak') return localSpeech.speak(body.text);
  if (body.action === 'speak-stop') { localSpeech.stopSpeaking(); return { stopped: true }; }
  if (body.action === 'hear') {
    try {
      const info = await rpc({ action: 'info' });
      if (info?.speechAvailable) return await rpc(body);
    } catch {}
    return localSpeech.transcribeWave(body.audio, typeof body.locale === 'string' ? body.locale : 'zh-CN');
  }
  if (body.action === 'models') {
    const targets = getChatTargets();
    return {
      current: currentTargetAgent(),
      targets,
      groups: [
        {
          id: 'agents',
          name: '目标 AI Agent',
          models: targets.map(t => ({ id: t.id, name: t.label, mode: t.mode })),
        },
      ],
    };
  }
  if (body.action === 'selectModel') {
    const candidates = [
      body.targetAgent,
      typeof body.model === 'string' ? body.model : null,
      body.model?.model,
      body.model?.id,
      body.model?.provider,
    ];
    let id = '';
    for (const cand of candidates) {
      const val = String(cand || '').trim();
      if (val && CATALOG_BY_ID[val]) {
        id = val;
        break;
      }
    }
    if (!id) throw new Error('未知的目标 AI Agent');
    settings.chatTarget = id;
    save();
    if (botService?.localChat && LOCAL_CHAT_ENGINES.has(id)) {
      botService.localChat.selectedEngine = id;
    }
    return {
      targetAgent: id,
      label: CATALOG_BY_ID[id].label,
      targets: getChatTargets(),
    };
  }
  if (['workspaces', 'selectWorkspace', 'sessions', 'selectSession'].includes(body.action)) {
    if (!botService?.localChat) throw new Error('本地对话服务尚未就绪');
    if (body.action === 'selectWorkspace' && body.browse === true) {
      const picked = await dialog.showOpenDialog(win, {
        title: '选择项目工作目录',
        defaultPath: botService.localChat.currentCwd(),
        properties: ['openDirectory'],
      });
      if (picked.canceled || !picked.filePaths?.length) {
        return { canceled: true, currentCwd: botService.localChat.currentCwd() };
      }
      return botService.localChat.handleAction(
        { ...body, action: 'selectWorkspace', cwd: picked.filePaths[0], userSelected: true },
        settings.source
      );
    }
    return botService.localChat.handleAction(body, settings.source);
  }
  const sessionId = String(body.sessionId || '');
  if (body.action === 'create' || body.action === 'prompt') {
    const inline = parseInlineTarget(body);
    const explicitTarget = typeof body.targetAgent === 'string' && CATALOG_BY_ID[body.targetAgent.trim()]
      ? body.targetAgent.trim()
      : '';
    const target = inline?.id
      || explicitTarget
      || (sessionId.startsWith('local:claude:') ? 'claude'
        : sessionId.startsWith('local:codex:') ? 'codex'
        : sessionId.startsWith('local:opencode:') ? 'opencode'
        : sessionId.startsWith('local:workbuddy-ai:') ? 'workbuddy-ai'
        : sessionId.startsWith('launch:') && CATALOG_BY_ID[sessionId.slice(7)] ? sessionId.slice(7)
        : currentTargetAgent());
    const dshOnline = isDshOnline();
    if (target === 'dsh' && dshOnline) {
      if (body.action === 'prompt' && (sessionId.startsWith('local:') || sessionId.startsWith('launch:'))) {
        const created = await rpc({ action: 'create', sessionId: `session-${randomUUID()}` });
        return await rpc({ ...body, sessionId: created?.sessionId || body.sessionId });
      }
      return await rpc(body);
    }
    const probes = botService?.dispatcher?.probeEngines ? botService.dispatcher.probeEngines() : {};
    const isDirectLocal = target === 'claude'
      || target === 'codex'
      || target === 'opencode'
      || target === 'workbuddy-ai'
      || target === 'dsh'
      || (target === 'antigravity' && Boolean(probes.antigravity?.available));
    if (isDirectLocal) {
      if (!botService?.localChat) throw new Error('本地对话服务尚未就绪');
      const localTarget = target === 'dsh'
        ? (probes.claude?.available ? 'claude' : probes.codex?.available ? 'codex' : probes.opencode?.available ? 'opencode' : probes['workbuddy-ai']?.available ? 'workbuddy-ai' : 'claude')
        : target;
      return botService.localChat.handleAction({ ...body, targetAgent: localTarget }, localTarget);
    }
    if (body.action === 'create') {
      return { sessionId: `launch:${target}`, targetAgent: target, mode: 'launch' };
    }
    let promptText = extractPromptText(body);
    if (inline?.id === target) {
      promptText = promptText.replace(new RegExp(`^@${target}\\s*`, 'i'), '').trim();
    }
    if (promptText) {
      await copyToClipboard(promptText);
    }
    const boundLocal = sessionId && botService?.localChat?._resolveSession(sessionId);
    const launchChatId = boundLocal?.cliSessionId
      || (sessionId.startsWith('workbuddy:') ? sessionId.slice('workbuddy:'.length) : '');
    if (target === 'workbuddy' && launchChatId && /^[a-zA-Z0-9_-]+$/.test(launchChatId)) {
      try {
        await shell.openExternal(`workbuddy://chat/${encodeURIComponent(launchChatId)}`);
      } catch {
        if (CATALOG_BY_ID[target]?.bundleId) await openBundle(target);
      }
    } else if (CATALOG_BY_ID[target]?.bundleId) {
      await openBundle(target);
    }
    return {
      sessionId: `launch:${target}`,
      launched: true,
      targetAgent: target,
      providerLabel: CATALOG_BY_ID[target]?.label || target,
    };
  }
  if (sessionId.startsWith('launch:')) {
    const launchTarget = sessionId.slice('launch:'.length);
    if (['focus', 'home'].includes(body.action)) {
      if (CATALOG_BY_ID[launchTarget]?.bundleId) return openBundle(launchTarget).catch(() => ({ opened: true }));
      return { opened: true };
    }
    if (body.action === 'conversation') {
      return { sessionId, title: CATALOG_BY_ID[launchTarget]?.label || launchTarget, status: 'idle', messages: [] };
    }
    if (body.action === 'cancel') return { cancelled: true };
    if (['skills', 'files'].includes(body.action) && botService?.localChat) {
      return botService.localChat.handleAction(body, settings.source);
    }
  }
  const isLocalSession = Boolean(botService?.localChat?.isLocalSessionId(sessionId));
  if (isLocalSession) {
    if (['focus', 'home'].includes(body.action)) {
      const localRow = botService.localChat.listSessions(settings.source).find(row => row.sessionId === sessionId);
      const localProvider = localRow?.provider;
      if (localProvider && CATALOG_BY_ID[localProvider]?.bundleId) {
        return openBundle(localProvider).catch(() => ({ opened: true }));
      }
      return { opened: true };
    }
    if (INTERACTIVE_ACTIONS.has(body.action)) {
      return botService.localChat.handleAction(body, settings.source);
    }
  }
  const prefixIdx = sessionId.indexOf(':');
  const sessionProvider = prefixIdx > 0 ? sessionId.slice(0, prefixIdx) : '';
  const targetProvider = isReadOnlyConnector(sessionProvider)
    ? sessionProvider
    : (['focus', 'home'].includes(body.action) && isReadOnlyConnector(settings.source) ? settings.source : null);
  if (targetProvider) {
    if (['focus', 'home'].includes(body.action)) return openBundle(targetProvider);
    throw new Error(`请在 ${CATALOG_BY_ID[targetProvider].label} 中继续此任务`);
  }
  if (INTERACTIVE_ACTIONS.has(body.action)) {
    if (['claude', 'codex', 'opencode', 'workbuddy-ai'].includes(settings.source)) {
      if (!botService?.localChat) throw new Error('本地对话服务尚未就绪');
      return botService.localChat.handleAction(body, settings.source);
    }
    if (['auto', 'dsh'].includes(settings.source)) {
      const dshOnline = isDshOnline();
      if (dshOnline) {
        try {
          return await rpc(body);
        } catch (error) {
          if (error?.message !== 'DSH 尚未运行' || !botService?.localChat) throw error;
          return botService.localChat.handleAction(body, settings.source);
        }
      }
      if (!botService?.localChat) throw new Error('DSH 尚未运行');
      return botService.localChat.handleAction(body, settings.source);
    }
  }
  if (isReadOnlyConnector(settings.source) && !body.sessionId && !['list', 'info'].includes(body.action)) {
    throw new Error(`请在 ${CATALOG_BY_ID[settings.source].label} 中新建任务`);
  }
  return ['focus', 'home'].includes(body.action) ? openDsh(body) : rpc(body);
}
function applyDesktop(command, value) {
  switch (command) {
    case 'state': break;
    case 'show': showPet(); break;
    case 'hide': hidePet(); break;
    case 'mini': setMini(value === true); break;
    case 'scale': if ([.7,.8,.9,1,1.1,1.2].includes(value)) setPetScale(value); else throw new Error('大小无效'); break;
    case 'control-only': setControlOnly(value === true); break;
    case 'reset': resetPosition(); break;
    default: throw new Error('操作无效');
  }
  return desktopState();
}
async function startCommands() {
  const secret = randomBytes(32).toString('base64url');
  commandServer = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from('Bearer ' + secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401); res.end(); return; }
    if (req.method !== 'POST' || req.url !== '/desktop') { res.writeHead(404); res.end(); return; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error('请求过大'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const result = applyDesktop(body.command, body.value);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(400); res.end(JSON.stringify({ error: '桌宠操作失败' })); }
  });
  commandServer.requestTimeout = 5000;
  await new Promise(resolve => commandServer.listen(0, '127.0.0.1', resolve));
  writeFileSync(path.join(dataDir, 'desktop-bridge.json'), JSON.stringify({ port: commandServer.address().port, token: secret, pid: process.pid }), { mode: 0o600 });
}

async function openDsh(body = { action: 'home' }) {
  const result = await rpc(body);
  const url = new URL(result.url);
  if (!['127.0.0.1','localhost'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('DSH 地址无效');
  // The authenticated URL is what must reach the browser: DSH answers it with
  // `303 ./` and mints the session cookie. The target session rides in the host
  // mailbox (`pending-focus`) because that redirect drops any URL marker.
  await shell.openExternal(url.href);
  return { opened: true };
}
function trusted(event) {
  if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('拒绝未知窗口');
}
function trustedManager(event) {
  if (!managerWin || managerWin.isDestroyed() || event.sender !== managerWin.webContents || event.senderFrame !== managerWin.webContents.mainFrame) throw new Error('拒绝未知管理窗口');
}
async function syncConnectorsAfterChange(list) {
  providers.setEnabledProviders(registry.enabledIds());
  if (!validSources().includes(settings.source)) settings.source = 'auto';
  save();
  await providers.refresh().catch(() => {});
  try { await botService?.onSnapshot(providers.snapshot); } catch {}
  win?.webContents.send('companion:mode', mode());
  notch?.send();
  if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send('companion:connectors-updated', list);
  return list;
}
function openManagerWindow(initialTab = 'connectors') {
  const tab = initialTab === 'bot' ? 'bot' : 'connectors';
  notch?.expand(false);
  if (process.platform === 'darwin') app.focus({ steal: true });
  if (managerWin && !managerWin.isDestroyed()) {
    managerWin.show();
    managerWin.focus();
    managerWin.webContents.send('companion:connectors-updated', registry.detectAll());
    if (botService) managerWin.webContents.send('companion:bot-updated', { ...botService.getState(), autoStart: autoStart.isEnabled() });
    managerWin.webContents.send('companion:manager-tab', tab);
    return;
  }
  managerWin = new BrowserWindow({
    width: 660,
    height: 700,
    minWidth: 500,
    minHeight: 500,
    title: '小鑫 · AI Agent 与 Bot 管理',
    resizable: true,
    minimizable: true,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'manager-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  managerWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  managerWin.webContents.on('will-navigate', event => event.preventDefault());
  managerWin.on('closed', () => { managerWin = null; });
  managerWin.once('ready-to-show', () => {
    managerWin.show();
    managerWin.focus();
    managerWin.webContents.send('companion:manager-tab', tab);
  });
  managerWin.loadFile(path.join(__dirname, 'manager.html'), tab === 'bot' ? { hash: 'bot' } : undefined).catch(() => {});
}
ipcMain.handle('companion:connectors', async (event, body) => {
  trustedManager(event);
  const action = body?.action;
  if (action === 'list') return registry.detectAll();
  if (action === 'enable-all') return syncConnectorsAfterChange(registry.enableAllInstalled());
  if (action === 'enable') return syncConnectorsAfterChange(registry.enable(String(body.id || '')));
  if (action === 'disable') return syncConnectorsAfterChange(registry.disable(String(body.id || '')));
  if (action === 'open') {
    const id = String(body.id || '');
    return id === 'dsh' ? openDsh() : openBundle(id);
  }
  throw new Error('不支持的操作');
});
ipcMain.handle('companion:bot', async (event, body) => {
  trustedManager(event);
  if (!botService) throw new Error('Bot 服务尚未初始化');
  const action = body?.action;
  if (action === 'state') return { ...botService.getState(), autoStart: autoStart.isEnabled() };
  if (action === 'autostart') {
    const res = await autoStart.setEnabled(Boolean(body?.enabled));
    const next = { ...botService.getState(), ...res, autoStart: autoStart.isEnabled() };
    if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send('companion:bot-updated', next);
    return next;
  }
  if (action === 'save') return { ...(await botService.saveConfig(body?.config || {})), autoStart: autoStart.isEnabled() };
  if (action === 'pair') return { ...botService.regeneratePairingCode(), autoStart: autoStart.isEnabled() };
  if (action === 'test') return botService.testPush(String(body?.channel || ''));
  if (action === 'stop-job') return botService.stopJob(body?.jobId);
  if (action === 'browse-cwd') {
    const picked = await dialog.showOpenDialog(managerWin, {
      title: '选择默认工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths?.length) return { canceled: true };
    return { canceled: false, path: picked.filePaths[0] };
  }
  throw new Error('不支持的操作');
});
ipcMain.handle('companion:action', async (event, body) => {
  trusted(event);
  if (!body || !['list','focus','home','info','create','prompt','cancel','models','selectModel','skills','files','workspaces','selectWorkspace','sessions','selectSession','hear','speak','speak-stop','conversation'].includes(body.action)) throw new Error('不支持的操作');
  return agentAction(body);
});
ipcMain.handle('companion:window', (event, action, value) => {
  trusted(event);
  if (action === 'menu') Menu.buildFromTemplate(menuTemplate()).popup({ window: win });
  else if (action === 'passthrough' && typeof value === 'boolean') win.setIgnoreMouseEvents(value, { forward: true });
  else if (action === 'placement') return mode();
  else if (action === 'hide') hidePet();
  else if (action === 'source') setSource(value);
  else if (action === 'drag-start') {
    clearInterval(dragTimer);
    dragStart = { cursor: screen.getCursorScreenPoint(), position: currentPosition(), moved: false };
    win.setIgnoreMouseEvents(false);
    dragTimer = setInterval(updateDrag, 16);
  }
  else if (action === 'drag-end') endDrag();
  else if (action === 'animation' && ['idle','running','waiting','blocked','ready'].includes(value)) {
    const names = { idle: '待机呼吸休闲', running: '工作状态-忙碌点按', waiting: '工作状态-原地踱步张望', blocked: '工作状态-垂头叹气冒汗', ready: '工作状态-雀跃庆祝' };
    return 'data:video/webm;base64,' + readFileSync(path.join(resolveWebmDir(), names[value] + '.webm')).toString('base64');
  }
});
process.on('SIGUSR1', () => { if (win && !win.isDestroyed()) showPet(); });
process.on('SIGTERM', () => app.quit());
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();
  const area = screen.getPrimaryDisplay().workArea;
  placement = layout({ x: Number.isFinite(settings.petX) ? settings.petX : Number.isFinite(settings.x) ? settings.x + 70 : area.x + area.width - 194,
    y: Number.isFinite(settings.petY) ? settings.petY : Number.isFinite(settings.y) ? settings.y + 85 : area.y + area.height - 159 });
  win = new BrowserWindow({ ...placement.bounds,
    title: '小鑫', frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true,
    skipTaskbar: true, resizable: false, show: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  win.webContents.setZoomFactor(petScale());
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permission === 'media' && details?.mediaTypes?.includes('audio') === true);
  });
  win.webContents.on('render-process-gone', () => { process.stderr.write('[companion] 桌宠渲染进程已退出\n'); app.quit(); });
  win.on('close', event => { if (!quitting) { event.preventDefault(); hidePet(); } });
  win.on('blur', () => { if (dragStart) endDrag(); });
  await win.loadFile(path.join(__dirname, 'app.html'));
  if (!settings.hidden) win.showInactive();
  await startCommands();
  botService = new BotService({
    rootDir: path.dirname(__dirname),
    dataDir,
    providers,
    desktopCommand: (command, value) => {
      if (!win || win.isDestroyed()) throw new Error('桌宠窗口尚未就绪');
      return applyDesktop(command, value);
    },
    openApp: id => (id === 'dsh' ? openDsh() : openBundle(id)),
  });
  let petUpdateTimer = null;
  let lastPetPushAt = 0;
  const pushPetUpdate = () => {
    if (!win || win.isDestroyed()) return;
    const elapsed = Date.now() - lastPetPushAt;
    if (elapsed >= 150) {
      lastPetPushAt = Date.now();
      win.webContents.send('companion:updated');
      return;
    }
    if (!petUpdateTimer) {
      petUpdateTimer = setTimeout(() => {
        petUpdateTimer = null;
        lastPetPushAt = Date.now();
        if (win && !win.isDestroyed()) win.webContents.send('companion:updated');
      }, 150 - elapsed);
    }
  };
  botService.on('updated', state => {
    pushPetUpdate();
    if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send('companion:bot-updated', { ...state, autoStart: autoStart.isEnabled() });
  });
  {
    const initialTarget = currentTargetAgent();
    if (botService.localChat && LOCAL_CHAT_ENGINES.has(initialTarget)) {
      botService.localChat.selectedEngine = initialTarget;
    }
  }
  try {
    await botService.start();
  } catch (error) {
    process.stderr.write(`[companion] Bot 网关启动失败: ${error?.message || '未知错误'}\n`);
  }
  await providers.refresh().catch(() => {});
  try { await botService.onSnapshot(providers.snapshot); } catch {}
  notch = createNotch({
    getState: () => {
      const priority = ['waiting', 'blocked', 'running', 'ready', 'unknown', 'idle'];
      const rankOf = s => {
        const idx = priority.indexOf(s);
        return idx === -1 ? priority.length : idx;
      };
      const candidates = providers.snapshot.sources
        .filter(row => settings.source === 'auto' || row.id === settings.source)
        .sort((a, b) => rankOf(a.status) - rankOf(b.status));
      const top = candidates[0];
      const activeSource = settings.source === 'auto'
        ? (top && top.status !== 'idle' ? top.id : (providers.snapshot.sources.find(s => s.connected)?.id || providers.snapshot.sources[0]?.id || 'dsh'))
        : settings.source;
      return {
        visible: !settings.hidden,
        source: settings.source,
        activeSource,
        sources: providers.snapshot.sources,
        status: top?.status || 'idle',
      };
    },
    command: async (action, value) => {
      if (action === 'source') setSource(value);
      else if (action === 'hide') hidePet();
      else if (action === 'show') { if (typeof value === 'string' && value) setSource(value); showPet(); }
      else if (action === 'open') { if (typeof value === 'string' && value && value !== 'dsh') await openBundle(value); else await agentAction({ action: 'home' }); }
      else if (action === 'manage') openManagerWindow(value === 'bot' ? 'bot' : 'connectors');
      else if (action === 'reset') { resetPosition(); showPet(); }
    },
  });
  refreshTimer = setInterval(() => {
    providers.refresh().then(snapshot => {
      notch?.send();
      return botService?.onSnapshot(snapshot || providers.snapshot);
    }).catch(() => {});
  }, 1500);
  const shortcut = process.env.DSH_COMPANION_SHORTCUT || 'Alt+Space';
  const shortcutOk = globalShortcut.register(shortcut, () => showPet(DIRECT_CHAT_SOURCES.has(settings.source)));
  writeFileSync(path.join(dataDir, 'desktop-runtime.json'), JSON.stringify({ pid: process.pid, hostPid, shortcut, shortcutRegistered: shortcutOk, ready: true, mode: 'multi-agent', project: path.dirname(__dirname) }), { mode: 0o600 });
  process.stdout.write('[companion] pet ready\n');
  // A photographic character is illegible at menu-bar size, so the tray uses a
  // monochrome template glyph that macOS tints for light and dark bars.
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, '../assets/trayTemplate.png'));
  if (trayIcon.isEmpty()) throw new Error('桌宠图标无法读取');
  trayIcon.addRepresentation({ scaleFactor: 2, buffer: readFileSync(path.join(__dirname, '../assets/trayTemplate@2x.png')) });
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip('小鑫 · ' + shortcut);
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate([{ label: '显示小鑫', click: () => showPet() }, ...menuTemplate()])));
  tray.on('click', () => notch?.expand(true));
  // Independent lifetime: a disconnected Agent does not close the pet.
  screen.on('display-removed', () => { positionPet(currentPosition()); save(); });
}).catch(error => { process.stderr.write('[companion] ' + (token ? error.message.replaceAll(token, '[redacted]') : error.message) + '\n'); app.exit(1); });
process.on('message', message => {
  if (message?.type !== 'companion:desktop' || !win || win.isDestroyed()) return;
  try {
    applyDesktop(message.command, message.value);
    process.send?.({ type: 'companion:desktop-result', id: message.id, state: desktopState() });
  } catch { process.send?.({ type: 'companion:desktop-result', id: message.id, error: '桌宠操作失败，请重试' }); }
});
app.on('before-quit', () => {
  quitting = true;
  localSpeech.stopSpeaking();
  clearInterval(dragTimer);
  clearInterval(refreshTimer);
  commandServer?.close();
  notch?.destroy();
  Promise.resolve(botService?.stop()).catch(() => {});
  if (managerWin && !managerWin.isDestroyed()) managerWin.destroy();
  globalShortcut.unregisterAll();
  tray?.destroy();
});
app.on('window-all-closed', () => app.quit());

}
