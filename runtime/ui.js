/** Floating DSH companion controls: Quick Chat, activity notices and voice dictation. */
import { recordingToWave } from './audio.js';
import { createActivityNoticeTracker } from './activity-notices.js';

const native = window.companion;
const $ = id => document.getElementById(id);
const pet = $('pet');
const character = $('character');
const panel = $('panel');
const list = $('activity-list');
const empty = $('empty');
const video = $('animation');
const feedback = $('feedback');
const quickInput = $('quick-input');
const voiceButton = $('tool-voice');
const composeButton = $('tool-compose');
const activitiesButton = $('tool-activities');
const miniPill = $('mini-pill');
const labels = { running: '正在工作', waiting: '需要你确认', blocked: '遇到问题', ready: '已完成', cancelled: '已取消', idle: '空闲' };
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};
function makeStatusGlyph(status) {
  const glyph = el('span', 'activity-glyph');
  glyph.setAttribute('aria-hidden', 'true');
  if (status === 'running') {
    glyph.append(el('span', 'activity-spinner'));
    return glyph;
  }
  const svg = svgEl('svg', { viewBox: '0 0 16 16' });
  if (status === 'ready') {
    svg.append(svgEl('path', { d: 'M4.3 8.2 6.8 10.7 11.7 5.6' }));
  } else if (status === 'waiting') {
    svg.append(svgEl('path', { d: 'M6.2 6a1.9 1.9 0 0 1 3.7.5c0 1.3-1.9 1.7-1.9 3' }));
    svg.append(svgEl('circle', { cx: '8', cy: '12.1', r: '0.75', fill: 'currentColor', stroke: 'none' }));
  } else if (status === 'blocked') {
    svg.append(svgEl('path', { d: 'M8 4.4v4.7' }));
    svg.append(svgEl('circle', { cx: '8', cy: '11.8', r: '0.75', fill: 'currentColor', stroke: 'none' }));
  } else if (status === 'cancelled') {
    svg.append(svgEl('path', { d: 'm5.4 5.4 5.2 5.2m0-5.2-5.2 5.2' }));
  } else {
    svg.append(svgEl('path', { d: 'M5.2 8h5.6' }));
  }
  glyph.append(svg);
  return glyph;
}
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const iconUrl = (id = 'dsh') => {
  const safeId = typeof id === 'string' && /^[a-z0-9-]+$/.test(id) ? id : 'dsh';
  return native ? `../assets/icons/${safeId}.png` : `/companion/icon-${safeId}`;
};
function bindIconFallback(img) {
  if (img.dataset.fallbackBound) return;
  img.dataset.fallbackBound = '1';
  img.addEventListener('error', () => {
    const fallback = iconUrl('dsh');
    if (!img.src.endsWith('/dsh.png') && !img.src.endsWith('/icon-dsh')) img.src = fallback;
  });
}
function makeProviderIcon(provider = 'dsh', className = 'activity-provider-icon') {
  const img = el('img', className);
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  img.decoding = 'async';
  bindIconFallback(img);
  img.src = iconUrl(provider);
  return img;
}
const DIRECT_CHAT_SOURCES = new Set(['auto', 'dsh', 'claude', 'codex', 'opencode']);
const TARGET_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  dsh: 'DSH',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  zcode: 'ZCode',
  workbuddy: 'WorkBuddy',
  'workbuddy-ai': 'WorkBuddy AI',
  kiro: 'Kiro',
  trae: 'Trae',
  'trae-cn': 'Trae CN',
  'qoder-cn': 'Qoder CN',
  qoder: 'Qoder',
  windsurf: 'Windsurf',
  codebuddy: 'CodeBuddy',
  'codebuddy-cn': 'CodeBuddy CN',
  copilot: 'GitHub Copilot',
  'gemini-cli': 'Gemini CLI',
  'qwen-code': 'Qwen Code',
  droid: 'Droid',
  cline: 'Cline',
};
let source = 'auto', dshConnected = false, localEngine = 'claude', knownSources = [], sourceInitialized = false;
let chatTargets = [];
let items = [], current, animationKey, polling = false, noticeTimer, drag, suppressClick = false;

/* -------------------------------------------------------------------------- */
/* Preferences survive an Electron restart. The host's seen cursor stays      */
/* authoritative: dismissal/mute are display-only and never touch DSH data.   */
/* -------------------------------------------------------------------------- */
const PREFS_KEY = 'dsh-companion:prefs:v1';
const defaultPrefs = { firstAwakeSeen: false, muted: [], dismissed: [], activeSessionId: null, activeSessionTitle: '', cwd: '', cwdByAgent: {}, model: null, targetAgent: null, stackCollapsed: true, dockCollapsed: true };
let prefs;
try { prefs = { ...defaultPrefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
catch { prefs = { ...defaultPrefs }; }
if (!prefs.cwdByAgent || typeof prefs.cwdByAgent !== 'object' || Array.isArray(prefs.cwdByAgent)) {
  prefs.cwdByAgent = {};
}
let targetAgent = prefs.targetAgent || 'claude';
let hostHomeDir = '';
let targetSwitchEpoch = 0;
let currentCwd = (typeof prefs.cwdByAgent[targetAgent] === 'string' && prefs.cwdByAgent[targetAgent])
  || prefs.cwd
  || '';
if (currentCwd && !prefs.cwdByAgent[targetAgent] && !isBareHomeDir(currentCwd)) {
  prefs.cwdByAgent[targetAgent] = currentCwd;
}
let activeSessionTitle = prefs.activeSessionTitle || '';
let workspaceOptions = [];
let extraWorkspaceOptions = [];
let sessionOptions = [];
let contextMode = 'agent';
let contextExtraOpen = false;
let scanningExtra = false;
function normalizeDirPath(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return '';
  const trimmed = dirPath.trim();
  if (!trimmed) return '';
  if (trimmed === '/') return '/';
  return trimmed.replace(/[/\\]+$/, '') || '/';
}
function isBareHomeDir(dirPath) {
  const norm = normalizeDirPath(dirPath);
  if (!norm) return false;
  if (norm === '/') return true;
  if (hostHomeDir && norm === normalizeDirPath(hostHomeDir)) return true;
  if (/^\/Users\/[^/]+$/i.test(norm)) return true;
  if (/^\/home\/[^/]+$/i.test(norm)) return true;
  if (/^[A-Za-z]:[\\/]Users[\\/][^\\/]+$/i.test(norm)) return true;
  return false;
}
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } }
function setActiveCwd(nextCwd, agent = targetAgent, { persistAgent = true } = {}) {
  currentCwd = nextCwd || '';
  prefs.cwd = currentCwd;
  if (persistAgent && agent && currentCwd) {
    prefs.cwdByAgent[agent] = currentCwd;
  }
  savePrefs();
}
// Persist the quiet collapsed dock as the boot state. An Electron restart must
// come back to the pill, never to a panel that happened to be open on exit.
savePrefs();
const muted = new Set(Array.isArray(prefs.muted) ? prefs.muted : []);
const dismissed = new Set(Array.isArray(prefs.dismissed) ? prefs.dismissed : []);
const expanded = new Set();
const persistSets = () => {
  prefs.muted = [...muted].slice(-200);
  prefs.dismissed = [...dismissed].slice(-200);
  savePrefs();
};

const READY_LIFETIME = 12_000;
const readyShownAt = new Map();
const readyKey = item => `${item.sessionId}:${item.lastSeq ?? -1}`;
const expiresAt = item => item.status === 'ready' ? (readyShownAt.get(item.sessionId) ?? 0) + READY_LIFETIME : Infinity;
const dismissExpired = rows => {
  const now = Date.now();
  const live = [];
  for (const item of rows) {
    const key = readyKey(item);
    if (dismissed.has(key)) { readyShownAt.delete(item.sessionId); continue; }
    if (item.status === 'ready' && expiresAt(item) <= now) {
      dismissed.add(key); readyShownAt.delete(item.sessionId); persistSets(); continue;
    }
    live.push(item);
  }
  const seen = new Set(live.map(item => item.sessionId));
  for (const id of readyShownAt.keys()) if (!seen.has(id)) readyShownAt.delete(id);
  return live;
};
const trackActivityNotices = createActivityNoticeTracker();
let sending = false, recorder, mediaStream, recordingTimer, voiceConversation = false, voiceEpoch = 0, voiceSessionId;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let pendingImages = [], quoted = null, transcriptSessionId = null, contextSessionId = null, fileQueryTimer;

async function action(action, body = {}) {
  if (native) return native.action({ ...body, action });
  const response = await fetch('/api/companion/action', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, action }) });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error ?? 'DSH 暂时未连接');
  return result;
}
let retryAction;
function showFeedback(message, isError = false, retry) {
  $('feedback-text').textContent = message;
  feedback.dataset.error = String(isError);
  feedback.classList.toggle('visible', Boolean(message));
  retryAction = retry ?? null;
  $('feedback-retry').hidden = !retry;
  $('feedback-close').hidden = !message;
}
/* A notice only pins the capsule for a few seconds. It must never fan the
   activity stack out: the collapsed dock is a stable resting state, and the
   feedback strip is exempt from the collapsed suppression so it stays readable. */
function notice() { clearTimeout(noticeTimer); pet.classList.add('pinned'); noticeTimer = setTimeout(() => pet.classList.remove('pinned'), 6000); }
function cleanErrorMessage(message) {
  return String(message || 'DSH 暂时未连接').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim() || 'DSH 暂时未连接';
}
function report(error, retry) { showFeedback(cleanErrorMessage(error?.message), true, retry); notice(); }
function run(fn) { Promise.resolve().then(fn).catch(report); }

