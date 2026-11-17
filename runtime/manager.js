'use strict';
const api = window.agentManager;
const $ = id => document.getElementById(id);

const enabledList = $('enabled-list');
const detectedList = $('detected-list');
const missingList = $('missing-list');
const detectedEmpty = $('detected-empty');
const banner = $('banner');
const rescanBtn = $('rescan-btn');
const enableAllBtn = $('enable-all-btn');
const autoStartToggle = $('autostart-toggle');

let busyId = null;
let autoStartBusy = false;
let bannerTimer = null;
let currentItems = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function cleanErrorMessage(err, fallback = '操作失败，请重试') {
  const raw = typeof err === 'string' ? err : err?.message;
  const cleaned = String(raw || '').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim();
  return cleaned || fallback;
}

function showBanner(text, isError = false) {
  clearTimeout(bannerTimer);
  banner.hidden = false;
  banner.textContent = text;
  banner.className = isError ? 'banner error' : 'banner';
  bannerTimer = setTimeout(() => { banner.hidden = true; }, 4500);
}

function makeIcon(id) {
  const img = el('img', 'icon');
  img.src = `../assets/icons/${id}.png`;
  img.alt = '';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    if (!img.src.endsWith('/dsh.png')) img.src = '../assets/icons/dsh.png';
  }, { once: true });
  return img;
}

function makeCard(item) {
  const card = el('div', item.enabled || item.installed ? 'card' : 'card muted');
  card.append(makeIcon(item.id));

  const info = el('div', 'info');
  const top = el('div', 'row-top');
  top.append(el('span', 'name', item.label));

  if (item.defaultEnabled) {
    top.append(el('span', 'tag ok', '默认内置'));
  } else if (item.enabled) {
    top.append(el('span', 'tag ok', item.hookConfigured ? '已接入' : '已启用'));
  } else if (item.installed) {
    top.append(el('span', 'tag', '已检测到'));
  } else {
    top.append(el('span', 'tag', '未安装'));
  }

  info.append(top);
  const pathText = item.detectedPaths?.length ? ` · ${item.detectedPaths[0]}` : '';
  const meta = el('div', 'meta', `${item.mechanism}${pathText}`);
  if (item.detectedPaths?.length) meta.title = item.detectedPaths.join('\n');
  info.append(meta);
  card.append(info);

  const actions = el('div', 'actions');
  if (item.enabled && item.canLaunch) {
    const openBtn = el('button', 'action-btn', '打开');
    openBtn.type = 'button';
    openBtn.disabled = busyId === item.id;
    openBtn.addEventListener('click', () => runAction(() => api.openApp(item.id), `已尝试打开 ${item.label}`));
    actions.append(openBtn);
  }

  if (item.enabled) {
    if (item.toggleable) {
      const removeBtn = el('button', 'action-btn remove', busyId === item.id ? '处理中…' : '− 移除');
      removeBtn.type = 'button';
      removeBtn.disabled = busyId !== null;
      removeBtn.addEventListener('click', async () => {
        busyId = item.id;
        render(currentItems);
        try {
          const next = await api.disable(item.id);
          render(next);
          showBanner(`已移除 ${item.label} 接入，原有配置已保留/备份`);
        } catch (err) {
          showBanner(cleanErrorMessage(err, `移除 ${item.label} 失败`), true);
        } finally {
          busyId = null;
          render(currentItems);
        }
      });
      actions.append(removeBtn);
    }
  } else {
    const addBtn = el('button', item.installed ? 'action-btn primary' : 'action-btn', busyId === item.id ? '接入中…' : item.installed ? '+ 接入' : '+ 预配置');
    addBtn.type = 'button';
    addBtn.disabled = busyId !== null;
    addBtn.addEventListener('click', async () => {
      busyId = item.id;
      render(currentItems);
      try {
        const next = await api.enable(item.id);
        render(next);
        showBanner(`已接入 ${item.label}（原配置已自动备份，新对话/新回合起生效）`);
      } catch (err) {
        showBanner(cleanErrorMessage(err, `接入 ${item.label} 失败`), true);
      } finally {
        busyId = null;
        render(currentItems);
      }
    });
    actions.append(addBtn);
  }

  card.append(actions);
  return card;
}

