const api = window.agentManager;
const $ = id => document.getElementById(id);

const enabledList = $('enabled-list');
const detectedList = $('detected-list');
const missingList = $('missing-list');
const detectedEmpty = $('detected-empty');
const banner = $('banner');
const rescanBtn = $('rescan-btn');
const enableAllBtn = $('enable-all-btn');

const tabButtons = [...document.querySelectorAll('.seg-btn[data-tab]')];
const panelConnectors = $('panel-connectors');
const panelBot = $('panel-bot');

// Bot tab elements
const botRefreshBtn = $('bot-refresh-btn');
const botSaveAllBtn = $('bot-save-all-btn');
const botSaveDispatchBtn = $('bot-save-dispatch-btn');
const botSaveSecurityBtn = $('bot-save-security-btn');
const botEnginesStrip = $('bot-engines-strip');
const botDefaultEngine = $('bot-default-engine');
const botSandboxMode = $('bot-sandbox-mode');
const botDefaultCwd = $('bot-default-cwd');
const botBrowseCwdBtn = $('bot-browse-cwd-btn');
const botAllowedWorkspaces = $('bot-allowed-workspaces');

const botPairingCode = $('bot-pairing-code');
const botCopyPairBtn = $('bot-copy-pair-btn');
const botRegenPairBtn = $('bot-regen-pair-btn');
const botAuthUsersList = $('bot-auth-users-list');
const botAuthChannel = $('bot-auth-channel');
const botAuthIdInput = $('bot-auth-id-input');
const botAuthAddBtn = $('bot-auth-add-btn');
const botNotifyEnabled = $('bot-notify-enabled');
const botNotifyWaiting = $('bot-notify-waiting');
const botNotifyBlocked = $('bot-notify-blocked');
const botNotifyReady = $('bot-notify-ready');

const qqEnabled = $('qq-enabled');
const qqStatusPill = $('qq-status-pill');
const qqStatusDetail = $('qq-status-detail');
const qqMode = $('qq-mode');
const qqAccessToken = $('qq-access-token');
const qqClientGroup = $('qq-client-group');
const qqServerGroup = $('qq-server-group');
const qqWsUrl = $('qq-ws-url');
const qqListenHost = $('qq-listen-host');
const qqListenPort = $('qq-listen-port');
const qqListenPath = $('qq-listen-path');
const qqAllowUsers = $('qq-allow-users');
const qqAllowGroups = $('qq-allow-groups');
const qqPushTargets = $('qq-push-targets');
const qqRequireMention = $('qq-require-mention');
const qqTestBtn = $('qq-test-btn');
const qqSaveBtn = $('qq-save-btn');

const wecomEnabled = $('wecom-enabled');
const wecomStatusPill = $('wecom-status-pill');
const wecomStatusDetail = $('wecom-status-detail');
const wecomWsUrl = $('wecom-ws-url');
const wecomBotId = $('wecom-bot-id');
const wecomSecret = $('wecom-secret');
const wecomWebhookUrl = $('wecom-webhook-url');
const wecomPushTargets = $('wecom-push-targets');
const wecomAllowUsers = $('wecom-allow-users');
const wecomTestBtn = $('wecom-test-btn');
const wecomSaveBtn = $('wecom-save-btn');

const botJobsCount = $('bot-jobs-count');
const botJobsList = $('bot-jobs-list');
const botJobsEmpty = $('bot-jobs-empty');
const botJobsRefreshBtn = $('bot-jobs-refresh-btn');

let busyId = null;
let bannerTimer = null;
let currentItems = [];
let botState = null;
let botDirty = false;
let botBusy = false;
let draftAuthorizedUsers = { qq: [], wecom: [] };

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

function splitCsv(text) {
  return [...new Set(String(text || '')
    .split(/[\n,，]+/)
    .map(part => part.trim())
    .filter(Boolean))];
}

function splitLines(text) {
  return [...new Set(String(text || '')
    .split(/[\r\n,，]+/)
    .map(part => part.trim())
    .filter(Boolean))];
}