/* -------------------------------------------------------------------------- */
/* Hover-to-reveal dock. `expanded` is derived from the existing open-flags so  */
/* every path that opens a panel keeps working unchanged. `revealed` comes only */
/* from the pointer, an explicit pin, or an open panel: polling, new notices,   */
/* first-run onboarding and status changes never touch those classes, so the    */
/* quiet collapsed state persists indefinitely.                                 */
/* -------------------------------------------------------------------------- */
function syncView() {
  const open = ['compose-open', 'activities-open', 'transcript-open', 'context-open']
    .some(name => pet.classList.contains(name));
  if (pet.classList.contains('expanded') !== open) pet.classList.toggle('expanded', open);
  // A focus ring on a capsule button must not reveal anything behind the dock.
  const revealed = open || pet.classList.contains('hovering') || pet.classList.contains('pinned');
  if (pet.classList.contains('revealed') !== revealed) pet.classList.toggle('revealed', revealed);
}
new MutationObserver(syncView).observe(pet, { attributes: true, attributeFilter: ['class'] });
// Never restore a panel that was open when Electron exited.
pet.classList.remove('show', 'compose-open', 'activities-open', 'transcript-open', 'context-open', 'hovering', 'pinned', 'revealed', 'expanded');
syncView();

/* A new notice only refreshes the bell's count. Fanning cards out on every
   poll would destroy the collapsed state Codex keeps while work is pending. */
function pingBadge() {
  const badge = $('activity-badge');
  badge.classList.remove('ping');
  void badge.offsetWidth;
  badge.classList.add('ping');
}
function syncActivitiesButton() {
  const open = pet.classList.contains('activities-open');
  activitiesButton.setAttribute('aria-pressed', String(open));
  activitiesButton.setAttribute('aria-label', open ? '收起活动' : '显示活动');
  activitiesButton.title = open ? '收起活动' : '显示活动';
}
function setActivitiesOpen(nextOpen) {
  const open = Boolean(nextOpen);
  pet.classList.toggle('activities-open', open);
  pet.classList.remove('show');
  if (open) {
    closeContext();
    closeTranscript();
  } else {
    prefs.stackCollapsed = true;
    savePrefs();
  }
  syncActivitiesButton();
  syncView();
  renderActivities();
}
function showQuickChat() {
  pet.classList.add('compose-open');
  pet.classList.remove('show');
  closeTranscript();
  closeContext();
  composeButton.setAttribute('aria-expanded', 'true');
  syncView();
  setTimeout(() => quickInput.focus(), 30);
}

async function animation(status) {
  const key = ['running','waiting','blocked','ready'].includes(status) ? status : 'idle';
  if (animationKey === key) return;
  const src = native ? await native.window('animation', key) : '/companion/animation-' + key;
  animationKey = key; video.src = src;
  if (!reduced.matches) await video.play().catch(() => {});
}
video.addEventListener('loadeddata', () => { if (reduced.matches) video.pause(); });
reduced.addEventListener('change', () => { if (reduced.matches) video.pause(); else video.play().catch(() => {}); });

/* -------------------------------------------------------------------------- */
/* Activity cards: Codex Pet's notice actions (open / reply / stop / mute /   */
/* dismiss / expand) plus a truthful approval hint. DSH approvals are decided */
/* by a same-process waterfall in the Host, so an out-of-process pet must not */
/* pretend it can approve them; it shows the real tool name instead.          */
/* -------------------------------------------------------------------------- */
function visibleActivities(rows) {
  return rows.filter(item => ['waiting','blocked','running'].includes(item.status) || item.status === 'ready' && item.unread);
}
function dismissItem(item) {
  const key = readyKey(item);
  dismissed.add(key);
  readyShownAt.delete(item.sessionId);
  items = items.filter(entry => readyKey(entry) !== key);
  current = items[0];
  persistSets(); renderActivities();
}
function toggleMute(item) {
  if (muted.has(item.sessionId)) muted.delete(item.sessionId); else muted.add(item.sessionId);
  persistSets(); renderActivities();
}
async function stopSession(item) {
  await action('cancel', { sessionId: item.sessionId });
  showFeedback('已发送停止请求');
  await poll();
}
/** Bind once at creation so a rebuild can restore an open draft. */
function bindFollowUp(card, item) {
  const form = card.querySelector('.activity-followup');
  const input = form.querySelector('input');
  form.onsubmit = event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; form.hidden = true;
    run(() => sendPrompt(text, { sessionId: item.sessionId }));
  };
  return form;
}
function openFollowUp(card, item) {
  const form = bindFollowUp(card, item);
  form.hidden = false;
  form.querySelector('input').focus();
}
/* Collapsed banners carry ONE short human line. Host errors often arrive as a
   raw `429: {"message":...}` blob; keep the status code plus the readable
   sentence, and leave the untouched payload for the hover/expanded layer. */
function shortDetail(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  // Splitting on ":" is unsafe here: timestamps like "12:33:46" appear inside
  // the message. Grab the first Chinese sentence instead, which is the part a
  // person actually reads; fall back to the raw message for English-only errors.
  const readable = text => (String(text).match(/[\u4e00-\u9fa5][^，。；!?]*/) || [])[0] || String(text).slice(0, 48);
  const coded = raw.match(/^(\d{3})\s*:\s*\{[\s\S]*?"message"\s*:\s*"([^"]+)"/);
  if (coded) return `${coded[1]}: ${readable(coded[2])}`;
  const message = raw.match(/"message"\s*:\s*"([^"]+)"/);
  if (message) return readable(message[1]);
  return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
}
function makeCard(item, { stacked = false, stackLayer = 0, stackTotal = 1 } = {}) {
  const id = item.sessionId;
  const card = el('div', 'activity-card');
  card.dataset.status = item.status;
  card.dataset.sessionId = id;
  card.dataset.expanded = String(!stacked && expanded.has(id));
  if (stacked) card.dataset.stackLayer = String(stackLayer);
  if (muted.has(id)) card.dataset.muted = 'true';

  const main = el('button', 'activity-main');
  main.type = 'button';
  main.setAttribute(
    'aria-label',
    stacked
      ? `展开全部 ${stackTotal} 项活动，当前最新：${item.title}`
      : `${item.title}，${item.detail || labels[item.status] || '打开会话'}`,
  );
  if (stacked) main.title = `点击展开全部 ${stackTotal} 项活动`;
  const avatar = el('span', 'activity-avatar');
  avatar.append(makeProviderIcon(item.provider || 'dsh'));
  main.append(avatar);
  const copy = el('span', 'activity-copy');
  const head = el('span', 'activity-head');
  head.append(makeStatusGlyph(item.status));
  head.append(el('span', 'activity-title', item.title || (item.providerLabel ? `${item.providerLabel} · 会话` : '未命名会话')));
  head.append(el('span', 'activity-status', item.statusText || labels[item.status] || ''));
  if (stacked && stackLayer === 0 && stackTotal > 1) {
    head.append(el('span', 'activity-stack-count', `${stackTotal} 项 ⌄`));
  }
  copy.append(head);
  const openFallback = item.provider === 'dsh' ? '打开 DSH 会话' : '打开会话';
  const fallback = item.detail || labels[item.status] || openFallback;
  copy.append(el('span', 'activity-detail', shortDetail(fallback) || labels[item.status] || openFallback));
  copy.append(el('span', 'activity-detail-full', fallback));
  if (['running', 'waiting'].includes(item.status)) {
    const progress = item.progress;
    const row = el('span', 'activity-progress-row');
    const track = el('span', 'activity-progress');
    track.setAttribute('role', 'progressbar');
    if (progress && Number.isInteger(progress.total) && progress.total > 0 && Number.isInteger(progress.completed)) {
      const completed = Math.max(0, Math.min(progress.total, progress.completed));
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', String(progress.total));
      track.setAttribute('aria-valuenow', String(completed));
      track.setAttribute('aria-valuetext', `待办完成 ${completed} / ${progress.total} 项`);
      const fill = el('span', 'activity-progress-fill');
      fill.style.width = `${completed / progress.total * 100}%`;
      track.append(fill);
      row.append(track, el('span', 'activity-progress-count', `${completed}/${progress.total}`));
      copy.append(row);
    } else if (item.status === 'running') {
      track.dataset.indeterminate = 'true';
      track.setAttribute('aria-valuetext', '任务正在进行，暂无可量化的待办');
      row.append(track); copy.append(row);
    }
  }
  main.append(copy);
  main.addEventListener('click', () => {
    if (stacked) {
      prefs.stackCollapsed = false;
      savePrefs();
      renderActivities();
      return;
    }
    run(() => openDsh(item));
  });
  card.append(main);

  if (item.pending?.length) {
    const approval = el('div', 'activity-approval');
    for (const pending of item.pending.slice(0, 2)) {
      const reason = pending.reason ? ` · ${pending.reason}` : '';
      approval.append(el('span', 'approval-reason', `需要批准 ${pending.toolName || '操作'}${reason}`));
    }
    const handle = el('button', 'approval-open', item.provider === 'dsh' ? '在 DSH 中处理' : '立即查看');
    handle.type = 'button';
    handle.addEventListener('click', event => { event.stopPropagation(); run(() => openDsh(item)); });
    approval.append(handle);
    card.append(approval);
  }

  const actions = el('div', 'activity-actions');
  const addAction = (name, text, fn) => {
    const button = el('button', 'activity-action', text);
    button.type = 'button'; button.dataset.act = name; button.title = text;
    button.addEventListener('click', event => { event.stopPropagation(); run(fn); });
    actions.append(button);
    return button;
  };
  addAction('open', '打开', () => openDsh(item));
  addAction('expand', expanded.has(id) ? '收起' : '展开', () => {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    renderActivities();
  });
  if (item.capabilities?.reply !== false) addAction('reply', '回复', () => openFollowUp(card, item));
  if (item.capabilities?.cancel !== false && ['running', 'waiting'].includes(item.status)) addAction('stop', '停止', () => stopSession(item));
  addAction('mute', muted.has(id) ? '取消静音' : '静音', () => toggleMute(item));
  addAction('dismiss', '关闭', () => dismissItem(item));
  card.append(actions);

  const followup = el('form', 'activity-followup');
  followup.hidden = true;
  const input = el('input');
  input.placeholder = '继续追问…'; input.setAttribute('aria-label', '继续追问');
  const send = el('button', null, '↑');
  send.type = 'submit'; send.setAttribute('aria-label', '发送');
  followup.append(input, send);
  card.append(followup);
  bindFollowUp(card, item);
  return card;
}
let renderKey = '';
function renderActivities() {
  // Polling rebuilds the whole list every 3.5s. Without this signature a half
  // typed "Reply" or an open follow-up form is destroyed mid-keystroke.
  const signature = JSON.stringify([
    items.map(item => [item.sessionId, item.lastSeq, item.status, item.detail, item.unread, item.pending?.length ?? 0]),
    [...muted], [...expanded], [...dismissed], prefs.stackCollapsed, prefs.activeSessionId, prefs.firstAwakeSeen,
    $('transcript').hidden, pet.dataset.bubble, pet.classList.contains('activities-open'),
  ]);
  if (signature === renderKey) return;
  renderKey = signature;
  const drafts = new Map();
  list.querySelectorAll('.activity-card').forEach(card => {
    const input = card.querySelector('.activity-followup input');
    if (input?.value) drafts.set(card.dataset.sessionId, { text: input.value, open: !card.querySelector('.activity-followup').hidden });
    card.remove();
  });
  empty.style.display = items.length ? 'none' : (pet.classList.contains('activities-open') ? 'block' : 'none');
  empty.textContent = '暂无需要关注的活动';
  // Codex's "Hi, I'm {petName}" is an empty-desk onboarding card, not a second
  // notice competing with real activities for the same 480px window.
  $('first-awake').hidden = Boolean(prefs.firstAwakeSeen) || items.length > 0;

  const collapsed = prefs.stackCollapsed && items.length > 1;
  list.classList.toggle('is-stacked', collapsed);
  const stack = $('activity-stack');
  stack.hidden = items.length <= 1 || collapsed;
  if (!stack.hidden) {
    stack.textContent = `收起堆叠（${items.length} 项）⌃`;
    stack.setAttribute('aria-expanded', 'true');
  }
  const shown = collapsed ? items.slice(0, 3) : items;
  shown.forEach((item, index) => {
    const card = makeCard(item, { stacked: collapsed, stackLayer: index, stackTotal: items.length });
    const draft = drafts.get(item.sessionId);
    if (draft && !collapsed) {
      const form = card.querySelector('.activity-followup');
      form.hidden = !draft.open;
      form.querySelector('input').value = draft.text;
    }
    list.append(card);
  });

  const badge = $('activity-badge');
  badge.hidden = items.length === 0;
  badge.textContent = items.length > 99 ? '99+' : String(items.length);
  badge.setAttribute('aria-label', `${items.length} 项待处理活动`);
  const placement = pet.dataset.bubble;
  if (placement === 'above') {
    // CSS anchors the panel's bottom edge to the character and caps its height at
    // the space that actually exists, so no card-height estimate is needed here.
    pet.dataset.panelOrder = 'controls-last';
  } else {
    pet.dataset.panelOrder = 'controls-first';
    pet.style.setProperty('--panel-top', 'calc(var(--pet-top,0px) + 138px)');
  }
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const response = await action('list');
    knownSources = Array.isArray(response.sources) ? response.sources : knownSources;
    dshConnected = response.sources ? Boolean(response.sources.find(row => row.id === 'dsh')?.connected) : false;
    const isChatSource = DIRECT_CHAT_SOURCES.has(source) || chatTargets.some(t => t.id === source);
    const isDirectVoice = DIRECT_CHAT_SOURCES.has(source) || chatTargets.some(t => t.id === source && t.mode === 'direct');
    const readOnlyLabel = !isChatSource ? (knownSources.find(row => row.id === source)?.label || source) : '';
    const activeTargetLabel = getTargetInfo(targetAgent).label;
    composeButton.disabled = false;
    composeButton.title = readOnlyLabel
      ? `打开 ${readOnlyLabel}`
      : (dshConnected && targetAgent === 'dsh')
        ? '新建 DSH 聊天'
        : `向 ${activeTargetLabel} 发消息`;
    composeButton.setAttribute('aria-label', composeButton.title);
    voiceButton.disabled = !isDirectVoice;
    const next = visibleActivities(response.items ?? []);
    // Stamp the first moment a card is offerable, so its lifetime is counted from
    // when the user could actually see it rather than from the session's start.
    const now = Date.now();
    for (const item of next) if (item.status === 'ready' && !readyShownAt.has(item.sessionId)) readyShownAt.set(item.sessionId, now);
    items = dismissExpired(next);
    current = items[0];
    renderActivities();
    const status = current?.status ?? 'idle';
    document.body.dataset.status = status;
    syncView();
    $('dot').hidden = !current;
    character.setAttribute('aria-label', current ? `小鑫：${items.length} 项活动，${current.title}，双击打开` : '小鑫：拖动移动，点击查看活动，双击打开工具');
    await animation(status);
    // Keep the collapsed capsule on screen and just pulse the count, matching
    // Codex Pet's "1 notification, still collapsed" state.
    if (trackActivityNotices(items.filter(item => !muted.has(item.sessionId))).length) pingBadge();
  } finally { polling = false; }
}

