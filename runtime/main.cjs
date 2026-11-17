'use strict';
/** Transparent desktop companion focused on multi-agent notifications and jumping back to the source session. */
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, shell, screen } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { execFile } = require('node:child_process');
const { createServer } = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { Providers } = require('./providers.cjs');
const { createNotch } = require('./notch.cjs');
const { layoutPet } = require('./placement.cjs');
const { ConnectorRegistry } = require('../connectors/registry.cjs');
const { CATALOG_BY_ID } = require('../connectors/catalog.cjs');
const { LocalSpeech } = require('./local-speech.cjs');
const { AutoStartManager } = require('./autostart.cjs');
const { jumpToSession } = require('./session-jump.cjs');

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
let win, managerWin, tray, notch, commandServer, refreshTimer, quitting = false, dragStart, dragTimer, placement;
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

function desktopState() {
  return {
    visible: win.isVisible(),
    source: settings.source,
    notchExpanded: notch?.isExpanded() ?? false,
    mini: Boolean(settings.mini),
    petScale: petScale(),
    controlOnly: Boolean(settings.controlOnly),
    shortcut: process.env.DSH_COMPANION_SHORTCUT || 'Alt+Space',
  };
}

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
    { label: '管理 AI Agent...', click: () => openManagerWindow() },
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
        autoStart.setEnabled(!autoStart.isEnabled()).then(() => {
          if (managerWin && !managerWin.isDestroyed()) {
            managerWin.webContents.send('companion:autostart-updated', { enabled: autoStart.isEnabled() });
          }
        }).catch(() => {});
      },
    },
    { type: 'separator' },
    { label: '退出小鑫', click: () => app.quit() },
  ];
}

function setSource(source) {
  if (!validSources().includes(source)) throw new Error('来源无效');
  settings.source = source;
  save(); win?.webContents.send('companion:mode', mode()); notch?.send();
}

function openBundleById(bundleId, targetPath = '') {
  if (!bundleId) return Promise.reject(new Error('应用配置无效'));
  const args = targetPath ? ['-b', bundleId, targetPath] : ['-b', bundleId];
  return new Promise((resolve, reject) => execFile('/usr/bin/open', args, error => (
    error ? reject(new Error('无法打开目标应用')) : resolve({ opened: true })
  )));
}

