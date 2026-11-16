'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { TaskDispatcher } = require('./dispatcher.cjs');
const { CommandRouter } = require('./commands.cjs');
const { QQOneBotAdapter } = require('./channels/qq-onebot.cjs');
const { WeComAdapter } = require('./channels/wecom.cjs');

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLD_BOOT_STALE_MS = 120_000;

const DEFAULT_BOT_CONFIG = {
  defaultEngine: 'claude',
  defaultCwd: os.homedir(),
  allowedWorkspaces: [os.homedir()],
  sandboxMode: 'workspace-write',
  pairingCode: '',
  authorizedUsers: {
    qq: [],
    wecom: [],
  },
  notifications: {
    enabled: true,
    onWaiting: true,
    onBlocked: true,
    onReady: true,
    cooldownMs: 15000,
  },
  qq: {
    enabled: false,
    mode: 'client',
    wsUrl: 'ws://127.0.0.1:3001',
    listenHost: '127.0.0.1',
    listenPort: 8080,
    listenPath: '/onebot/v11/ws',
    accessToken: '',
    allowUsers: [],
    allowGroups: [],
    groupRequireMention: true,
    pushTargets: [],
  },
  wecom: {
    enabled: false,
    wsUrl: 'wss://openws.work.weixin.qq.com',
    botId: '',
    secret: '',
    webhookUrl: '',
    allowUsers: [],
    pushTargets: [],
  },
};

function generatePairingCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += PAIRING_ALPHABET[crypto.randomInt(0, PAIRING_ALPHABET.length)];
  }
  return code;
}

function normalizeStringList(value, fallback = []) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,;]+/)
      : fallback;
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const trimmed = String(item ?? '').trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function writeJsonAtomic(filePath, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
}