async function openDsh(item = current) {
  if (item?.sessionId?.startsWith('local:')) {
    await openTranscript(item.sessionId);
    return;
  }
  if (!item && !dshConnected && DIRECT_CHAT_SOURCES.has(source)) {
    showQuickChat();
    return;
  }
  await action(item ? 'focus' : 'home', item ? { sessionId: item.sessionId } : {});
  setActivitiesOpen(false);
  character.blur();
  await poll();
}
/**
 * Send a prompt. `reuseActive` is the Quick Chat "Restore / follow up" path;
 * voice dictation deliberately keeps minting its own session so that behaviour
 * is unchanged. `content` carries image parts selected through Add context.
 */
async function sendPrompt(text, { sessionId: existingSessionId, trackReply = false, content: extra = [], quoted: quotedText, reuseActive = false } = {}) {
  const request = text.trim();
  if ((!request && !extra.length) || sending) return;
  sending = true;
  $('quick-send').disabled = true;
  showFeedback('正在发送…');
  const options = { sessionId: existingSessionId, trackReply, content: extra, quoted: quotedText, reuseActive };
  const promptTarget = existingSessionId
    ? (existingSessionId.startsWith('local:')
      ? existingSessionId.split(':')[1]
      : (existingSessionId.startsWith('launch:') ? existingSessionId.slice(7) : 'dsh'))
    : targetAgent;
  try {
    let sessionId = existingSessionId ?? (reuseActive ? prefs.activeSessionId : null);
    if (!sessionId) {
      const requestedId = `session-${crypto.randomUUID()}`;
      const created = await action('create', {
        sessionId: requestedId,
        targetAgent: promptTarget,
        cwd: currentCwd || undefined,
      });
      sessionId = created?.sessionId || requestedId;
    }
    const isLaunchSession = sessionId.startsWith('launch:')
      || (!existingSessionId && getTargetInfo(promptTarget).mode === 'launch' && !/^@(?:claude|codex|opencode|dsh)\b/i.test(request));
    const baselineSeq = trackReply && !isLaunchSession ? (await action('conversation', { sessionId })).lastSeq ?? -1 : undefined;
    const parts = [];
    if (quotedText) parts.push({ type: 'text', text: `[引用] ${quotedText.slice(0, 400)}` });
    if (request) parts.push({ type: 'text', text: request });
    // The host accepts at most six content parts (and five images). A quoted
    // reply plus five attachments would be seven, so trim the tail instead of
    // sending a request the bridge is guaranteed to reject.
    const usedExtras = Math.max(0, Math.min(extra.length, 6 - parts.length));
    parts.push(...extra.slice(0, usedExtras));
    const promptResult = await action('prompt', {
      sessionId,
      targetAgent: promptTarget,
      cwd: currentCwd || undefined,
      requestId: crypto.randomUUID(),
      content: parts,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    const finishComposeUi = () => {
      quickInput.value = '';
      pendingImages = pendingImages.slice(usedExtras); quoted = null;
      renderAttachments(); renderQuote();
      pet.classList.remove('compose-open');
      composeButton.setAttribute('aria-expanded', 'false');
      closeContext();
    };
    if (promptResult?.launched || sessionId.startsWith('launch:')) {
      finishComposeUi();
      const targetLabel = promptResult?.providerLabel || getTargetInfo(promptResult?.targetAgent || promptTarget).label;
      showFeedback(`已复制指令并打开 ${targetLabel}（可直接 ⌘V 粘贴）`);
      return { sessionId, launched: true };
    }
    if (reuseActive) {
      prefs.activeSessionId = sessionId;
      if (!activeSessionTitle && request) {
        activeSessionTitle = request.slice(0, 24);
        prefs.activeSessionTitle = activeSessionTitle;
      }
      savePrefs();
      renderModel();
    }
    finishComposeUi();
    const resolvedTargetId = promptResult?.targetAgent
      || (sessionId.startsWith('local:') ? sessionId.split(':')[1] : promptTarget);
    const currentTargetLabel = promptResult?.providerLabel || getTargetInfo(resolvedTargetId).label;
    showFeedback(existingSessionId
      ? '已回复该会话'
      : `已发送给 ${currentTargetLabel}`);
    setActivitiesOpen(true);
    await poll();
    return { sessionId, baselineSeq };
  } catch (error) { report(error, () => sendPrompt(request, options)); }
  finally { sending = false; $('quick-send').disabled = false; }
}

/* -------------------------------------------------------------------------- */
/* Quick Chat: Add context (images / skills / file references / model),       */
/* transcript with quoted reply, restore and start-new-chat.                  */
/* -------------------------------------------------------------------------- */
function renderAttachments() {
  const strip = $('attachment-strip');
  strip.textContent = '';
  strip.hidden = pendingImages.length === 0;
  for (const [index, image] of pendingImages.entries()) {
    const chip = el('span', 'attachment-chip', image.name || `图片 ${index + 1}`);
    const remove = el('button', null, '×');
    remove.type = 'button'; remove.setAttribute('aria-label', `移除 ${image.name || '图片'}`);
    remove.addEventListener('click', () => { pendingImages.splice(index, 1); renderAttachments(); });
    chip.append(remove); strip.append(chip);
  }
}
function renderQuote() {
  $('transcript-quote').hidden = !quoted;
  $('transcript-quote-text').textContent = quoted && quoted.length > 90 ? quoted.slice(0, 90) + '…' : quoted || '';
}
function getTargetInfo(id = targetAgent) {
  const found = chatTargets.find(t => t.id === id);
  if (found) return found;
  const label = TARGET_LABELS[id] || id || 'Claude Code';
  const mode = ['claude', 'codex', 'opencode', 'dsh'].includes(id) ? 'direct' : 'launch';
  return { id, label, mode };
}
function cwdBasename(dir = currentCwd) {
  if (!dir) return '';
  const normalized = String(dir).replace(/[\\/]+$/, '');
  if (!normalized) return '/';
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}
function syncTargetFromInfo(info) {
  if (!info) return;
  if (Array.isArray(info.targets)) chatTargets = info.targets;
  if (info.homeDir) hostHomeDir = info.homeDir;
  if (info.targetAgent && (!prefs.targetAgent || (chatTargets.length && !chatTargets.some(t => t.id === targetAgent)))) {
    targetAgent = info.targetAgent;
    prefs.targetAgent = info.targetAgent;
    const saved = prefs.cwdByAgent?.[targetAgent];
    if (saved && !isBareHomeDir(saved)) {
      currentCwd = saved;
      prefs.cwd = currentCwd;
    }
    savePrefs();
  }
  if (info.currentCwd && (!currentCwd || (isBareHomeDir(currentCwd) && !isBareHomeDir(info.currentCwd)))) {
    setActiveCwd(info.currentCwd, targetAgent, { persistAgent: !isBareHomeDir(info.currentCwd) });
  }
  renderModel();
}
async function ensureDefaultWorkspaceForTarget(agent = targetAgent) {
  if (!agent) return;
  const saved = prefs.cwdByAgent?.[agent];
  const candidateCwd = (currentCwd && !isBareHomeDir(currentCwd))
    ? currentCwd
    : ((saved && !isBareHomeDir(saved)) ? saved : '');
  if (candidateCwd) {
    const sel = await action('selectWorkspace', { cwd: candidateCwd, targetAgent: agent }).catch(() => null);
    if (agent !== targetAgent) return;
    if (sel?.currentCwd) {
      if (Array.isArray(sel.workspaces)) workspaceOptions = sel.workspaces;
      setActiveCwd(sel.currentCwd, agent, { persistAgent: !isBareHomeDir(sel.currentCwd) });
      renderModel();
      return;
    }
    delete prefs.cwdByAgent[agent];
    if (normalizeDirPath(currentCwd) === normalizeDirPath(candidateCwd)) {
      currentCwd = '';
      prefs.cwd = '';
    }
    savePrefs();
  }
  const res = await action('workspaces', { targetAgent: agent }).catch(() => null);
  if (!res || agent !== targetAgent) return;
  if (res.homeDir) hostHomeDir = res.homeDir;
  const rows = Array.isArray(res.workspaces) ? res.workspaces : [];
  workspaceOptions = rows;
  const firstReal = rows.find(w => w?.path && !isBareHomeDir(w.path))
    || (res.suggestedCwd && !isBareHomeDir(res.suggestedCwd) ? { path: res.suggestedCwd } : null);
  if (firstReal) {
    setActiveCwd(firstReal.path, agent);
    await action('selectWorkspace', { cwd: firstReal.path, targetAgent: agent }).catch(() => null);
    if (agent !== targetAgent) return;
    renderModel();
  } else if (!currentCwd && res.currentCwd) {
    setActiveCwd(res.currentCwd, agent, { persistAgent: !isBareHomeDir(res.currentCwd) });
    renderModel();
  }
}
function renderModel() {
  const chip = $('quick-model');
  const icon = $('quick-model-icon');
  const labelEl = $('quick-model-label');
  const info = getTargetInfo(targetAgent);
  const label = info?.label || TARGET_LABELS[targetAgent] || targetAgent;
  const dirName = cwdBasename(currentCwd);
  const sessionLabel = prefs.activeSessionId ? (activeSessionTitle || '已选会话') : '';
  const tooltipParts = [`当前 Agent：${label}`];
  if (dirName) tooltipParts.push(`目录：${dirName}`);
  tooltipParts.push(sessionLabel ? `会话：${sessionLabel}` : '新建会话');
  const fullTooltip = `${tooltipParts.join(' · ')}（点击切换 Agent / 目录 / 会话）`;
  chip.hidden = false;
  chip.title = fullTooltip;
  chip.setAttribute('aria-label', fullTooltip);
  if (icon) {
    bindIconFallback(icon);
    icon.src = iconUrl(targetAgent);
  }
  if (labelEl) labelEl.textContent = label;
  if (info?.mode === 'launch') {
    quickInput.placeholder = dirName
      ? `在 ${dirName} 中发指令给 ${label}（复制并打开）…`
      : `发指令给 ${label}（自动复制并打开应用）…`;
  } else if (sessionLabel) {
    quickInput.placeholder = `继续「${sessionLabel}」…`;
  } else if (dirName) {
    quickInput.placeholder = `在 ${dirName} 中向 ${label} 提问…`;
  } else {
    quickInput.placeholder = `向 ${label} 提问…`;
  }
}
async function ensureContextSession() {
  if (prefs.activeSessionId) return prefs.activeSessionId;
  if (contextSessionId) return contextSessionId;
  const requestedId = `session-${crypto.randomUUID()}`;
  const created = await action('create', {
    sessionId: requestedId,
    targetAgent,
    cwd: currentCwd || undefined,
  });
  return created?.sessionId || requestedId;
}
function renderOptions(container, rows, { label, onPick, emptyText }) {
  container.textContent = '';
  if (!rows.length) { container.append(el('span', 'context-empty', emptyText)); return; }
  for (const row of rows.slice(0, 8)) {
    const button = el('button', 'context-option', label(row));
    button.type = 'button';
    if (row.description) button.title = row.description;
    button.addEventListener('click', () => onPick(row));
    container.append(button);
  }
}
function updateWorkspaceSectionLabel() {
  const labelEl = $('context-workspaces-label');
  if (!labelEl) return;
  const agentLabel = getTargetInfo(targetAgent)?.label || TARGET_LABELS[targetAgent] || targetAgent;
  labelEl.textContent = `${agentLabel} · 打开/最近目录`;
}
function setExtraSectionOpen(open) {
  contextExtraOpen = Boolean(open);
  const section = $('context-extra-section');
  const toggleBtn = $('context-toggle-extra');
  if (section) section.hidden = !contextExtraOpen;
  if (toggleBtn) {
    toggleBtn.classList.toggle('is-active', contextExtraOpen);
    toggleBtn.setAttribute('aria-expanded', String(contextExtraOpen));
  }
}
function renderTargetOptions(targets) {
  const container = $('context-models');
  container.textContent = '';
  if (!targets.length) {
    container.append(el('span', 'context-empty', '没有可用 AI Agent'));
    return;
  }
  for (const row of targets) {
    const label = row.label || TARGET_LABELS[row.id] || row.id;
    const mode = row.mode || (['claude', 'codex', 'opencode', 'dsh'].includes(row.id) ? 'direct' : 'launch');
    const button = el('button', 'context-target');
    button.type = 'button';
    if (row.id === targetAgent) button.classList.add('is-active');
    button.title = mode === 'launch' ? `${label}（复制指令并打开应用）` : `${label}（直接对话）`;
    button.append(makeProviderIcon(row.id, 'context-target-icon'));
    button.append(el('span', 'context-target-label', label));
    button.append(el('span', 'context-target-tag', mode === 'launch' ? '唤起' : '直连'));
    button.addEventListener('click', () => run(async () => {
      const switchEpoch = ++targetSwitchEpoch;
      const nextAgent = row.id;
      const prevCwd = currentCwd;
      const savedForAgent = prefs.cwdByAgent?.[nextAgent];

      await action('selectModel', { targetAgent: nextAgent });
      if (switchEpoch !== targetSwitchEpoch) return;

      targetAgent = nextAgent;
      prefs.targetAgent = nextAgent;
      prefs.activeSessionId = null;
      contextSessionId = null;
      activeSessionTitle = '';
      prefs.activeSessionTitle = '';
      if (savedForAgent && !isBareHomeDir(savedForAgent)) {
        currentCwd = savedForAgent;
        prefs.cwd = currentCwd;
      }
      savePrefs();
      updateWorkspaceSectionLabel();
      renderModel();
      renderTargetOptions(targets);

      const nextWorkspaces = await action('workspaces', { targetAgent: nextAgent, includeExtra: contextExtraOpen }).catch(() => null);
      if (switchEpoch !== targetSwitchEpoch) return;

      if (nextWorkspaces?.homeDir) hostHomeDir = nextWorkspaces.homeDir;
      const nextList = Array.isArray(nextWorkspaces?.workspaces) ? nextWorkspaces.workspaces : [];
      workspaceOptions = nextList;
      if (contextExtraOpen && Array.isArray(nextWorkspaces?.extraWorkspaces)) {
        extraWorkspaceOptions = nextWorkspaces.extraWorkspaces;
      }

      const firstReal = nextList.find(w => w?.path && !isBareHomeDir(w.path))
        || (nextWorkspaces?.suggestedCwd && !isBareHomeDir(nextWorkspaces.suggestedCwd) ? { path: nextWorkspaces.suggestedCwd } : null);
      const hasSaved = Boolean(savedForAgent && !isBareHomeDir(savedForAgent));
      let nextCwd = '';
      if (hasSaved) {
        nextCwd = savedForAgent;
      } else if (firstReal) {
        nextCwd = firstReal.path;
      } else if (nextList[0]?.path) {
        nextCwd = nextList[0].path;
      } else if (hostHomeDir) {
        nextCwd = hostHomeDir;
      } else if (nextWorkspaces?.currentCwd) {
        nextCwd = nextWorkspaces.currentCwd;
      }

      if (nextCwd) {
        setActiveCwd(nextCwd, nextAgent, { persistAgent: !isBareHomeDir(nextCwd) });
      }

      const cwdChanged = Boolean(nextCwd) && normalizeDirPath(nextCwd) !== normalizeDirPath(prevCwd);
      let sel = null;
      if (nextCwd && cwdChanged) {
        sel = await action('selectWorkspace', { cwd: nextCwd, targetAgent: nextAgent }).catch(() => null);
        if (switchEpoch !== targetSwitchEpoch) return;
        if (!sel && hasSaved) {
          delete prefs.cwdByAgent[nextAgent];
          const fallbackCwd = firstReal?.path || nextList[0]?.path || hostHomeDir || nextWorkspaces?.currentCwd || '';
          if (fallbackCwd) {
            setActiveCwd(fallbackCwd, nextAgent, { persistAgent: !isBareHomeDir(fallbackCwd) });
            if (normalizeDirPath(fallbackCwd) !== normalizeDirPath(prevCwd)) {
              sel = await action('selectWorkspace', { cwd: fallbackCwd, targetAgent: nextAgent }).catch(() => null);
              if (switchEpoch !== targetSwitchEpoch) return;
            }
          }
        }
        if (sel?.currentCwd) {
          setActiveCwd(sel.currentCwd, nextAgent, { persistAgent: !isBareHomeDir(sel.currentCwd) });
        }
        if (Array.isArray(sel?.workspaces)) {
          workspaceOptions = sel.workspaces;
        }
      }

      if (Array.isArray(sel?.sessions)) {
        sessionOptions = sel.sessions;
      } else {
        const nextSessions = await action('sessions', { targetAgent: nextAgent, cwd: currentCwd || undefined }).catch(() => null);
        if (switchEpoch !== targetSwitchEpoch) return;
        sessionOptions = Array.isArray(nextSessions?.sessions) ? nextSessions.sessions : [];
      }

      renderModel();
      renderWorkspaceOptions(workspaceOptions);
      if (contextExtraOpen) renderExtraWorkspaceOptions(extraWorkspaceOptions);
      renderSessionOptions(sessionOptions);
      refreshFilesForWorkspace();
      showFeedback(mode === 'launch'
        ? `已切换至 ${label}（发送时将复制指令并打开应用）`
        : `已切换对话目标：${label}`);
    }));
    container.append(button);
  }
}
async function refreshFilesForWorkspace() {
  const activeAgent = targetAgent;
  const activeCwd = currentCwd;
  const sid = contextSessionId || await ensureContextSession().catch(() => null);
  if (!sid || targetAgent !== activeAgent || currentCwd !== activeCwd) return;
  contextSessionId = sid;
  const query = $('context-query')?.value || '';
  const result = await action('files', {
    sessionId: sid,
    query,
    cwd: currentCwd || undefined,
  }).catch(() => null);
  if (!result || targetAgent !== activeAgent || currentCwd !== activeCwd) return;
  renderOptions($('context-files'), result.candidates ?? [], {
    label: row => `@${row.path ?? row.name ?? row.value ?? ''}`, emptyText: '输入文件名以搜索',
    onPick: row => { insertIntoQuickInput(`@${row.path ?? row.name ?? row.value ?? ''} `); },
  });
}
async function selectWorkspacePath(cwdPath, displayName, { isExtra = false } = {}) {
  const res = await action('selectWorkspace', { cwd: cwdPath, targetAgent });
  const resolvedCwd = res?.currentCwd || cwdPath;
  prefs.activeSessionId = null;
  contextSessionId = null;
  activeSessionTitle = '';
  prefs.activeSessionTitle = '';
  setActiveCwd(resolvedCwd, targetAgent);
  if (Array.isArray(res?.workspaces)) workspaceOptions = res.workspaces;
  if (Array.isArray(res?.sessions)) {
    sessionOptions = res.sessions;
  } else {
    const nextSessions = await action('sessions', { targetAgent, cwd: currentCwd }).catch(() => null);
    if (Array.isArray(nextSessions?.sessions)) sessionOptions = nextSessions.sessions;
  }
  renderWorkspaceOptions(workspaceOptions);
  if (contextExtraOpen) renderExtraWorkspaceOptions(extraWorkspaceOptions);
  renderSessionOptions(sessionOptions);
  renderModel();
  refreshFilesForWorkspace();
  showFeedback(isExtra ? `已选择本机项目：${displayName}` : `已切换工作目录：${displayName}`);
}
function makeWorkspaceChip(w, { isExtra = false } = {}) {
  const dirName = w.name || cwdBasename(w.path) || w.path;
  const button = el('button', 'context-option context-workspace-chip');
  button.type = 'button';
  if (w.isOpen) {
    button.classList.add('is-open');
    const dot = el('span', 'context-open-dot');
    dot.setAttribute('aria-hidden', 'true');
    button.append(dot);
  }
  button.append(el('span', 'context-option-label', `${isExtra ? '🗂' : '📁'} ${dirName}`));
  if (w.isOpen) button.append(el('span', 'context-open-tag', '已打开'));
  button.title = w.isOpen ? `${w.path}（已打开）` : w.path;
  const matchesCurrent = w.path === currentCwd
    || (currentCwd && normalizeDirPath(w.path) === normalizeDirPath(currentCwd));
  if (matchesCurrent || (!currentCwd && !isExtra && w.active)) button.classList.add('is-active');
  button.addEventListener('click', () => run(() => selectWorkspacePath(w.path, dirName, { isExtra })));
  return button;
}
function renderWorkspaceOptions(workspaces = workspaceOptions) {
  const container = $('context-workspaces');
  if (!container) return;
  container.textContent = '';
  if (!workspaces.length) {
    container.append(el('span', 'context-empty', '暂无打开/最近目录，可点 ＋ 本机项目或选择文件夹'));
    return;
  }
  for (const w of workspaces) {
    container.append(makeWorkspaceChip(w, { isExtra: false }));
  }
}
function renderExtraWorkspaceOptions(extraWorkspaces = extraWorkspaceOptions, { loading = false } = {}) {
  const container = $('context-extra-workspaces');
  if (!container) return;
  container.textContent = '';
  if (loading && !extraWorkspaces.length) {
    container.append(el('span', 'context-empty', '正在扫描本机项目…'));
    return;
  }
  if (!extraWorkspaces.length) {
    container.append(el('span', 'context-empty', '未发现更多本机项目，可点「📁 选择文件夹…」'));
    return;
  }
  for (const w of extraWorkspaces) {
    container.append(makeWorkspaceChip(w, { isExtra: true }));
  }
}
async function fetchExtraWorkspaces({ forceScan = false } = {}) {
  if (scanningExtra) return;
  scanningExtra = true;
  const scanBtn = $('context-scan-extra');
  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.textContent = '扫描中…';
  }
  renderExtraWorkspaceOptions(extraWorkspaceOptions, { loading: true });
  try {
    const res = await action('workspaces', { targetAgent, includeExtra: true, forceScan });
    if (res?.homeDir) hostHomeDir = res.homeDir;
    if (Array.isArray(res?.workspaces)) {
      workspaceOptions = res.workspaces;
      renderWorkspaceOptions(workspaceOptions);
    }
    extraWorkspaceOptions = Array.isArray(res?.extraWorkspaces) ? res.extraWorkspaces : [];
    renderExtraWorkspaceOptions(extraWorkspaceOptions);
    if (forceScan) showFeedback(`已扫描本机项目（发现 ${extraWorkspaceOptions.length} 个）`);
  } finally {
    scanningExtra = false;
    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.textContent = '↻ 扫描本机';
    }
  }
}
async function selectNewSession() {
  await action('selectSession', { sessionId: 'new', targetAgent }).catch(() => null);
  prefs.activeSessionId = null;
  contextSessionId = null;
  activeSessionTitle = '';
  prefs.activeSessionTitle = '';
  savePrefs();
  renderModel();
  renderSessionOptions(sessionOptions);
  showFeedback('已切换为新建会话');
}
function renderSessionOptions(sessions = sessionOptions) {
  const container = $('context-sessions');
  const newBtn = $('context-new-session');
  if (newBtn) newBtn.classList.toggle('is-active', !prefs.activeSessionId);
  if (!container) return;
  container.textContent = '';
  if (!sessions.length) {
    container.append(el('span', 'context-empty', '当前目录暂无历史会话'));
    return;
  }
  for (const s of sessions) {
    const title = s.title || s.sessionId || '历史会话';
    const button = el('button', 'context-option', `💬 ${title}`);
    button.type = 'button';
    button.title = s.cwd ? `${title}\n目录：${s.cwd}` : title;
    const isActive = Boolean(
      prefs.activeSessionId
      && (s.sessionId === prefs.activeSessionId || (s.cliSessionId && s.cliSessionId === prefs.activeSessionId)),
    );
    if (isActive) button.classList.add('is-active');
    button.addEventListener('click', () => run(async () => {
      const picked = await action('selectSession', {
        sessionId: s.sessionId,
        cliSessionId: s.cliSessionId,
        cwd: s.cwd || currentCwd || undefined,
        title: s.title,
        targetAgent,
      });
      prefs.activeSessionId = picked?.sessionId || s.sessionId;
      activeSessionTitle = picked?.title || s.title || '';
      prefs.activeSessionTitle = activeSessionTitle;
      const nextSessionCwd = picked?.cwd || s.cwd;
      if (nextSessionCwd) {
        setActiveCwd(nextSessionCwd, targetAgent);
      } else {
        savePrefs();
      }
      renderModel();
      renderWorkspaceOptions(workspaceOptions);
      if (contextExtraOpen) renderExtraWorkspaceOptions(extraWorkspaceOptions);
      renderSessionOptions(sessionOptions);
      refreshFilesForWorkspace();
      showFeedback(`已绑定会话：${activeSessionTitle || '历史会话'}（发消息将直接续聊）`);
    }));
    container.append(button);
  }
}
async function loadContext(sessionId, { includeExtra = contextExtraOpen } = {}) {
  const note = $('context-note');
  note.hidden = false; note.textContent = '正在读取上下文…';
  if (includeExtra && !extraWorkspaceOptions.length) {
    renderExtraWorkspaceOptions([], { loading: true });
  }
  const [skills, models, files, workspaces, sessions] = await Promise.allSettled([
    action('skills', { sessionId }),
    action('models'),
    action('files', { sessionId, query: '', cwd: currentCwd || undefined }),
    action('workspaces', { targetAgent, includeExtra }),
    action('sessions', { targetAgent, cwd: currentCwd || undefined }),
  ]);
  const skillRows = skills.status === 'fulfilled' ? skills.value.skills ?? [] : [];
  let fileRows = files.status === 'fulfilled' ? files.value.candidates ?? [] : [];
  let targetRows = [];
  let targetChanged = false;
  if (models.status === 'fulfilled') {
    const prevTarget = targetAgent;
    if (Array.isArray(models.value?.targets) && models.value.targets.length) {
      targetRows = models.value.targets;
      chatTargets = targetRows;
      if (!prefs.targetAgent && models.value.current) {
        targetAgent = models.value.current;
        prefs.targetAgent = targetAgent;
        const saved = prefs.cwdByAgent?.[targetAgent];
        if (saved && !isBareHomeDir(saved)) {
          currentCwd = saved;
          prefs.cwd = currentCwd;
        }
        savePrefs();
      }
      targetChanged = targetAgent !== prevTarget;
      renderModel();
    } else if (Array.isArray(models.value?.groups)) {
      targetRows = models.value.groups.flatMap(group => (group.models ?? []).map(m => ({
        id: m.id, label: m.name || TARGET_LABELS[m.id] || m.id, mode: m.mode || 'direct',
      })));
      if (targetRows.length) chatTargets = targetRows;
    }
  }
  if (!targetRows.length) targetRows = chatTargets;
  let workspacesPayload = workspaces.status === 'fulfilled' ? workspaces.value : null;
  if (targetChanged) {
    workspacesPayload = await action('workspaces', { targetAgent, includeExtra }).catch(() => workspacesPayload);
  }
  let sessionsPayload = sessions.status === 'fulfilled' ? sessions.value : null;
  let cwdAutoSwitched = false;
  if (workspacesPayload) {
    if (workspacesPayload.homeDir) hostHomeDir = workspacesPayload.homeDir;
    workspaceOptions = Array.isArray(workspacesPayload.workspaces) ? workspacesPayload.workspaces : [];
    if (includeExtra) {
      extraWorkspaceOptions = Array.isArray(workspacesPayload.extraWorkspaces) ? workspacesPayload.extraWorkspaces : [];
    }
    const firstRealWorkspace = workspaceOptions.find(w => w?.path && !isBareHomeDir(w.path))
      || (workspacesPayload.suggestedCwd && !isBareHomeDir(workspacesPayload.suggestedCwd)
        ? { path: workspacesPayload.suggestedCwd }
        : null);
    if (!currentCwd || isBareHomeDir(currentCwd)) {
      if (firstRealWorkspace) {
        const prevCwd = currentCwd;
        setActiveCwd(firstRealWorkspace.path, targetAgent);
        cwdAutoSwitched = normalizeDirPath(currentCwd) !== normalizeDirPath(prevCwd);
        renderModel();
      } else if (!currentCwd && workspacesPayload.currentCwd) {
        setActiveCwd(workspacesPayload.currentCwd, targetAgent, {
          persistAgent: !isBareHomeDir(workspacesPayload.currentCwd),
        });
        renderModel();
      }
    }
  } else {
    workspaceOptions = [];
    if (includeExtra) extraWorkspaceOptions = [];
  }
  if (targetChanged) {
    contextSessionId = null;
    sessionId = await ensureContextSession().catch(() => sessionId);
    contextSessionId = sessionId;
  }
  if (cwdAutoSwitched) {
    const [sel, nextFiles] = await Promise.all([
      action('selectWorkspace', { cwd: currentCwd, targetAgent }).catch(() => null),
      action('files', { sessionId, query: '', cwd: currentCwd || undefined }).catch(() => null),
    ]);
    if (Array.isArray(sel?.workspaces)) workspaceOptions = sel.workspaces;
    if (Array.isArray(sel?.sessions)) {
      sessionsPayload = { sessions: sel.sessions };
    } else {
      sessionsPayload = await action('sessions', { targetAgent, cwd: currentCwd || undefined }).catch(() => sessionsPayload);
    }
    if (Array.isArray(nextFiles?.candidates)) fileRows = nextFiles.candidates;
  } else if (targetChanged) {
    const [nextSessions, nextFiles] = await Promise.all([
      action('sessions', { targetAgent, cwd: currentCwd || undefined }).catch(() => null),
      action('files', { sessionId, query: '', cwd: currentCwd || undefined }).catch(() => null),
    ]);
    if (nextSessions) sessionsPayload = nextSessions;
    if (Array.isArray(nextFiles?.candidates)) fileRows = nextFiles.candidates;
  }
  sessionOptions = Array.isArray(sessionsPayload?.sessions) ? sessionsPayload.sessions : [];
  renderOptions($('context-skills'), skillRows, {
    label: row => `/${row.name}`, emptyText: '没有可用技能',
    onPick: row => { insertIntoQuickInput(`/${row.name} `); },
  });
  renderOptions($('context-files'), fileRows, {
    label: row => `@${row.path ?? row.name ?? row.value ?? ''}`, emptyText: '输入文件名以搜索',
    onPick: row => { insertIntoQuickInput(`@${row.path ?? row.name ?? row.value ?? ''} `); },
  });
  updateWorkspaceSectionLabel();
  renderTargetOptions(targetRows);
  renderWorkspaceOptions(workspaceOptions);
  if (includeExtra || contextExtraOpen) {
    renderExtraWorkspaceOptions(extraWorkspaceOptions);
  }
  renderSessionOptions(sessionOptions);
  const unavailable = [skills, files, models].filter(result => result.status === 'rejected' || result.value?.unavailable).length;
  note.textContent = unavailable ? '部分目录暂不可用；图片附件仍可添加' : '';
  note.hidden = !unavailable;
}
function insertIntoQuickInput(text) {
  const start = quickInput.selectionStart ?? quickInput.value.length;
  const end = quickInput.selectionEnd ?? quickInput.value.length;
  quickInput.value = quickInput.value.slice(0, start) + text + quickInput.value.slice(end);
  quickInput.focus();
  quickInput.setSelectionRange(start + text.length, start + text.length);
  if (!$('pet').classList.contains('compose-open')) showQuickChat();
}
function openContext(mode = 'all') {
  const popover = $('context-popover');
  const wasOpen = !popover.hidden;
  const nextOpen = wasOpen && mode !== contextMode ? true : !wasOpen;
  contextMode = mode;
  if (nextOpen && pet.classList.contains('activities-open')) setActivitiesOpen(false);
  popover.hidden = !nextOpen;
  pet.classList.toggle('context-open', nextOpen);
  syncView();
  $('tool-context').setAttribute('aria-expanded', String(nextOpen && mode === 'plus'));
  $('quick-model')?.setAttribute('aria-expanded', String(nextOpen && mode === 'agent'));
  if (!nextOpen) {
    setExtraSectionOpen(false);
    return;
  }
  const wantExtra = mode === 'plus';
  setExtraSectionOpen(wantExtra);
  renderModel();
  updateWorkspaceSectionLabel();
  run(async () => {
    contextSessionId = await ensureContextSession();
    await loadContext(contextSessionId, { includeExtra: wantExtra });
  });
}
function closeContext() {
  $('context-popover').hidden = true;
  pet.classList.remove('context-open');
  setExtraSectionOpen(false);
  $('tool-context').setAttribute('aria-expanded', 'false');
  $('quick-model')?.setAttribute('aria-expanded', 'false');
}
async function loadTranscript() {
  const container = $('transcript-list');
  container.textContent = '';
  container.append(el('p', 'transcript-state', '正在读取会话…'));
  try {
    const view = await action('conversation', { sessionId: transcriptSessionId });
    container.textContent = '';
    if (!view.messages?.length) { container.append(el('p', 'transcript-state', '还没有消息，先说点什么吧')); return; }
    for (const message of view.messages) {
      const row = el('div', 'transcript-message');
      row.dataset.role = message.role;
      const assistantRole = transcriptSessionId?.startsWith('local:')
        ? (getTargetInfo(transcriptSessionId.split(':')[1])?.label || '小鑫')
        : 'DSH';
      row.append(el('span', 'transcript-role', message.role === 'user' ? '你' : assistantRole));
      row.append(el('span', 'transcript-body', message.text || (message.attachments ? `[${message.attachments} 个附件]` : '')));
      const reply = el('button', 'transcript-reply', '回复');
      reply.type = 'button';
      reply.addEventListener('click', () => { quoted = message.text || ''; renderQuote(); $('transcript-input').focus(); });
      row.append(reply);
      container.append(row);
    }
    container.scrollTop = container.scrollHeight;
  } catch (error) {
    container.textContent = '';
    container.append(el('p', 'transcript-state', '会话暂时不可用'));
    report(error);
  }
}
async function openTranscript(sessionId = prefs.activeSessionId) {
  if (!sessionId) return;
  transcriptSessionId = sessionId;
  setActivitiesOpen(false);
  $('transcript').hidden = false;
  pet.classList.add('transcript-open');
  pet.classList.remove('show', 'compose-open');
  composeButton.setAttribute('aria-expanded', 'false');
  closeContext();
  syncView();
  const row = items.find(item => item.sessionId === sessionId);
  $('transcript-title').textContent = row?.title || '快速聊天';
  renderQuote();
  await loadTranscript();
}
function closeTranscript() {
  $('transcript').hidden = true;
  pet.classList.remove('transcript-open');
  quoted = null; renderQuote();
}
function startNewChat() {
  prefs.activeSessionId = null; prefs.activeSessionTitle = ''; prefs.model = null;
  contextSessionId = null;
  activeSessionTitle = '';
  savePrefs();
  pendingImages = []; quoted = null; transcriptSessionId = null;
  renderAttachments(); renderQuote(); renderModel();
  closeTranscript(); closeContext();
  quickInput.value = '';
  showQuickChat();
  showFeedback('已开始新聊天');
}