function render(items) {
  currentItems = Array.isArray(items) ? items : [];
  const enabled = currentItems.filter(item => item.enabled);
  const detected = currentItems.filter(item => !item.enabled && item.installed);
  const missing = currentItems.filter(item => !item.enabled && !item.installed);

  $('enabled-count').textContent = String(enabled.length);
  $('detected-count').textContent = String(detected.length);
  $('missing-count').textContent = String(missing.length);

  enabledList.replaceChildren(...enabled.map(makeCard));
  detectedList.replaceChildren(...detected.map(makeCard));
  missingList.replaceChildren(...missing.map(makeCard));
  detectedEmpty.hidden = detected.length > 0;
  enableAllBtn.disabled = busyId !== null;
  rescanBtn.disabled = busyId !== null;
}

function syncAutoStart(state) {
  autoStartToggle.checked = Boolean(state?.enabled);
}

async function loadAutoStart() {
  if (!api.getAutoStart) return;
  try {
    syncAutoStart(await api.getAutoStart());
  } catch { /* ignore */ }
}

async function runAction(fn, okMessage) {
  try {
    const res = await fn();
    if (Array.isArray(res)) render(res);
    if (okMessage) showBanner(okMessage);
  } catch (err) {
    showBanner(cleanErrorMessage(err), true);
  }
}

enableAllBtn.addEventListener('click', async () => {
  if (busyId !== null) return;
  busyId = '__all__';
  enableAllBtn.textContent = '接入中…';
  render(currentItems);
  try {
    const beforeCount = currentItems.filter(item => item.enabled).length;
    const next = await api.enableAll();
    const afterCount = Array.isArray(next) ? next.filter(item => item.enabled).length : beforeCount;
    const added = Math.max(0, afterCount - beforeCount);
    busyId = null;
    render(next);
    showBanner(added > 0
      ? `已一键接入 ${added} 个本机已安装的 AI Agent（原配置已自动备份，新对话/新回合起生效）`
      : '所有本机已安装的 AI Agent 均已接入');
  } catch (err) {
    busyId = null;
    showBanner(cleanErrorMessage(err, '一键接入失败，请重试'), true);
    render(currentItems);
  } finally {
    enableAllBtn.textContent = '一键接入已安装';
  }
});

rescanBtn.addEventListener('click', async () => {
  if (busyId !== null) return;
  busyId = '__scan__';
  render(currentItems);
  try {
    const next = await api.list();
    busyId = null;
    render(next);
    showBanner('已完成本机 AI Agent 扫描');
  } catch (err) {
    busyId = null;
    showBanner(cleanErrorMessage(err, '扫描失败'), true);
    render(currentItems);
  }
});

autoStartToggle.addEventListener('change', async () => {
  if (!api.setAutoStart || autoStartBusy) return;
  const nextEnabled = autoStartToggle.checked;
  autoStartBusy = true;
  autoStartToggle.disabled = true;
  try {
    const res = await api.setAutoStart(nextEnabled);
    syncAutoStart(res);
    showBanner(res?.enabled ? '已开启登录 macOS 自动启动小鑫' : '已关闭开机自动启动');
  } catch (err) {
    autoStartToggle.checked = !nextEnabled;
    showBanner(cleanErrorMessage(err, '设置开机启动失败'), true);
  } finally {
    autoStartBusy = false;
    autoStartToggle.disabled = false;
  }
});

api.onUpdated(items => render(items));
api.onAutoStartUpdated?.(state => syncAutoStart(state));

runAction(() => api.list());
loadAutoStart();
