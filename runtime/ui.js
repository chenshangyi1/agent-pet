/** Floating Agent Pet UI: click character to toggle notices, click notice to jump to session. */
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
const badge = $('activity-badge');
const labels = { running: '正在工作', waiting: '需要你确认', blocked: '遇到问题', ready: '已完成', cancelled: '已取消', idle: '空闲' };

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
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

let source = 'auto';
let items = [], current, animationKey, polling = false, noticeTimer, drag, suppressClick = false;
const PREFS_KEY = 'dsh-companion:prefs:v1';
const defaultPrefs = { firstAwakeSeen: false, muted: [], dismissed: [], stackCollapsed: true };
let prefs;
try { prefs = { ...defaultPrefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
catch { prefs = { ...defaultPrefs }; }
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } }
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
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

async function action(name, body = {}) {
  if (native) return native.action({ ...body, action: name });
  const response = await fetch('/api/companion/action', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, action: name }) });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error ?? '操作失败');
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
function notice() { clearTimeout(noticeTimer); pet.classList.add('pinned'); noticeTimer = setTimeout(() => pet.classList.remove('pinned'), 6000); }
function cleanErrorMessage(message) {
  return String(message || '操作失败').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim() || '操作失败';
}
function report(error, retry) { showFeedback(cleanErrorMessage(error?.message), true, retry); notice(); }
function run(fn) { Promise.resolve().then(fn).catch(report); }

function syncView() {
  const open = pet.classList.contains('activities-open');
  if (pet.classList.contains('expanded') !== open) pet.classList.toggle('expanded', open);
  const revealed = open || pet.classList.contains('hovering') || pet.classList.contains('pinned');
  if (pet.classList.contains('revealed') !== revealed) pet.classList.toggle('revealed', revealed);
}
new MutationObserver(syncView).observe(pet, { attributes: true, attributeFilter: ['class'] });
pet.classList.remove('show', 'activities-open', 'hovering', 'pinned', 'revealed', 'expanded');
syncView();

function pingBadge() {
  badge.classList.remove('ping');
  void badge.offsetWidth;
  badge.classList.add('ping');
}
function setActivitiesOpen(nextOpen) {
  const open = Boolean(nextOpen);
  pet.classList.toggle('activities-open', open);
  pet.classList.remove('show');
  character.setAttribute('aria-expanded', String(open));
  if (!open) {
    prefs.stackCollapsed = true;
    savePrefs();
  }
  syncView();
  renderActivities();
}

async function animation(status) {
  const key = ['running', 'waiting', 'blocked', 'ready'].includes(status) ? status : 'idle';
  if (animationKey === key) return;
  const src = native ? await native.window('animation', key) : '/companion/animation-' + key;
  animationKey = key; video.src = src;
  if (!reduced.matches) await video.play().catch(() => {});
}
video.addEventListener('loadeddata', () => { if (reduced.matches) video.pause(); });
reduced.addEventListener('change', () => { if (reduced.matches) video.pause(); else video.play().catch(() => {}); });