/* -------------------------------------------------------------------------- */
/* Voice dictation (unchanged).                                               */
/* -------------------------------------------------------------------------- */
function setVoiceButton(active, processing = false) {
  voiceButton.classList.toggle('voice-active', active);
  voiceButton.classList.toggle('voice-processing', active && processing);
  voiceButton.setAttribute('aria-pressed', String(active));
  voiceButton.setAttribute('aria-label', active ? (processing ? '停止语音对话' : '结束本轮语音') : '开始语音对话');
  voiceButton.title = active ? (processing ? '停止语音对话' : '结束本轮语音') : '开始语音对话';
}

async function speakReply(text, epoch) {
  if (native) {
    const res = await action('speak', { text });
    if (!res?.stopped && voiceConversation && epoch === voiceEpoch) {
      recordVoiceChunk(epoch).catch(report);
    }
    return;
  }
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) throw new Error('当前桌面环境不支持语音播报');
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 1;
  utterance.onend = () => { if (voiceConversation && epoch === voiceEpoch) recordVoiceChunk(epoch).catch(report); };
  utterance.onerror = () => {
    if (voiceConversation && epoch === voiceEpoch) {
      showFeedback('语音播报失败，点麦克风结束语音对话');
      recordVoiceChunk(epoch).catch(report);
    }
  };
  window.speechSynthesis.speak(utterance);
}