function switchTab(tabName) {
  const target = tabName === 'bot' ? 'bot' : 'connectors';
  for (const btn of tabButtons) {
    const active = btn.dataset.tab === target;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  panelConnectors.hidden = target !== 'connectors';
  panelBot.hidden = target !== 'bot';
  if (target === 'bot' && !botState && api.bot) {
    loadBotState();
  }
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
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

/* -------------------------------------------------------------------------- */
/* Bot Gateway Tab                                                            */
/* -------------------------------------------------------------------------- */

function updateQqModeVisibility() {
  const isServer = qqMode.value === 'server';
  qqClientGroup.hidden = isServer;
  qqServerGroup.hidden = !isServer;
}

function renderEngines(engines = {}) {
  const specs = [
    ['claude', 'Claude Code'],
    ['codex', 'Codex'],
    ['antigravity', 'Antigravity'],
    ['dsh', 'DSH'],
  ];
  const nodes = specs.map(([id, fallbackLabel]) => {
    const info = engines?.[id] || {};
    const pill = el('div', 'engine-pill');
    const top = el('div', 'engine-pill-top');
    const dot = el('span', 'dot');
    let noteText = info.note || info.path || '未检测到';

    if (info.available) {
      dot.classList.add('ok');
      noteText = info.path || (id === 'dsh' ? '已连接，可直接派活' : 'CLI 已就绪');
    } else if (info.mode === 'gui-only') {
      dot.classList.add('warn');
      noteText = info.note || '仅桌面端状态监听（未检测到 CLI/SDK）';
    } else if (id === 'dsh') {
      noteText = info.note || 'DSH 尚未运行';
    }

    top.append(dot, el('span', '', info.label || fallbackLabel));
    const note = el('div', 'engine-pill-note', noteText);
    pill.title = noteText;
    pill.append(top, note);
    return pill;
  });
  botEnginesStrip.replaceChildren(...nodes);
}

function renderChannelStatus(pillEl, detailEl, channelInfo, defaultDetail) {
  const enabled = Boolean(channelInfo?.enabled);
  const rawState = String(channelInfo?.state || channelInfo?.status || (enabled ? 'disconnected' : 'disabled'));
  const detail = channelInfo?.lastError || channelInfo?.detail || '';

  let tone = '';
  let label = '未启用';
  if (!enabled) {
    label = '未启用';
  } else if (rawState === 'connected' || rawState === 'listening') {
    tone = 'ok';
    label = rawState === 'listening' ? '监听中' : '已连接';
  } else if (rawState === 'connecting') {
    tone = 'warn';
    label = '连接中';
  } else if (rawState === 'error') {
    tone = 'err';
    label = '异常';
  } else {
    tone = 'warn';
    label = '未连接';
  }

  pillEl.className = tone ? `status-pill ${tone}` : 'status-pill';
  const dot = el('span', tone ? `dot ${tone}` : 'dot');
  const text = el('span', 'status-text', label);
  pillEl.replaceChildren(dot, text);
  detailEl.textContent = detail || defaultDetail;
}

function renderAuthorizedUsers() {
  const chips = [];
  for (const [channel, label] of [['qq', 'QQ'], ['wecom', '企微']]) {
    for (const id of draftAuthorizedUsers[channel] || []) {
      const chip = el('span', 'auth-chip');
      chip.append(el('span', '', `${label}: ${id}`));
      const rm = el('button', 'chip-remove', '×');
      rm.type = 'button';
      rm.title = `移除 ${id}`;
      rm.addEventListener('click', () => {
        draftAuthorizedUsers[channel] = (draftAuthorizedUsers[channel] || []).filter(item => item !== id);
        botDirty = true;
        renderAuthorizedUsers();
      });
      chip.append(rm);
      chips.push(chip);
    }
  }
  if (!chips.length) {
    botAuthUsersList.replaceChildren(el('span', 'toolbar-note', '暂无已配对会话；发送 /pair 配对码 或在此手动添加。'));
    return;
  }
  botAuthUsersList.replaceChildren(...chips);
}

function formatJobTime(ts) {
  if (!Number.isFinite(Number(ts))) return '';
  try {
    return new Date(Number(ts)).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function renderJobs(jobs = []) {
  const rows = Array.isArray(jobs) ? jobs : [];
  botJobsCount.textContent = String(rows.length);
  botJobsEmpty.hidden = rows.length > 0;

  const statusMeta = {
    running: ['ok', '运行中'],
    completed: ['ok', '已完成'],
    failed: ['err', '失败'],
    cancelled: ['warn', '已停止'],
  };

  const cards = rows.map(job => {
    const card = el('div', 'job-card');
    const info = el('div', 'job-info');
    const top = el('div', 'row-top');
    const [tagTone, tagLabel] = statusMeta[job.status] || ['', job.status || '未知'];
    top.append(el('span', 'tag', String(job.engine || 'bot').toUpperCase()));
    top.append(el('span', tagTone ? `tag ${tagTone}` : 'tag', tagLabel));
    if (job.startedAt) top.append(el('span', 'toolbar-note', formatJobTime(job.startedAt)));

    const title = el('div', 'job-title', job.promptPreview || job.jobId || '远程任务');
    const metaParts = [job.cwd, job.sessionId ? `会话 ${job.sessionId}` : '', job.error].filter(Boolean);
    const meta = el('div', 'meta', metaParts.join(' · ') || job.jobId || '');
    info.append(top, title, meta);
    card.append(info);

    if (job.status === 'running' && job.jobId) {
      const stopBtn = el('button', 'action-btn remove', '停止');
      stopBtn.type = 'button';
      stopBtn.disabled = botBusy;
      stopBtn.addEventListener('click', async () => {
        setBotBusy(true);
        try {
          await api.bot.stopJob(job.jobId);
          showBanner(`已请求停止任务 ${job.jobId}`);
          await loadBotState({ silent: true, preserveForm: true });
        } catch (err) {
          showBanner(cleanErrorMessage(err, '停止任务失败'), true);
        } finally {
          setBotBusy(false);
        }
      });
      card.append(stopBtn);
    }
    return card;
  });
  botJobsList.replaceChildren(...cards);
}

function applyBotConfigToForm(config = {}) {
  botDefaultEngine.value = config.defaultEngine || 'claude';
  botSandboxMode.value = config.sandboxMode || 'workspace-write';
  botDefaultCwd.value = config.defaultCwd || '';
  botAllowedWorkspaces.value = Array.isArray(config.allowedWorkspaces) ? config.allowedWorkspaces.join('\n') : '';

  botPairingCode.textContent = config.pairingCode || '------';
  draftAuthorizedUsers = {
    qq: Array.isArray(config.authorizedUsers?.qq) ? [...config.authorizedUsers.qq] : [],
    wecom: Array.isArray(config.authorizedUsers?.wecom) ? [...config.authorizedUsers.wecom] : [],
  };
  renderAuthorizedUsers();

  const notify = config.notifications || {};
  botNotifyEnabled.checked = notify.enabled !== false;
  botNotifyWaiting.checked = notify.onWaiting !== false;
  botNotifyBlocked.checked = notify.onBlocked !== false;
  botNotifyReady.checked = notify.onReady !== false;

  const qq = config.qq || {};
  qqEnabled.checked = Boolean(qq.enabled);
  qqMode.value = qq.mode === 'server' ? 'server' : 'client';
  qqAccessToken.value = qq.accessToken || '';
  qqWsUrl.value = qq.wsUrl || 'ws://127.0.0.1:3001';
  qqListenHost.value = qq.listenHost || '127.0.0.1';
  qqListenPort.value = String(qq.listenPort || 8080);
  qqListenPath.value = qq.listenPath || '/onebot/v11/ws';
  qqAllowUsers.value = Array.isArray(qq.allowUsers) ? qq.allowUsers.join(', ') : '';
  qqAllowGroups.value = Array.isArray(qq.allowGroups) ? qq.allowGroups.join(', ') : '';
  qqPushTargets.value = Array.isArray(qq.pushTargets) ? qq.pushTargets.join(', ') : '';
  qqRequireMention.checked = qq.groupRequireMention !== false;
  updateQqModeVisibility();

  const wecom = config.wecom || {};
  wecomEnabled.checked = Boolean(wecom.enabled);
  wecomWsUrl.value = wecom.wsUrl || 'wss://openws.work.weixin.qq.com';
  wecomBotId.value = wecom.botId || '';
  wecomSecret.value = wecom.secret || '';
  wecomWebhookUrl.value = wecom.webhookUrl || '';
  wecomPushTargets.value = Array.isArray(wecom.pushTargets) ? wecom.pushTargets.join(', ') : '';
  wecomAllowUsers.value = Array.isArray(wecom.allowUsers) ? wecom.allowUsers.join(', ') : '';

  botDirty = false;
}

function collectBotConfig() {
  const prev = botState?.config || {};
  const port = Number.parseInt(qqListenPort.value, 10);
  return {
    ...prev,
    defaultEngine: botDefaultEngine.value || 'claude',
    defaultCwd: botDefaultCwd.value.trim(),
    allowedWorkspaces: splitLines(botAllowedWorkspaces.value),
    sandboxMode: botSandboxMode.value || 'workspace-write',
    authorizedUsers: {
      qq: [...(draftAuthorizedUsers.qq || [])],
      wecom: [...(draftAuthorizedUsers.wecom || [])],
    },
    notifications: {
      ...(prev.notifications || {}),
      enabled: botNotifyEnabled.checked,
      onWaiting: botNotifyWaiting.checked,
      onBlocked: botNotifyBlocked.checked,
      onReady: botNotifyReady.checked,
    },
    qq: {
      ...(prev.qq || {}),
      enabled: qqEnabled.checked,
      mode: qqMode.value === 'server' ? 'server' : 'client',
      wsUrl: qqWsUrl.value.trim() || 'ws://127.0.0.1:3001',
      listenHost: qqListenHost.value.trim() || '127.0.0.1',
      listenPort: Number.isFinite(port) && port > 0 && port <= 65535 ? port : 8080,
      listenPath: qqListenPath.value.trim() || '/onebot/v11/ws',
      accessToken: qqAccessToken.value.trim(),
      allowUsers: splitCsv(qqAllowUsers.value),
      allowGroups: splitCsv(qqAllowGroups.value),
      groupRequireMention: qqRequireMention.checked,
      pushTargets: splitCsv(qqPushTargets.value),
    },
    wecom: {
      ...(prev.wecom || {}),
      enabled: wecomEnabled.checked,
      wsUrl: wecomWsUrl.value.trim() || 'wss://openws.work.weixin.qq.com',
      botId: wecomBotId.value.trim(),
      secret: wecomSecret.value.trim(),
      webhookUrl: wecomWebhookUrl.value.trim(),
      pushTargets: splitCsv(wecomPushTargets.value),
      allowUsers: splitCsv(wecomAllowUsers.value),
    },
  };
}

function renderBotState(state, { preserveForm = false } = {}) {
  if (!state) return;
  botState = state;
  renderEngines(state.engines || {});
  renderChannelStatus(qqStatusPill, qqStatusDetail, state.channels?.qq, '兼容 NapCat / Lagrange / go-cqhttp 正向或反向 WebSocket。');
  renderChannelStatus(wecomStatusPill, wecomStatusDetail, state.channels?.wecom, '默认通过企业微信智能机器人长连接实时收发消息。');
  renderJobs(state.jobs || []);
  if (state.config?.pairingCode) botPairingCode.textContent = state.config.pairingCode;

  if (!preserveForm) {
    applyBotConfigToForm(state.config || {});
  } else if (!botDirty && state.config?.authorizedUsers) {
    draftAuthorizedUsers = {
      qq: Array.isArray(state.config.authorizedUsers.qq) ? [...state.config.authorizedUsers.qq] : [],
      wecom: Array.isArray(state.config.authorizedUsers.wecom) ? [...state.config.authorizedUsers.wecom] : [],
    };
    renderAuthorizedUsers();
  }
}

function setBotBusy(busy) {
  botBusy = busy;
  for (const btn of [
    botRefreshBtn,
    botSaveAllBtn,
    botSaveDispatchBtn,
    botSaveSecurityBtn,
    botBrowseCwdBtn,
    botRegenPairBtn,
    qqTestBtn,
    qqSaveBtn,
    wecomTestBtn,
    wecomSaveBtn,
    botJobsRefreshBtn,
  ]) {
    if (btn) btn.disabled = busy;
  }
}

async function loadBotState({ silent = true, preserveForm = false } = {}) {
  if (!api.bot) return;
  try {
    const next = await api.bot.state();
    renderBotState(next, { preserveForm });
    if (!silent) showBanner('已刷新 Bot 网关状态');
  } catch (err) {
    showBanner(cleanErrorMessage(err, '读取 Bot 网关状态失败'), true);
  }
}

async function saveBotConfig({ silent = false } = {}) {
  if (!api.bot) return false;
  setBotBusy(true);
  try {
    const next = await api.bot.save(collectBotConfig());
    renderBotState(next, { preserveForm: false });
    if (!silent) showBanner('Bot 网关配置已保存并应用');
    return true;
  } catch (err) {
    showBanner(cleanErrorMessage(err, '保存 Bot 配置失败'), true);
    return false;
  } finally {
    setBotBusy(false);
  }
}

async function testChannelPush(channel) {
  if (!api.bot) return;
  if (botDirty) {
    const saved = await saveBotConfig({ silent: true });
    if (!saved) return;
  }
  setBotBusy(true);
  try {
    const res = await api.bot.testPush(channel);
    if (res?.ok) {
      showBanner(res.detail || `已发送 ${channel === 'qq' ? 'QQ' : '企业微信'} 测试推送`);
    } else {
      showBanner(res?.detail || '测试推送未发送，请检查连接状态与推送目标', true);
    }
    await loadBotState({ silent: true, preserveForm: true });
  } catch (err) {
    showBanner(cleanErrorMessage(err, '测试推送失败'), true);
  } finally {
    setBotBusy(false);
  }
}

function addAuthorizedEntry() {
  const channel = botAuthChannel.value === 'wecom' ? 'wecom' : 'qq';
  const id = botAuthIdInput.value.trim();
  if (!id) return;
  const list = draftAuthorizedUsers[channel] || [];
  if (!list.includes(id)) {
    draftAuthorizedUsers[channel] = [...list, id];
    botDirty = true;
    renderAuthorizedUsers();
  }
  botAuthIdInput.value = '';
}

for (const input of panelBot.querySelectorAll('input, select, textarea')) {
  if (input === botAuthChannel || input === botAuthIdInput) continue;
  input.addEventListener('change', () => { botDirty = true; });
  input.addEventListener('input', () => { botDirty = true; });
}

qqMode.addEventListener('change', updateQqModeVisibility);
botAuthAddBtn.addEventListener('click', addAuthorizedEntry);
botAuthIdInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addAuthorizedEntry();
  }
});

botBrowseCwdBtn.addEventListener('click', async () => {
  if (!api.bot || botBusy) return;
  try {
    const picked = await api.bot.browseCwd();
    if (!picked?.canceled && picked?.path) {
      botDefaultCwd.value = picked.path;
      botDirty = true;
    }
  } catch (err) {
    showBanner(cleanErrorMessage(err, '选择目录失败'), true);
  }
});

botCopyPairBtn.addEventListener('click', async () => {
  const code = botPairingCode.textContent?.trim();
  if (!code || code === '------') return;
  try {
    await navigator.clipboard.writeText(code);
    showBanner(`已复制配对码 ${code}`);
  } catch {
    showBanner('复制失败，请手动选中配对码复制', true);
  }
});

botRegenPairBtn.addEventListener('click', async () => {
  if (!api.bot || botBusy) return;
  setBotBusy(true);
  try {
    const next = await api.bot.regeneratePairing();
    renderBotState(next, { preserveForm: true });
    showBanner(`已生成新配对码：${next?.config?.pairingCode || ''}`);
  } catch (err) {
    showBanner(cleanErrorMessage(err, '重新生成配对码失败'), true);
  } finally {
    setBotBusy(false);
  }
});

for (const saveBtn of [botSaveAllBtn, botSaveDispatchBtn, botSaveSecurityBtn, qqSaveBtn, wecomSaveBtn]) {
  saveBtn.addEventListener('click', () => saveBotConfig());
}

for (const refreshBtn of [botRefreshBtn, botJobsRefreshBtn]) {
  refreshBtn.addEventListener('click', () => loadBotState({ silent: false, preserveForm: false }));
}

qqTestBtn.addEventListener('click', () => testChannelPush('qq'));
wecomTestBtn.addEventListener('click', () => testChannelPush('wecom'));

api.onUpdated(items => render(items));
api.onTab?.(tab => switchTab(tab));
api.bot?.onUpdated?.(next => renderBotState(next, { preserveForm: true }));

if (window.location.hash === '#bot') {
  switchTab('bot');
}

runAction(() => api.list());
loadBotState({ silent: true, preserveForm: false });