function visibleActivities(rows) {
  return rows.filter(item => ['waiting', 'blocked', 'running'].includes(item.status) || item.status === 'ready' && item.unread);
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
function shortDetail(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const readable = val => (String(val).match(/[\u4e00-\u9fa5][^，。；!?]*/) || [])[0] || String(val).slice(0, 48);
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
  const openFallback = item.provider === 'dsh' ? '打开 DSH 会话' : `在 ${item.providerLabel || '对应工具'} 中查看`;
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
    run(() => jumpSession(item));
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
    handle.addEventListener('click', event => { event.stopPropagation(); run(() => jumpSession(item)); });
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
  addAction('open', '打开', () => jumpSession(item));
  addAction('expand', expanded.has(id) ? '收起' : '展开', () => {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    renderActivities();
  });
  addAction('mute', muted.has(id) ? '取消静音' : '静音', () => toggleMute(item));
  addAction('dismiss', '关闭', () => dismissItem(item));
  card.append(actions);

  return card;
}
let renderKey = '';
function renderActivities() {
  const signature = JSON.stringify([
    items.map(item => [item.sessionId, item.lastSeq, item.status, item.detail, item.unread, item.pending?.length ?? 0]),
    [...muted], [...expanded], [...dismissed], prefs.stackCollapsed, prefs.firstAwakeSeen,
    pet.dataset.bubble, pet.classList.contains('activities-open'),
  ]);
  if (signature === renderKey) return;
  renderKey = signature;
  list.querySelectorAll('.activity-card').forEach(card => card.remove());
  const showOnboarding = !prefs.firstAwakeSeen && items.length === 0;
  $('first-awake').hidden = !showOnboarding;
  empty.style.display = !items.length && !showOnboarding && pet.classList.contains('activities-open') ? 'block' : 'none';
  empty.textContent = '暂无需要关注的活动';

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
    list.append(makeCard(item, { stacked: collapsed, stackLayer: index, stackTotal: items.length }));
  });

  badge.hidden = items.length === 0;
  badge.textContent = items.length > 99 ? '99+' : String(items.length);
  badge.setAttribute('aria-label', `${items.length} 项待处理活动`);
  const placement = pet.dataset.bubble;
  if (placement === 'above') {
    pet.dataset.panelOrder = 'above';
  } else {
    pet.dataset.panelOrder = 'below';
    pet.style.setProperty('--panel-top', 'calc(var(--pet-top,0px) + 140px)');
  }
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const response = await action('list');
    const next = visibleActivities(response.items ?? []);
    const now = Date.now();
    for (const item of next) if (item.status === 'ready' && !readyShownAt.has(item.sessionId)) readyShownAt.set(item.sessionId, now);
    items = dismissExpired(next);
    current = items[0];
    renderActivities();
    const status = current?.status ?? 'idle';
    document.body.dataset.status = status;
    syncView();
    character.setAttribute('aria-label', current ? `小鑫：${items.length} 项活动，点击查看或收起` : '小鑫：点击查看活动，拖动移动，右键菜单');
    await animation(status);
    if (trackActivityNotices(items.filter(item => !muted.has(item.sessionId))).length) pingBadge();
  } finally { polling = false; }
}

async function jumpSession(item = current) {
  const res = await action(item ? 'focus' : 'home', item ? { sessionId: item.sessionId } : {});
  setActivitiesOpen(false);
  character.blur();
  if (res?.fallback) {
    showFeedback(res.mode === 'workspace' ? '已打开原项目目录（未能自动定位到应用）' : '已切换至对应应用');
    notice();
  } else if (res?.openedManager) {
    showFeedback('当前暂无进行中的会话，已为你打开管理窗口');
    notice();
  }
  await poll();
}

character.addEventListener('click', () => {
  if (suppressClick) { suppressClick = false; return; }
  setActivitiesOpen(!pet.classList.contains('activities-open'));
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
character.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    setActivitiesOpen(!pet.classList.contains('activities-open'));
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    pet.classList.remove('show');
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
    if (mode.source && source !== mode.source) {
      source = mode.source;
      setActivitiesOpen(false);
      run(poll);
    }
  };
  native.onMode(mode => {
    applySource(mode);
    applyPlacement(mode.placement);
    if (mode.notice) notice();
    if (mode.openNotices) setActivitiesOpen(true);
  });
  native.onUpdated?.(() => run(poll));
  run(async () => {
    const mode = await native.window('placement');
    applySource(mode);
    applyPlacement(mode.placement);
  });
  let passthrough, releaseTimer;
  const inside = (rect, x, y) => rect.width > 0 && rect.height > 0
    && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  const anchor = () => ([
    character.getBoundingClientRect(),
    ...(feedback.classList.contains('visible') ? [feedback.getBoundingClientRect()] : []),
    ...(pet.classList.contains('expanded') ? [
      list.getBoundingClientRect(),
      $('activity-stack').getBoundingClientRect(),
      $('first-awake').getBoundingClientRect(),
    ] : []),
  ]);
  const release = () => {
    clearTimeout(releaseTimer);
    pet.classList.remove('hovering');
    if (passthrough !== true) { passthrough = true; run(() => native.window('passthrough', true)); }
  };
  document.addEventListener('mousemove', event => {
    if (drag) return;
    const overContent = anchor().some(rect => inside(rect, event.clientX, event.clientY));
    const overControl = Boolean(event.target.closest?.('button,#activity-list,#first-awake,#activity-stack,#feedback'));
    if (overContent || overControl) {
      clearTimeout(releaseTimer);
      pet.classList.add('hovering');
      if (passthrough !== false) { passthrough = false; run(() => native.window('passthrough', false)); }
      return;
    }
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(release, 120);
  });
  document.addEventListener('mouseleave', release);
  passthrough = true; run(() => native.window('passthrough', true));
} else {
  document.body.classList.add('preview');
  pet.dataset.panelOrder = 'below';
  setActivitiesOpen(true);
}
run(poll);
const timer = setInterval(() => run(poll), 3500);
window.addEventListener('beforeunload', () => {
  clearInterval(timer);
  clearTimeout(noticeTimer);
});