async function waitForVoiceReply(sessionId, baselineSeq, epoch) {
  const isLocalVoice = sessionId.startsWith('local:') || ['claude', 'codex', 'opencode'].includes(source) || !dshConnected;
  const deadline = Date.now() + 5 * 60_000;
  while (voiceConversation && epoch === voiceEpoch && Date.now() < deadline) {
    const view = await action('conversation', { sessionId });
    if (view.status === 'ready') {
      const messages = (view.messages ?? []).filter(message => message.seq > baselineSeq);
      const heardPrompt = messages.some(message => message.role === 'user');
      const reply = heardPrompt && [...messages].reverse().find(message => message.role === 'assistant' && message.text?.trim());
      if (reply) { showFeedback(isLocalVoice ? '小鑫正在语音回复…' : 'DSH 正在语音回复…'); await speakReply(reply.text, epoch); return true; }
    }
    if (['waiting', 'blocked'].includes(view.status)) {
      voiceConversation = false; setVoiceButton(false);
      showFeedback(view.detail || (isLocalVoice ? '任务需要你进一步处理' : '任务需要你在 DSH 中处理'));
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 900));
  }
  if (voiceConversation && epoch === voiceEpoch) {
    throw new Error(isLocalVoice ? '等待小鑫回复超时，请稍后重试' : '等待 DSH 回复超时，请在 DSH 中查看任务');
  }
}