function normalizeBotConfig(raw = {}, existing = null) {
  const home = os.homedir();
  const base = existing || DEFAULT_BOT_CONFIG;
  const defaultCwd = String(raw.defaultCwd ?? base.defaultCwd ?? home).trim() || home;
  const allowedRaw = raw.allowedWorkspaces !== undefined
    ? normalizeStringList(raw.allowedWorkspaces)
    : normalizeStringList(base.allowedWorkspaces, [home]);
  const allowedWorkspaces = allowedRaw.length > 0 ? allowedRaw : [home];

  const validEngines = new Set(['claude', 'codex', 'antigravity', 'dsh']);
  const engineCandidate = String(raw.defaultEngine ?? base.defaultEngine ?? 'claude').trim().toLowerCase();
  const defaultEngine = validEngines.has(engineCandidate) ? engineCandidate : 'claude';

  const validSandbox = new Set(['workspace-write', 'auto', 'full', 'read-only']);
  const sandboxCandidate = String(raw.sandboxMode ?? base.sandboxMode ?? 'workspace-write').trim();
  const sandboxMode = validSandbox.has(sandboxCandidate) ? sandboxCandidate : 'workspace-write';

  const pairingCandidate = String(raw.pairingCode ?? base.pairingCode ?? '').trim().toUpperCase();
  const pairingCode = /^[A-Z0-9]{4,16}$/.test(pairingCandidate)
    ? pairingCandidate
    : generatePairingCode();

  const authRaw = raw.authorizedUsers && typeof raw.authorizedUsers === 'object' ? raw.authorizedUsers : {};
  const authBase = base.authorizedUsers && typeof base.authorizedUsers === 'object' ? base.authorizedUsers : {};
  const authorizedUsers = {
    qq: authRaw.qq !== undefined ? normalizeStringList(authRaw.qq) : normalizeStringList(authBase.qq),
    wecom: authRaw.wecom !== undefined ? normalizeStringList(authRaw.wecom) : normalizeStringList(authBase.wecom),
  };

  const notifRaw = raw.notifications && typeof raw.notifications === 'object' ? raw.notifications : {};
  const notifBase = base.notifications && typeof base.notifications === 'object' ? base.notifications : DEFAULT_BOT_CONFIG.notifications;
  const cooldownRaw = Number(notifRaw.cooldownMs ?? notifBase.cooldownMs ?? 15000);
  const notifications = {
    enabled: notifRaw.enabled !== undefined ? Boolean(notifRaw.enabled) : notifBase.enabled !== false,
    onWaiting: notifRaw.onWaiting !== undefined ? Boolean(notifRaw.onWaiting) : notifBase.onWaiting !== false,
    onBlocked: notifRaw.onBlocked !== undefined ? Boolean(notifRaw.onBlocked) : notifBase.onBlocked !== false,
    onReady: notifRaw.onReady !== undefined ? Boolean(notifRaw.onReady) : notifBase.onReady !== false,
    cooldownMs: Number.isFinite(cooldownRaw) && cooldownRaw >= 0 ? cooldownRaw : 15000,
  };

  const qqRaw = raw.qq && typeof raw.qq === 'object' ? raw.qq : {};
  const qqBase = base.qq && typeof base.qq === 'object' ? base.qq : DEFAULT_BOT_CONFIG.qq;
  const qqPortRaw = Number(qqRaw.listenPort ?? qqBase.listenPort ?? 8080);
  const qq = {
    enabled: qqRaw.enabled !== undefined ? Boolean(qqRaw.enabled) : Boolean(qqBase.enabled),
    mode: (qqRaw.mode ?? qqBase.mode) === 'server' ? 'server' : 'client',
    wsUrl: String(qqRaw.wsUrl ?? qqBase.wsUrl ?? 'ws://127.0.0.1:3001').trim() || 'ws://127.0.0.1:3001',
    listenHost: String(qqRaw.listenHost ?? qqBase.listenHost ?? '127.0.0.1').trim() || '127.0.0.1',
    listenPort: Number.isInteger(qqPortRaw) && qqPortRaw >= 0 && qqPortRaw <= 65535 ? qqPortRaw : 8080,
    listenPath: String(qqRaw.listenPath ?? qqBase.listenPath ?? '/onebot/v11/ws').trim() || '/onebot/v11/ws',
    accessToken: String(qqRaw.accessToken ?? qqBase.accessToken ?? ''),
    allowUsers: qqRaw.allowUsers !== undefined ? normalizeStringList(qqRaw.allowUsers) : normalizeStringList(qqBase.allowUsers),
    allowGroups: qqRaw.allowGroups !== undefined ? normalizeStringList(qqRaw.allowGroups) : normalizeStringList(qqBase.allowGroups),
    groupRequireMention: qqRaw.groupRequireMention !== undefined
      ? Boolean(qqRaw.groupRequireMention)
      : qqBase.groupRequireMention !== false,
    pushTargets: qqRaw.pushTargets !== undefined ? normalizeStringList(qqRaw.pushTargets) : normalizeStringList(qqBase.pushTargets),
  };

  const wecomRaw = raw.wecom && typeof raw.wecom === 'object' ? raw.wecom : {};
  const wecomBase = base.wecom && typeof base.wecom === 'object' ? base.wecom : DEFAULT_BOT_CONFIG.wecom;
  const wecom = {
    enabled: wecomRaw.enabled !== undefined ? Boolean(wecomRaw.enabled) : Boolean(wecomBase.enabled),
    wsUrl: String(wecomRaw.wsUrl ?? wecomBase.wsUrl ?? 'wss://openws.work.weixin.qq.com').trim() || 'wss://openws.work.weixin.qq.com',
    botId: String(wecomRaw.botId ?? wecomBase.botId ?? '').trim(),
    secret: String(wecomRaw.secret ?? wecomBase.secret ?? '').trim(),
    webhookUrl: String(wecomRaw.webhookUrl ?? wecomBase.webhookUrl ?? '').trim(),
    allowUsers: wecomRaw.allowUsers !== undefined ? normalizeStringList(wecomRaw.allowUsers) : normalizeStringList(wecomBase.allowUsers),
    pushTargets: wecomRaw.pushTargets !== undefined ? normalizeStringList(wecomRaw.pushTargets) : normalizeStringList(wecomBase.pushTargets),
  };

  return {
    defaultEngine,
    defaultCwd,
    allowedWorkspaces,
    sandboxMode,
    pairingCode,
    authorizedUsers,
    notifications,
    qq,
    wecom,
  };
}

function formatStatusAlert(item) {
  const providerLabel = item.providerLabel || item.provider || 'Agent';
  const title = item.title || item.sessionId || '会话';
  const detail = item.detail || item.statusText || item.status || '';
  const sessionId = item.sessionId || '';
  return `[${providerLabel}] ${title}\n状态：${detail}\n目录/会话：${sessionId}`;
}