function openBundle(providerId, targetPath = '') {
  const entry = CATALOG_BY_ID[providerId];
  if (!entry || !entry.bundleId) return Promise.reject(new Error('应用配置无效'));
  return openBundleById(entry.bundleId, targetPath);
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

function isDshOnline() {
  return Boolean(providers.snapshot?.sources?.find(row => row.id === 'dsh')?.connected);
}

const DSH_INTERACTIVE_ACTIONS = new Set([
  'create', 'prompt', 'conversation', 'cancel', 'models', 'selectModel', 'skills', 'files',
]);

async function jumpForAction(body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const items = providers.snapshot?.items || [];
  const matched = sessionId ? items.find(row => row.sessionId === sessionId) : null;
  const prefixIdx = sessionId.indexOf(':');
  const sessionProvider = prefixIdx > 0 ? sessionId.slice(0, prefixIdx) : '';
  const fallbackSource = settings.source !== 'auto'
    ? settings.source
    : (items[0]?.provider || (isDshOnline() ? 'dsh' : registry.enabledIds().find(id => id !== 'dsh') || 'dsh'));
  const provider = matched?.provider || sessionProvider || fallbackSource;

  if (provider === 'dsh') {
    const rawId = sessionId.startsWith('dsh:') ? sessionId.slice(4) : sessionId;
    return openDsh(rawId ? { action: 'focus', sessionId: rawId } : { action: 'home' });
  }

  const targetItem = matched || { sessionId, provider, workspacePath: '' };
  return jumpToSession(targetItem, {
    entry: CATALOG_BY_ID[provider] || null,
    openDsh: id => openDsh(id ? { action: 'focus', sessionId: id } : { action: 'home' }),
    openExternal: url => shell.openExternal(url),
    openBundle: (bundleId, targetPath) => openBundleById(bundleId, targetPath),
    openPath: targetPath => shell.openPath(targetPath).then(err => {
      if (err) throw new Error(err);
      return { opened: true };
    }),
  });
}

async function agentAction(body) {
  if (body.action === 'list') {
    await providers.refresh();
    return providers.list(settings.source);
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
    return {
      connected: dshConnected,
      dshConnected,
      speechAvailable: Boolean(dshSpeech || (dshConnected && localSpeech.hasRecognizer())),
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
  if (['focus', 'home'].includes(body.action)) {
    return jumpForAction(body);
  }

  const sessionId = String(body.sessionId || '');
  const prefixIdx = sessionId.indexOf(':');
  const sessionProvider = prefixIdx > 0 ? sessionId.slice(0, prefixIdx) : '';
  if (sessionProvider && isReadOnlyConnector(sessionProvider)) {
    throw new Error(`请在 ${CATALOG_BY_ID[sessionProvider].label} 中继续此任务`);
  }
  if (!sessionId && isReadOnlyConnector(settings.source)) {
    throw new Error(`请在 ${CATALOG_BY_ID[settings.source].label} 中新建任务`);
  }
  if (DSH_INTERACTIVE_ACTIONS.has(body.action)) {
    const rawId = sessionId.startsWith('dsh:') ? sessionId.slice(4) : sessionId;
    return rpc(rawId && rawId !== sessionId ? { ...body, sessionId: rawId } : body);
  }
  return rpc(body);
}

function applyDesktop(command, value) {
  switch (command) {
    case 'state': break;
    case 'show': showPet(); break;
    case 'hide': hidePet(); break;
    case 'mini': setMini(value === true); break;
    case 'scale': if ([.7, .8, .9, 1, 1.1, 1.2].includes(value)) setPetScale(value); else throw new Error('大小无效'); break;
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
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('DSH 地址无效');
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
  win?.webContents.send('companion:mode', mode());
  win?.webContents.send('companion:updated');
  notch?.send();
  if (managerWin && !managerWin.isDestroyed()) managerWin.webContents.send('companion:connectors-updated', list);
  return list;
}

function openManagerWindow() {
  notch?.expand(false);
  if (process.platform === 'darwin') app.focus({ steal: true });
  if (managerWin && !managerWin.isDestroyed()) {
    managerWin.show();
    managerWin.focus();
    managerWin.webContents.send('companion:connectors-updated', registry.detectAll());
    managerWin.webContents.send('companion:autostart-updated', { enabled: autoStart.isEnabled() });
    return;
  }
  managerWin = new BrowserWindow({
    width: 640,
    height: 660,
    minWidth: 480,
    minHeight: 460,
    title: '小鑫 · AI Agent 管理',
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
  });
  managerWin.loadFile(path.join(__dirname, 'manager.html')).catch(() => {});
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
  if (action === 'autostart-state') return { enabled: autoStart.isEnabled() };
  if (action === 'autostart') {
    await autoStart.setEnabled(Boolean(body?.enabled));
    const state = { enabled: autoStart.isEnabled() };
    if (managerWin && !managerWin.isDestroyed()) {
      managerWin.webContents.send('companion:autostart-updated', state);
    }
    return state;
  }
  throw new Error('不支持的操作');
});

ipcMain.handle('companion:action', async (event, body) => {
  trusted(event);
  if (!body || !['list', 'focus', 'home', 'info', 'create', 'prompt', 'cancel', 'models', 'selectModel', 'skills', 'files', 'hear', 'speak', 'speak-stop', 'conversation'].includes(body.action)) {
    throw new Error('不支持的操作');
  }
  return agentAction(body);
});

ipcMain.handle('companion:window', (event, action, value) => {
  trusted(event);
  if (action === 'menu') Menu.buildFromTemplate(menuTemplate()).popup({ window: win });
  else if (action === 'passthrough' && typeof value === 'boolean') win.setIgnoreMouseEvents(value, { forward: true });
  else if (action === 'placement') return mode();
  else if (action === 'hide') hidePet();
  else if (action === 'source') setSource(value);
  else if (action === 'manage') openManagerWindow();
  else if (action === 'drag-start') {
    clearInterval(dragTimer);
    dragStart = { cursor: screen.getCursorScreenPoint(), position: currentPosition(), moved: false };
    win.setIgnoreMouseEvents(false);
    dragTimer = setInterval(updateDrag, 16);
  }
  else if (action === 'drag-end') endDrag();
  else if (action === 'animation' && ['idle', 'running', 'waiting', 'blocked', 'ready'].includes(value)) {
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
  placement = layout({
    x: Number.isFinite(settings.petX) ? settings.petX : Number.isFinite(settings.x) ? settings.x + 70 : area.x + area.width - 194,
    y: Number.isFinite(settings.petY) ? settings.petY : Number.isFinite(settings.y) ? settings.y + 85 : area.y + area.height - 159,
  });
  win = new BrowserWindow({
    ...placement.bounds,
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
  await providers.refresh().catch(() => {});

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
      else if (action === 'open') { await jumpForAction({ sessionId: typeof value === 'string' ? value : '' }); }
      else if (action === 'manage') openManagerWindow();
      else if (action === 'reset') { resetPosition(); showPet(); }
    },
  });

  let lastSnapshotSig = '';
  refreshTimer = setInterval(() => {
    providers.refresh().then(snapshot => {
      notch?.send();
      const sig = JSON.stringify((snapshot?.items || []).map(i => [i.sessionId, i.status, i.lastSeq, i.detail, i.updatedAt]));
      if (sig !== lastSnapshotSig) {
        lastSnapshotSig = sig;
        if (win && !win.isDestroyed()) win.webContents.send('companion:updated');
      }
    }).catch(() => {});
  }, 1500);

  const shortcut = process.env.DSH_COMPANION_SHORTCUT || 'Alt+Space';
  const shortcutOk = globalShortcut.register(shortcut, () => showPet(isDshOnline()));
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
  if (managerWin && !managerWin.isDestroyed()) managerWin.destroy();
  globalShortcut.unregisterAll();
  tray?.destroy();
});

app.on('window-all-closed', () => app.quit());
}