async function recordVoiceChunk(epoch) {
  if (!voiceConversation || epoch !== voiceEpoch) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('当前桌面环境不支持录音');
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  if (!voiceConversation || epoch !== voiceEpoch) { mediaStream.getTracks().forEach(track => track.stop()); mediaStream = undefined; return; }
  const chunks = [];
  let vadTimer, vadContext, heardSpeech = false, lastSpeechAt = performance.now();
  const startedAt = performance.now();
  try {
    vadContext = new AudioContext();
    const analyser = vadContext.createAnalyser();
    analyser.fftSize = 512;
    vadContext.createMediaStreamSource(mediaStream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    vadTimer = setInterval(() => {
      if (!recorder || recorder.state !== 'recording') return;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      voiceButton.style.setProperty('--voice-level', String(Math.min(1, rms * 10)));
      const now = performance.now();
      if (now - startedAt > 250 && rms > 0.016) {
        heardSpeech = true;
        lastSpeechAt = now;
      } else if (heardSpeech && now - startedAt > 900 && now - lastSpeechAt >= 1350) {
        recorder.stop();
      }
    }, 80);
  } catch { /* fallback cleanly to manual stop or 24s cap */ }
  const stopVad = () => {
    clearInterval(vadTimer);
    voiceButton.style.removeProperty('--voice-level');
    vadContext?.close().catch(() => {});
    vadContext = undefined;
  };

  recorder = new MediaRecorder(mediaStream);
  recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
  recorder.addEventListener('stop', async () => {
    const activeRecorder = recorder;
    recorder = undefined; clearTimeout(recordingTimer); stopVad();
    mediaStream?.getTracks().forEach(track => track.stop()); mediaStream = undefined;
    voiceButton.classList.remove('recording'); setVoiceButton(voiceConversation, true);
    if (!voiceConversation || epoch !== voiceEpoch) return;
    try {
      showFeedback('正在识别语音…');
      const audio = await recordingToWave(new Blob(chunks, { type: activeRecorder.mimeType }));
      const result = await action('hear', { audio });
      if (!result.text?.trim()) throw new Error('没有识别到语音，请重试');
      showFeedback('正在发送语音内容…');
      const sent = await sendPrompt(result.text, { sessionId: voiceSessionId, trackReply: true });
      if (sent?.sessionId) voiceSessionId = sent.sessionId;
      const speaking = sent?.sessionId ? await waitForVoiceReply(sent.sessionId, sent.baselineSeq, epoch) : false;
      if (!speaking && voiceConversation && epoch === voiceEpoch) recordVoiceChunk(epoch).catch(report);
    } catch (error) {
      if (voiceConversation && epoch === voiceEpoch) { voiceConversation = false; setVoiceButton(false); report(error); }
    }
  }, { once: true });
  recorder.start();
  voiceButton.classList.add('recording'); setVoiceButton(true);
  showFeedback('正在聆听… 说完停顿即自动发送（也可点麦克风结束）');
  recordingTimer = setTimeout(() => { if (recorder?.state === 'recording') recorder.stop(); }, 24_000);
}

async function startVoice() {
  if (voiceConversation) {
    if (recorder?.state === 'recording') { recorder.stop(); return; }
    voiceConversation = false; voiceEpoch++;
    voiceSessionId = undefined;
    if (native) action('speak-stop').catch(() => {});
    window.speechSynthesis?.cancel();
    recorder?.state === 'recording' && recorder.stop();
    mediaStream?.getTracks().forEach(track => track.stop()); mediaStream = undefined;
    setVoiceButton(false); showFeedback('语音对话已结束');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('当前桌面环境不支持录音');
  if (!native && (!window.speechSynthesis || !window.SpeechSynthesisUtterance)) throw new Error('当前桌面环境不支持语音播报');
  voiceConversation = true;
  const epoch = ++voiceEpoch;
  setVoiceButton(true);
  try { await recordVoiceChunk(epoch); }
  catch (error) { voiceConversation = false; setVoiceButton(false); throw error; }
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */
character.addEventListener('click', event => { if (suppressClick) { suppressClick = false; return; } if (event.detail === 1) notice(); });
character.addEventListener('dblclick', () => { if (!suppressClick) run(() => openDsh()); });
composeButton.addEventListener('click', event => {
  const canChat = DIRECT_CHAT_SOURCES.has(source) || chatTargets.some(t => t.id === source);
  if (!canChat) { run(() => action('home')); return; }
  const open = pet.classList.toggle('compose-open');
  pet.classList.remove('show');
  event.currentTarget.setAttribute('aria-expanded', String(open));
  if (open) {
    closeContext();
    closeTranscript();
    syncView();
    setTimeout(() => quickInput.focus(), 30);
  } else {
    closeContext();
    syncView();
    quickInput.blur();
  }
});
$('quick-chat').addEventListener('submit', event => {
  event.preventDefault();
  run(() => sendPrompt(quickInput.value, { content: pendingImages, reuseActive: true }));
});
voiceButton.addEventListener('click', () => {
  const canVoice = DIRECT_CHAT_SOURCES.has(source) || chatTargets.some(t => t.id === source && t.mode === 'direct');
  if (!canVoice) { showFeedback('当前工具仅支持状态观察或唤起应用，请切换到直连对话目标'); notice(); return; }
  if (voiceButton.dataset.available === 'false') { showFeedback('当前桌面环境未找到语音识别组件'); notice(); return; }
  run(startVoice);
});
activitiesButton.addEventListener('click', () => {
  const currentlyShowing = pet.classList.contains('activities-open')
    && !pet.classList.contains('context-open')
    && !pet.classList.contains('transcript-open');
  setActivitiesOpen(!currentlyShowing);
});
$('tool-context').addEventListener('click', () => openContext('plus'));
$('quick-model')?.addEventListener('click', () => openContext('agent'));
$('context-close').addEventListener('click', closeContext);
$('context-toggle-extra')?.addEventListener('click', () => run(async () => {
  const next = !contextExtraOpen;
  setExtraSectionOpen(next);
  if (next) await fetchExtraWorkspaces({ forceScan: false });
}));
$('context-scan-extra')?.addEventListener('click', () => run(() => fetchExtraWorkspaces({ forceScan: true })));
$('context-browse-cwd')?.addEventListener('click', () => run(async () => {
  const res = await action('selectWorkspace', { browse: true, targetAgent });
  if (res?.canceled) return;
  if (res?.currentCwd) {
    prefs.activeSessionId = null;
    contextSessionId = null;
    activeSessionTitle = '';
    prefs.activeSessionTitle = '';
    setActiveCwd(res.currentCwd, targetAgent);
  }
  if (Array.isArray(res?.workspaces)) workspaceOptions = res.workspaces;
  if (Array.isArray(res?.sessions)) sessionOptions = res.sessions;
  renderWorkspaceOptions(workspaceOptions);
  if (contextExtraOpen) renderExtraWorkspaceOptions(extraWorkspaceOptions);
  renderSessionOptions(sessionOptions);
  renderModel();
  refreshFilesForWorkspace();
  if (currentCwd) showFeedback(`已切换工作目录：${cwdBasename(currentCwd)}`);
}));
$('context-new-session')?.addEventListener('click', () => run(selectNewSession));
$('context-image').addEventListener('click', () => $('context-file').click());
$('context-file').addEventListener('change', async event => {
  const files = [...(event.target.files ?? [])];
  for (const file of files) {
    if (pendingImages.length >= 5) break;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) continue;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.readAsDataURL(file);
    });
    pendingImages.push({ type: 'image', mediaType: file.type, data: dataUrl.split(',')[1], name: file.name });
  }
  event.target.value = '';
  renderAttachments();
  if (files.length) showFeedback(`已添加 ${pendingImages.length} 张图片`);
});
$('context-query').addEventListener('input', event => {
  clearTimeout(fileQueryTimer);
  const query = event.target.value;
  fileQueryTimer = setTimeout(() => run(async () => {
    const activeAgent = targetAgent;
    const activeCwd = currentCwd;
    const sid = contextSessionId || await ensureContextSession().catch(() => null);
    if (!sid || targetAgent !== activeAgent || currentCwd !== activeCwd) return;
    contextSessionId = sid;
    const result = await action('files', { sessionId: sid, query, cwd: currentCwd || undefined });
    if (targetAgent !== activeAgent || currentCwd !== activeCwd) return;
    renderOptions($('context-files'), result.candidates ?? [], {
      label: row => `@${row.path ?? row.name ?? row.value ?? ''}`, emptyText: '没有匹配的文件',
      onPick: row => insertIntoQuickInput(`@${row.path ?? row.name ?? row.value ?? ''} `),
    });
  }), 220);
});
$('transcript-close').addEventListener('click', closeTranscript);
$('transcript-new').addEventListener('click', startNewChat);
$('transcript-quote-remove').addEventListener('click', () => { quoted = null; renderQuote(); });
$('transcript-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('transcript-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  run(async () => { await sendPrompt(text, { sessionId: transcriptSessionId, content: pendingImages, quoted }); await loadTranscript(); });
});
$('activity-stack').addEventListener('click', () => { prefs.stackCollapsed = !prefs.stackCollapsed; savePrefs(); renderActivities(); });
$('awake-dismiss').addEventListener('click', () => { prefs.firstAwakeSeen = true; savePrefs(); renderActivities(); });
$('feedback-retry').addEventListener('click', () => { const retry = retryAction; showFeedback(''); if (retry) run(retry); });
$('feedback-close').addEventListener('click', () => showFeedback(''));
character.addEventListener('contextmenu', event => { event.preventDefault(); if (native) run(() => native.window('menu')); });
character.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !native) return;
  drag = { x: event.screenX, y: event.screenY, moved: false };
  character.setPointerCapture(event.pointerId);
  run(() => native.window('drag-start'));
});
character.addEventListener('pointermove', event => {
  if (!drag) return;
  const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
});
function endDrag() { if (drag) { suppressClick = drag.moved; drag = null; run(() => native.window('drag-end')); } }
character.addEventListener('pointerup', endDrag);
character.addEventListener('pointercancel', endDrag);
character.addEventListener('lostpointercapture', endDrag);
character.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); run(openDsh); } });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    voiceConversation = false; voiceEpoch++; voiceSessionId = undefined;
    if (native) action('speak-stop').catch(() => {});
    window.speechSynthesis?.cancel();
    if (recorder?.state === 'recording') recorder.stop();
    mediaStream?.getTracks().forEach(track => track.stop()); mediaStream = undefined;
    setVoiceButton(false);
    closeContext(); closeTranscript();
    pet.classList.remove('show', 'compose-open');
    composeButton.setAttribute('aria-expanded', 'false');
    setActivitiesOpen(false);
    character.blur();
  }
});