class BotService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.rootDir = options.rootDir || path.dirname(__dirname);
    this.dataDir = options.dataDir
      || process.env.AGENT_PET_DATA
      || process.env.DSH_COMPANION_DATA
      || path.join(os.homedir(), '.dsh', 'companion');
    this.providers = options.providers || null;
    this.desktopCommand = typeof options.desktopCommand === 'function' ? options.desktopCommand : null;
    this.openApp = typeof options.openApp === 'function' ? options.openApp : null;
    this.configPath = path.join(this.dataDir, 'bot.json');
    this.started = false;
    this.hasSeenInitialSnapshot = false;
    this.lastStatusByKey = new Map();

    this.config = this.#loadOrInitConfig();

    this.dispatcher = options.dispatcher || new TaskDispatcher({
      dataDir: this.dataDir,
      providers: this.providers,
      allowedWorkspaces: this.config.allowedWorkspaces,
      defaultCwd: this.config.defaultCwd,
      sandboxMode: this.config.sandboxMode,
    });

    this.router = options.router || new CommandRouter({
      dispatcher: this.dispatcher,
      providers: this.providers,
      desktopCommand: this.desktopCommand,
      openApp: this.openApp,
      getConfig: () => this.config,
      onAuthorizeUser: payload => this.authorizeUser(payload),
    });

    this.qq = new QQOneBotAdapter({
      config: this.config.qq,
      WebSocketImpl: options.WebSocketImpl,
      onMessage: msg => this.handleIncomingMessage(msg),
    });

    this.wecom = new WeComAdapter({
      config: this.config.wecom,
      WebSocketImpl: options.WebSocketImpl,
      fetchImpl: options.fetchImpl,
      onMessage: msg => this.handleIncomingMessage(msg),
    });

    this.qq.on('status', () => this.#emitUpdated());
    this.wecom.on('status', () => this.#emitUpdated());
    this.qq.on('error', () => {});
    this.wecom.on('error', () => {});
  }

  #loadOrInitConfig() {
    let loaded = null;
    let needsWrite = false;
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8').trim();
      if (raw) {
        loaded = JSON.parse(raw);
        if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
          loaded = {};
          needsWrite = true;
        }
      } else {
        loaded = {};
        needsWrite = true;
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        loaded = {};
        needsWrite = true;
      } else {
        loaded = {};
      }
    }

    if (!loaded.pairingCode) {
      needsWrite = true;
    }

    const normalized = normalizeBotConfig(loaded);
    if (needsWrite) {
      try {
        writeJsonAtomic(this.configPath, normalized, 0o600);
      } catch {}
    }
    return normalized;
  }

  #persistConfig() {
    writeJsonAtomic(this.configPath, this.config, 0o600);
  }

  #emitUpdated() {
    this.emit('updated', this.getState());
  }

  async start() {
    this.started = true;
    const tasks = [];
    if (this.config.qq.enabled) {
      tasks.push(this.qq.start().catch(() => {}));
    }
    if (this.config.wecom.enabled) {
      tasks.push(this.wecom.start().catch(() => {}));
    }
    await Promise.all(tasks);
    this.#emitUpdated();
    return this.getState();
  }

  async stop() {
    this.started = false;
    await Promise.allSettled([this.qq.stop(), this.wecom.stop()]);
    this.#emitUpdated();
  }

  getState() {
    return {
      config: structuredClone(this.config),
      channels: {
        qq: this.qq.getStatus(),
        wecom: this.wecom.getStatus(),
      },
      engines: this.probeEngines(),
      jobs: this.listJobs(),
    };
  }

  async saveConfig(partial = {}) {
    const prevQq = JSON.stringify(this.config.qq);
    const prevWecom = JSON.stringify(this.config.wecom);
    this.config = normalizeBotConfig(partial, this.config);
    this.#persistConfig();

    this.dispatcher.updateOptions?.({
      allowedWorkspaces: this.config.allowedWorkspaces,
      defaultCwd: this.config.defaultCwd,
      sandboxMode: this.config.sandboxMode,
    });

    const nextQq = JSON.stringify(this.config.qq);
    const nextWecom = JSON.stringify(this.config.wecom);

    if (prevQq !== nextQq || (this.started && this.config.qq.enabled !== this.qq.started)) {
      await this.qq.updateConfig(this.config.qq).catch(() => {});
      if (this.started && this.config.qq.enabled && !this.qq.started) {
        await this.qq.start().catch(() => {});
      }
    }
    if (prevWecom !== nextWecom || (this.started && this.config.wecom.enabled !== this.wecom.started)) {
      await this.wecom.updateConfig(this.config.wecom).catch(() => {});
      if (this.started && this.config.wecom.enabled && !this.wecom.started) {
        await this.wecom.start().catch(() => {});
      }
    }

    this.#emitUpdated();
    return this.getState();
  }

  regeneratePairingCode() {
    this.config.pairingCode = generatePairingCode();
    this.#persistConfig();
    this.#emitUpdated();
    return this.getState();
  }

  authorizeUser({ channel, chatKey, senderId }) {
    const ch = channel === 'wecom' ? 'wecom' : 'qq';
    const id = String(senderId || chatKey || '').trim();
    if (!id) return { authorized: false };
    const current = normalizeStringList(this.config.authorizedUsers?.[ch]);
    if (!current.includes(id)) {
      current.push(id);
      this.config.authorizedUsers[ch] = current;
      this.#persistConfig();
      this.#emitUpdated();
    }
    return { authorized: true, channel: ch, senderId: id };
  }

  isAuthorized(channel, { senderId, groupId, chatKey } = {}) {
    const authSet = new Set(this.config.authorizedUsers?.[channel] || []);
    if (channel === 'qq') {
      const allowUsers = new Set(this.config.qq?.allowUsers || []);
      const allowGroups = new Set(this.config.qq?.allowGroups || []);
      if (senderId && (authSet.has(senderId) || allowUsers.has(senderId))) return true;
      if (chatKey && (authSet.has(chatKey) || allowUsers.has(chatKey))) return true;
      if (groupId && (allowGroups.has(groupId) || allowGroups.has(`group:${groupId}`) || authSet.has(`group:${groupId}`))) {
        return true;
      }
      return false;
    }
    if (channel === 'wecom') {
      const allowUsers = new Set(this.config.wecom?.allowUsers || []);
      if (senderId && (authSet.has(senderId) || allowUsers.has(senderId))) return true;
      if (chatKey && (authSet.has(chatKey) || allowUsers.has(chatKey))) return true;
      return false;
    }
    return false;
  }

  async handleIncomingMessage(msg) {
    const isAuth = this.isAuthorized(msg.channel, {
      senderId: msg.senderId,
      groupId: msg.groupId,
      chatKey: msg.chatKey,
    });

    let replied = false;
    const wrappedReply = async content => {
      if (content == null || content === '') return;
      replied = true;
      await msg.reply(String(content));
    };

    try {
      const result = await this.router.handleMessage({
        channel: msg.channel,
        chatKey: msg.chatKey,
        senderId: msg.senderId,
        senderName: msg.senderName,
        text: msg.text,
        isAuthorized: isAuth,
        pairingCode: this.config.pairingCode,
        reply: wrappedReply,
        onProgress: progress => {
          try {
            msg.onProgress?.(progress);
          } catch {}
        },
      });
      if (!replied && result?.text) {
        await wrappedReply(result.text);
      }
    } catch (err) {
      if (!replied) {
        await msg.reply(`❌ 执行失败：${err?.message || String(err)}`).catch(() => {});
      }
    } finally {
      this.#emitUpdated();
    }
  }

  #isBotDispatched(item) {
    const provider = String(item.provider || '');
    const fullId = String(item.sessionId || '');
    const rawId = fullId.startsWith(`${provider}:`) ? fullId.slice(provider.length + 1) : fullId;
    if (typeof this.dispatcher?.isDispatchedSession === 'function') {
      if (this.dispatcher.isDispatchedSession(fullId) || this.dispatcher.isDispatchedSession(rawId)) {
        return true;
      }
    }
    const dispatched = this.dispatcher?.dispatchedSessionIds;
    if (dispatched && typeof dispatched.has === 'function') {
      if (dispatched.has(fullId) || dispatched.has(rawId) || dispatched.has(`${provider}:${rawId}`)) {
        return true;
      }
    }
    const jobs = this.dispatcher?.listJobs?.(50);
    if (Array.isArray(jobs)) {
      for (const job of jobs) {
        if (!job) continue;
        if (job.sessionId && (job.sessionId === rawId || job.sessionId === fullId)) return true;
        if (job.jobId && (job.jobId === rawId || job.jobId === fullId)) return true;
      }
    }
    return false;
  }

  async #pushAlert(text) {
    const promises = [];
    if (this.config.qq.enabled && this.config.qq.pushTargets.length > 0 && this.qq.isConnected()) {
      promises.push(this.qq.push(text).catch(() => ({ ok: false, sent: 0 })));
    }
    if (this.config.wecom.enabled && (this.config.wecom.pushTargets.length > 0 || this.config.wecom.webhookUrl)) {
      promises.push(this.wecom.push(text).catch(() => ({ ok: false, sent: 0 })));
    }
    if (!promises.length) return 0;
    const results = await Promise.all(promises);
    return results.reduce((sum, res) => sum + (res?.sent || 0), 0);
  }

  async onSnapshot(snapshot) {
    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
    const isColdBoot = !this.hasSeenInitialSnapshot;
    this.hasSeenInitialSnapshot = true;

    const notif = this.config.notifications || DEFAULT_BOT_CONFIG.notifications;
    const cooldownMs = Number.isFinite(Number(notif.cooldownMs)) ? Number(notif.cooldownMs) : 15000;
    const now = Date.now();
    const alerts = [];

    for (const item of items) {
      if (!item || !item.provider || !item.sessionId || !item.status) continue;
      const key = `${item.provider}:${item.sessionId}`;
      const prev = this.lastStatusByKey.get(key);
      const seq = Number.isFinite(Number(item.lastSeq)) ? Number(item.lastSeq) : null;
      const statusChanged = !prev || prev.status !== item.status;
      const seqBumped = Boolean(prev && seq !== null && prev.lastSeq !== null && seq > prev.lastSeq);

      if (!statusChanged && !seqBumped) continue;

      const isTargetStatus = (
        (item.status === 'waiting' && notif.onWaiting !== false)
        || (item.status === 'blocked' && notif.onBlocked !== false)
        || (item.status === 'ready' && notif.onReady !== false)
      );

      let shouldNotify = notif.enabled !== false && isTargetStatus;

      if (shouldNotify && isColdBoot) {
        if (item.status === 'ready') {
          shouldNotify = false;
        } else if (Number.isFinite(Number(item.updatedAt)) && now - Number(item.updatedAt) > COLD_BOOT_STALE_MS) {
          shouldNotify = false;
        }
      }

      if (shouldNotify && this.#isBotDispatched(item)) {
        shouldNotify = false;
      }

      if (shouldNotify && prev?.notifiedAt && now - prev.notifiedAt < cooldownMs) {
        shouldNotify = false;
      }

      if (shouldNotify) {
        alerts.push({ key, item, seq });
      } else {
        this.lastStatusByKey.set(key, {
          status: item.status,
          lastSeq: seq,
          notifiedAt: prev?.notifiedAt || 0,
        });
      }
    }

    if (this.lastStatusByKey.size > 2000) {
      const activeKeys = new Set(items.map(item => `${item.provider}:${item.sessionId}`));
      for (const key of this.lastStatusByKey.keys()) {
        if (!activeKeys.has(key)) {
          this.lastStatusByKey.delete(key);
        }
        if (this.lastStatusByKey.size <= 1000) break;
      }
    }

    let totalSent = 0;
    for (const alert of alerts) {
      const text = formatStatusAlert(alert.item);
      const sent = await this.#pushAlert(text);
      totalSent += sent;
      const prev = this.lastStatusByKey.get(alert.key);
      this.lastStatusByKey.set(alert.key, {
        status: alert.item.status,
        lastSeq: alert.seq,
        notifiedAt: sent > 0 ? now : (prev?.notifiedAt || 0),
      });
    }

    return totalSent;
  }

  async testPush(channelId) {
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
    const text = `[小鑫 Bot] 推送测试成功！\n时间：${timestamp}`;

    if (channelId === 'qq') {
      if (!this.config.qq.enabled) {
        return { ok: false, sent: 0, detail: 'QQ 渠道未启用，请先开启并保存配置' };
      }
      return this.qq.push(text);
    }

    if (channelId === 'wecom') {
      if (!this.config.wecom.enabled) {
        return { ok: false, sent: 0, detail: '企业微信渠道未启用，请先开启并保存配置' };
      }
      return this.wecom.push(text);
    }

    const details = [];
    let totalSent = 0;
    let anyOk = false;

    if (this.config.qq.enabled) {
      const res = await this.qq.push(text);
      totalSent += res.sent || 0;
      if (res.ok) anyOk = true;
      details.push(`QQ: ${res.detail}`);
    }
    if (this.config.wecom.enabled) {
      const res = await this.wecom.push(text);
      totalSent += res.sent || 0;
      if (res.ok) anyOk = true;
      details.push(`企微: ${res.detail}`);
    }

    if (!details.length) {
      return { ok: false, sent: 0, detail: '请先启用 QQ 或企业微信渠道' };
    }
    return {
      ok: anyOk && totalSent > 0,
      sent: totalSent,
      detail: details.join(' | '),
    };
  }

  listJobs(limit = 20) {
    return this.dispatcher.listJobs(limit);
  }

  async stopJob(jobId) {
    const res = await this.dispatcher.stopJob(jobId);
    this.#emitUpdated();
    return res;
  }

  probeEngines() {
    return this.dispatcher.probeEngines();
  }
}

module.exports = {
  BotService,
  DEFAULT_BOT_CONFIG,
  generatePairingCode,
  formatStatusAlert,
  normalizeBotConfig,
};