if (native) {
  const applyPlacement = placement => {
    if (!placement) return;
    pet.style.setProperty('--pet-left', placement.left + 'px');
    pet.style.setProperty('--pet-top', placement.top + 'px');
    pet.style.setProperty('--panel-left', placement.panelLeft + 'px');
    pet.dataset.bubble = placement.below ? 'below' : 'above';
    renderActivities();
  };
  const applySource = mode => {
    if (mode.source && mode.source !== 'auto' && targetAgent !== mode.source) {
      targetAgent = mode.source;
      prefs.targetAgent = mode.source;
      prefs.activeSessionId = null;
      contextSessionId = null;
      activeSessionTitle = '';
      prefs.activeSessionTitle = '';
      const saved = prefs.cwdByAgent?.[targetAgent];
      currentCwd = (saved && !isBareHomeDir(saved)) ? saved : '';
      prefs.cwd = currentCwd;
      savePrefs();
      renderModel();
    }
    if (mode.source && source !== mode.source) {
      source = mode.source;
      if (sourceInitialized) {
        prefs.activeSessionId = null;
        contextSessionId = null;
        activeSessionTitle = '';
        prefs.activeSessionTitle = '';
        prefs.model = null;
        savePrefs();
        renderModel();
      }
      voiceConversation = false; voiceEpoch++; voiceSessionId = undefined;
      if (recorder?.state === 'recording') recorder.stop();
      mediaStream?.getTracks().forEach(track => track.stop()); window.speechSynthesis?.cancel(); setVoiceButton(false);
      pet.classList.remove('show', 'compose-open', 'transcript-open', 'context-open');
      composeButton.setAttribute('aria-expanded', 'false');
      syncActivitiesButton(); syncView();
      $('transcript').hidden = true; $('context-popover').hidden = true;
      run(async () => {
        const info = await action('info').catch(() => null);
        if (info) {
          voiceButton.dataset.available = String(Boolean(info.speechAvailable));
          if (info.localEngine) localEngine = info.localEngine;
          syncTargetFromInfo(info);
        }
        await ensureDefaultWorkspaceForTarget();
        await poll();
      });
    }
    sourceInitialized = true;
  };
  native.onMode(mode => { applySource(mode); applyPlacement(mode.placement); document.body.classList.toggle('control-only', mode.controlOnly); if (mode.notice) notice(); if (mode.focusQuickChat) showQuickChat(); });
  run(async () => { const mode = await native.window('placement'); applySource(mode); applyPlacement(mode.placement); document.body.classList.toggle('control-only', mode.controlOnly); });
  run(async () => {
    const info = await action('info');
    voiceButton.dataset.available = String(Boolean(info.speechAvailable));
    if (info.localEngine) localEngine = info.localEngine;
    syncTargetFromInfo(info);
    await ensureDefaultWorkspaceForTarget();
  });
  // Click-through must follow real geometry, not CSS `:hover`. Turning on
  // `setIgnoreMouseEvents` makes the page stop receiving hover, which hides the
  // panel mid-travel — that is what made it vanish on the way down.
  let passthrough, hovering = false, releaseTimer;
  const inside = (rect, x, y) => rect.width > 0 && rect.height > 0
    && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  // The collapsed capsule is always hit-testable: its rect must be in the
  // anchor even while click-through is on, otherwise the pointer can never
  // reach the buttons to turn passthrough back off.
  const toolbar = $('toolbar');
  const anchor = () => ([character.getBoundingClientRect(), miniPill.getBoundingClientRect(), toolbar.getBoundingClientRect(),
    ...(feedback.classList.contains('visible') ? [feedback.getBoundingClientRect()] : []),
    ...(hovering && pet.classList.contains('expanded') ? [panel.getBoundingClientRect()] : [])]);
  const release = () => {
    clearTimeout(releaseTimer);
    hovering = false; pet.classList.remove('hovering');
    if (passthrough !== true) { passthrough = true; run(() => native.window('passthrough', true)); }
  };
  document.addEventListener('mousemove', event => {
    if (drag) return;
    const overContent = anchor().some(rect => inside(rect, event.clientX, event.clientY));
    const overControl = Boolean(event.target.closest?.('button,input,textarea,#panel'));
    if (overContent || overControl) {
      clearTimeout(releaseTimer);
      if (!hovering) { hovering = true; pet.classList.add('hovering'); }
      if (passthrough !== false) { passthrough = false; run(() => native.window('passthrough', false)); }
      return;
    }
    // A short grace period absorbs the one-pixel jitter at the panel edge.
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(release, 120);
  });
  // Leaving the window entirely must hand the desktop its clicks back.
  document.addEventListener('mouseleave', release);
  // The transparent 400x480 box would otherwise swallow desktop clicks.
  passthrough = true; run(() => native.window('passthrough', true));
} else {
  document.body.classList.add('preview');
  pet.dataset.panelOrder = 'controls-first';
  pet.classList.add('activities-open');
  activitiesButton.setAttribute('aria-pressed', 'true');
  activitiesButton.setAttribute('aria-label', '收起活动');
  run(async () => {
    const info = await action('info').catch(() => null);
    syncTargetFromInfo(info);
    await ensureDefaultWorkspaceForTarget();
  });
}
renderModel(); renderAttachments(); renderQuote();
run(poll);
const timer = setInterval(() => run(poll), 3500);
window.addEventListener('beforeunload', () => {
  voiceConversation = false; voiceEpoch++; voiceSessionId = undefined; window.speechSynthesis?.cancel();
  clearInterval(timer); clearTimeout(noticeTimer); clearTimeout(recordingTimer);
  mediaStream?.getTracks().forEach(track => track.stop());
});
