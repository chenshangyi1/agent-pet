'use strict';

const os = require('node:os');
const { timingSafeEqual } = require('node:crypto');

const VALID_ENGINES = new Set(['claude', 'codex', 'antigravity', 'dsh']);
const VALID_PET_COMMANDS = new Set(['show', 'hide', 'reset']);
const MAX_REPLY_CHARS = 3200;

const STATUS_BADGES = {
  waiting: '🟠 待确认',
  blocked: '🔴 异常',
  running: '🟢 运行中',
  ready: '✅ 已完成',
  cancelled: '⚪ 已取消',
  idle: '💤 空闲',
  unknown: '❔ 待更新',
};

function normalizeEngine(name) {
  const clean = String(name || '').trim().toLowerCase();
  if (clean === 'agy') return 'antigravity';
  if (clean === 'claude-code' || clean === 'claudecode') return 'claude';
  return clean;
}

function safeCompareCode(supplied, expected) {
  const a = String(supplied || '').trim().toUpperCase();
  const b = String(expected || '').trim().toUpperCase();
  if (a.length < 4 || b.length < 4 || a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function truncateText(text, limit = MAX_REPLY_CHARS) {
  const str = String(text || '').trim();
  if (str.length <= limit) return str;
  return `${str.slice(0, limit - 30).trimEnd()}\n…(回复过长已截断，完整内容请查看桌面端)`;
}

function formatDuration(startedAt, endedAt) {
  const end = endedAt || Date.now();
  const sec = Math.max(0, Math.round((end - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${rem}s`;
}

class CommandRouter {
  constructor({
    dispatcher,
    providers,
    desktopCommand,
    openApp,
    getConfig,
    onAuthorizeUser,
  } = {}) {
    this.dispatcher = dispatcher;
    this.providers = providers || null;
    this.desktopCommand = typeof desktopCommand === 'function' ? desktopCommand : null;
    this.openApp = typeof openApp === 'function' ? openApp : null;
    this.getConfig = typeof getConfig === 'function' ? getConfig : null;
    this.onAuthorizeUser = typeof onAuthorizeUser === 'function' ? onAuthorizeUser : null;
    this.contexts = new Map();
  }

  _getChatKey(channel, chatKey, senderId) {
    if (typeof chatKey === 'string' && chatKey.trim()) return chatKey.trim();
    return `${channel || 'default'}:${senderId || 'anon'}`;
  }

  _getConfigDefaults() {
    const cfg = (this.getConfig && this.getConfig()) || {};
    const defaultEngine = normalizeEngine(cfg.defaultEngine || 'claude');
    return {
      defaultEngine: VALID_ENGINES.has(defaultEngine) ? defaultEngine : 'claude',
      defaultCwd: (typeof cfg.defaultCwd === 'string' && cfg.defaultCwd.trim())
        || this.dispatcher?.defaultCwd
        || os.homedir(),
    };
  }

  _getContext(key) {
    let ctx = this.contexts.get(key);
    if (!ctx) {
      ctx = { sessions: {} };
      this.contexts.set(key, ctx);
    }
    if (!ctx.sessions || typeof ctx.sessions !== 'object') {
      ctx.sessions = {};
    }
    return ctx;
  }

  _effectiveCwd(ctx) {
    return ctx.cwd || this._getConfigDefaults().defaultCwd;
  }

  _effectiveEngine(ctx) {
    return ctx.engine || this._getConfigDefaults().defaultEngine;
  }

  async _sendReply(reply, text, extra = {}) {
    if (typeof reply === 'function') {
      await reply(text);
    }
    return { text, ...extra };
  }

  _helpText(ctx) {
    const engine = this._effectiveEngine(ctx);
    const cwd = this._effectiveCwd(ctx);
    return [
      '🐾 小鑫 Bot 指令速查：',
      '• /claude <任务> 或 @claude <任务> — 派活给 Claude Code',
      '• /codex <任务> 或 @codex <任务> — 派活给 Codex',
      '• /dsh <内容> 或 @dsh <内容> — 派活给 DSH 会话',
      '• /agy <任务> 或 @agy <任务> — 调用 Antigravity（无 CLI 时可用 /open antigravity）',
      '• /run <任务> — 使用当前默认引擎执行',
      '• /status (或 状态/进度) — 查看各 AI Agent 状态与 Bot 任务',
      '• /engines — 查看本机执行引擎就绪情况',
      '• /cd [目录] — 查看或切换工作目录',
      '• /use <引擎> — 切换默认引擎 (claude/codex/antigravity/dsh)',
      '• /new — 开启新会话（清空当前上下文）',
      '• /jobs — 查看最近派活任务',
      '• /stop [jobId] — 停止运行中的任务',
      '• /diff [路径] (或 查看改动) — 查看工作区 Git 改动',
      '• /log [n] (或 提交记录) — 查看最近 Git 提交记录',
      '• /commit <说明> — 暂存并提交当前工作区改动',
      '• /revert [confirm] — 预览或确认撤销未提交改动',
      '• /pet <show|hide|reset> — 控制桌面小鑫显示/隐藏/归位',
      '• /open <agentId> — 打开桌面端应用',
      `当前默认：引擎 ${engine} · 目录 ${cwd}`,
      '💡 直接发普通消息或发送截图/图片，会沿用当前引擎与会话分析处理。',
    ].join('\n');
  }

  async _handleStatus() {
    let snapshot = this.providers?.snapshot || { items: [], sources: [] };
    if (this.providers && typeof this.providers.refresh === 'function') {
      try {
        snapshot = await this.providers.refresh();
      } catch {}
    }

    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
    const sources = Array.isArray(snapshot?.sources) ? snapshot.sources : [];
    const jobs = this.dispatcher && typeof this.dispatcher.listJobs === 'function'
      ? this.dispatcher.listJobs(10)
      : [];

    const interesting = items.filter(item => {
      if (['waiting', 'blocked', 'running'].includes(item.status)) return true;
      if (item.status === 'ready' && item.unread) return true;
      return item.status === 'ready' && Date.now() - Number(item.updatedAt || 0) < 10 * 60_000;
    });

    const lines = [];
    const connectedCount = sources.filter(s => s.connected).length;
    if (sources.length > 0) {
      lines.push(`📊 Agent 状态总览（已连接 ${connectedCount}/${sources.length} 个来源）：`);
    } else {
      lines.push('📊 Agent 状态总览：');
    }

    if (interesting.length === 0) {
      lines.push('• 各 AI Agent 当前均为空闲');
    } else {
      for (const item of interesting.slice(0, 10)) {
        const badge = STATUS_BADGES[item.status] || item.status;
        const label = item.providerLabel || item.provider || 'Agent';
        const title = item.title ? `「${item.title}」` : '';
        const detail = item.detail ? ` — ${item.detail}` : '';
        lines.push(`• [${label}] ${badge}${title}${detail}`);
      }
      if (interesting.length > 10) {
        lines.push(`• …还有 ${interesting.length - 10} 条会话记录`);
      }
    }

    const activeJobs = jobs.filter(j => j.status === 'running');
    const recentJobs = jobs.filter(j => j.status !== 'running').slice(0, 3);
    if (activeJobs.length > 0 || recentJobs.length > 0) {
      lines.push('');
      lines.push(`🤖 Bot 派活任务（运行中 ${activeJobs.length}）：`);
      for (const j of [...activeJobs, ...recentJobs].slice(0, 6)) {
        const icon = j.status === 'running' ? '🟢' : j.status === 'completed' ? '✅' : j.status === 'cancelled' ? '🛑' : '❌';
        lines.push(`• ${icon} ${j.jobId} [${j.engine}] (${formatDuration(j.startedAt, j.endedAt)}) ${j.promptPreview}`);
      }
    } else {
      lines.push('🤖 Bot 派活：暂无运行中任务');
    }

    return lines.join('\n');
  }

  _handleEngines(ctx) {
    const probes = this.dispatcher?.probeEngines ? this.dispatcher.probeEngines() : {};
    const current = this._effectiveEngine(ctx);
    const lines = [`⚙️ 本机执行引擎检测（当前默认：${current}）：`];
    for (const id of ['claude', 'codex', 'antigravity', 'dsh']) {
      const info = probes[id];
      if (!info) continue;
      if (info.available) {
        const modeText = info.mode ? ` [${info.mode}]` : '';
        const pathText = info.path ? ` (${info.path})` : '';
        lines.push(`• ✅ ${info.label || id}${modeText}${pathText}`);
      } else if (info.mode === 'gui-only') {
        lines.push(`• ℹ️ ${info.label || id}：${info.note}`);
      } else {
        lines.push(`• ⚪ ${info.label || id}：未检测到可用 CLI/桥接${info.note ? `（${info.note}）` : ''}`);
      }
    }
    return lines.join('\n');
  }

  _handleJobs() {
    const jobs = this.dispatcher?.listJobs ? this.dispatcher.listJobs(10) : [];
    if (jobs.length === 0) return '📋 暂无派活任务记录。';
    const lines = ['📋 最近 Bot 派活任务：'];
    for (const j of jobs) {
      const icon = j.status === 'running' ? '🟢' : j.status === 'completed' ? '✅' : j.status === 'cancelled' ? '🛑' : '❌';
      const sid = j.sessionId ? ` · 会话 ${j.sessionId.slice(-8)}` : '';
      lines.push(`• ${icon} ${j.jobId} [${j.engine}] ${formatDuration(j.startedAt, j.endedAt)}${sid}\n  ${j.promptPreview}`);
    }
    return lines.join('\n');
  }

  async _dispatchTask({ ctx, engine, prompt, images, reply, onProgress }) {
    if (!this.dispatcher || typeof this.dispatcher.dispatch !== 'function') {
      return this._sendReply(reply, '❌ 任务调度器未初始化', { handled: true, engine });
    }
    const cwd = this._effectiveCwd(ctx);
    const resumeSessionId = ctx.sessions?.[engine] || null;

    const forwardProgress = onProgress
      ? ev => {
          const text = typeof ev === 'string' ? ev : (ev?.text || '');
          const stage = ev?.stage || ev?.type || 'progress';
          onProgress({ ...((ev && typeof ev === 'object') ? ev : {}), stage, text });
        }
      : undefined;

    let result;
    try {
      result = await this.dispatcher.dispatch({
        engine,
        prompt,
        cwd,
        sessionId: resumeSessionId,
        images,
        onProgress: forwardProgress,
      });
    } catch (err) {
      const errText = `❌ 派活失败 (${engine})：${err.message}`;
      return this._sendReply(reply, errText, {
        handled: true,
        engine,
        sessionId: resumeSessionId,
        error: err.message,
      });
    }

    ctx.engine = engine;
    if (result?.sessionId) {
      ctx.sessions[engine] = result.sessionId;
      ctx.sessionId = result.sessionId;
    }

    const sessionHint = result?.sessionId
      ? `\n\n(${result.sessionId} · 可直接发消息继续追问，或发送 /new 开启新会话)`
      : '';

    let formatted;
    if (result?.status === 'cancelled') {
      formatted = `🛑 任务已取消 (${engine}${result.sessionId ? ` · ${result.sessionId}` : ''})`;
    } else if (result?.status === 'failed') {
      const detail = truncateText(result.error || result.text || '未知错误', 2800);
      formatted = `❌ 任务执行失败 (${engine})：${detail}${sessionHint}`;
    } else {
      const body = truncateText(result?.text || '', 3000) || '（执行完成，无文本输出）';
      formatted = `${body}${sessionHint}`;
    }

    return this._sendReply(reply, formatted, {
      handled: true,
      engine,
      sessionId: result?.sessionId || null,
      jobId: result?.jobId || null,
      status: result?.status || 'completed',
    });
  }

  async handleMessage({
    channel,
    chatKey,
    senderId,
    senderName,
    text,
    images,
    isAuthorized,
    pairingCode,
    reply,
    onProgress,
  } = {}) {
    const raw = typeof text === 'string' ? text.trim() : '';
    const validImages = Array.isArray(images)
      ? images.filter(p => typeof p === 'string' && p.trim())
      : [];

    // 1. Pairing must be processed before authorization check.
    if (/^\/pair(?:\s|$)/i.test(raw)) {
      const pairMatch = raw.match(/^\/pair\s+([A-Za-z0-9]{4,16})$/i);
      if (pairMatch && safeCompareCode(pairMatch[1], pairingCode)) {
        if (this.onAuthorizeUser) {
          await this.onAuthorizeUser({ channel, chatKey, senderId, senderName });
        }
        return this._sendReply(
          reply,
          '✅ 配对成功，已授权当前会话使用小鑫 Bot！输入 /help 查看指令。',
          { handled: true, paired: true }
        );
      }
      return this._sendReply(reply, '❌ 配对码无效', { handled: true, paired: false });
    }

    // 2. Authorization gate.
    if (!isAuthorized) {
      return this._sendReply(
        reply,
        '🔒 未授权访问。请先在桌面「小鑫管理窗 → Bot 网关」获取配对码后发送：/pair <配对码>',
        { handled: false, unauthorized: true }
      );
    }

    if (!raw && validImages.length === 0) {
      return { handled: false, text: '' };
    }

    const key = this._getChatKey(channel, chatKey, senderId);
    const ctx = this._getContext(key);

    // 3. Built-in commands.
    if (/^(?:\/help|\/start|帮助|\?|？)$/i.test(raw)) {
      return this._sendReply(reply, this._helpText(ctx), { handled: true });
    }

    if (/^(?:\/status|状态|进度)$/i.test(raw)) {
      const summary = await this._handleStatus();
      return this._sendReply(reply, summary, { handled: true });
    }

    if (/^\/engines?$/i.test(raw)) {
      return this._sendReply(reply, this._handleEngines(ctx), { handled: true });
    }

    const cdMatch = raw.match(/^\/cd(?:\s+([\s\S]+))?$/i);
    if (cdMatch) {
      const target = (cdMatch[1] || '').trim();
      if (!target) {
        return this._sendReply(reply, `📁 当前工作目录：${this._effectiveCwd(ctx)}`, { handled: true });
      }
      try {
        const validated = this.dispatcher.validateWorkspace(target);
        ctx.cwd = validated;
        return this._sendReply(reply, `📁 当前工作目录已切换为：${validated}`, { handled: true });
      } catch (err) {
        return this._sendReply(reply, `❌ 目录切换失败：${err.message}`, { handled: true });
      }
    }

    const useMatch = raw.match(/^\/use(?:\s+([\s\S]+))?$/i);
    if (useMatch) {
      const arg = (useMatch[1] || '').trim();
      if (!arg) {
        return this._sendReply(
          reply,
          `⚙️ 当前默认引擎：${this._effectiveEngine(ctx)}（可选：claude、codex、antigravity、dsh）`,
          { handled: true }
        );
      }
      const nextEngine = normalizeEngine(arg);
      if (!VALID_ENGINES.has(nextEngine)) {
        return this._sendReply(
          reply,
          `❌ 不支持的引擎 "${arg}"，可选：claude、codex、antigravity、dsh`,
          { handled: true }
        );
      }
      ctx.engine = nextEngine;
      if (ctx.sessions[nextEngine]) ctx.sessionId = ctx.sessions[nextEngine];
      else delete ctx.sessionId;
      const probe = this.dispatcher?.probeEngines ? this.dispatcher.probeEngines()[nextEngine] : null;
      const note = probe && !probe.available && probe.note ? `\nℹ️ ${probe.note}` : '';
      return this._sendReply(reply, `✅ 默认引擎已切换为：${nextEngine}${note}`, { handled: true, engine: nextEngine });
    }

    if (/^\/new$/i.test(raw)) {
      delete ctx.sessionId;
      ctx.sessions = {};
      return this._sendReply(reply, '🆕 已开启新会话（上下文已清除，下一条消息将创建新会话）。', { handled: true });
    }

    if (/^\/jobs$/i.test(raw)) {
      return this._sendReply(reply, this._handleJobs(), { handled: true });
    }

    const stopMatch = raw.match(/^\/stop(?:\s+(\S+))?$/i);
    if (stopMatch) {
      const targetJobId = stopMatch[1] ? stopMatch[1].trim() : undefined;
      const res = await this.dispatcher.stopJob(targetJobId);
      const msg = res?.stopped
        ? `🛑 已停止任务 ${res.jobId} (${res.engine})。`
        : `ℹ️ ${res?.reason || '未找到运行中的任务'}`;
      return this._sendReply(reply, msg, { handled: true });
    }

    const diffMatch = raw.match(/^(?:\/diff|查看改动)(?:\s+([\s\S]+))?$/i);
    if (diffMatch) {
      try {
        const out = await this.dispatcher.gitDiff(this._effectiveCwd(ctx), (diffMatch[1] || '').trim());
        return this._sendReply(reply, truncateText(out), { handled: true });
      } catch (err) {
        return this._sendReply(reply, `❌ 查看改动失败：${err.message}`, { handled: true });
      }
    }

    const logMatch = raw.match(/^(?:\/log|提交记录)(?:\s+(\S+))?$/i);
    if (logMatch) {
      try {
        const out = await this.dispatcher.gitLog(this._effectiveCwd(ctx), Number(logMatch[1]) || 5);
        return this._sendReply(reply, truncateText(out), { handled: true });
      } catch (err) {
        return this._sendReply(reply, `❌ 查看提交记录失败：${err.message}`, { handled: true });
      }
    }

    const commitMatch = raw.match(/^\/commit(?:\s+([\s\S]+))?$/i);
    if (commitMatch) {
      const commitMsg = (commitMatch[1] || '').trim();
      if (!commitMsg) {
        return this._sendReply(reply, '用法：/commit <提交说明>', { handled: true });
      }
      try {
        const out = await this.dispatcher.gitCommit(this._effectiveCwd(ctx), commitMsg);
        return this._sendReply(reply, truncateText(out), { handled: true });
      } catch (err) {
        return this._sendReply(reply, `❌ 提交失败：${err.message}`, { handled: true });
      }
    }

    const revertMatch = raw.match(/^\/revert(?:\s+([\s\S]+))?$/i);
    if (revertMatch) {
      const arg = (revertMatch[1] || '').trim().toLowerCase();
      if (arg && arg !== 'confirm') {
        return this._sendReply(reply, '用法：/revert 查看将丢弃的改动，确认后发送 /revert confirm', { handled: true });
      }
      try {
        const out = await this.dispatcher.gitRevert(this._effectiveCwd(ctx), arg === 'confirm');
        return this._sendReply(reply, truncateText(out), { handled: true });
      } catch (err) {
        return this._sendReply(reply, `❌ 撤销失败：${err.message}`, { handled: true });
      }
    }

    const petMatch = raw.match(/^\/pet(?:\s+(\S+))?$/i);
    if (petMatch) {
      const subcmd = (petMatch[1] || '').trim().toLowerCase();
      if (!VALID_PET_COMMANDS.has(subcmd)) {
        return this._sendReply(reply, '用法：/pet <show|hide|reset>', { handled: true });
      }
      if (!this.desktopCommand) {
        return this._sendReply(reply, 'ℹ️ 当前未连接桌面端小鑫，无法执行桌宠操作。', { handled: true });
      }
      try {
        await this.desktopCommand(subcmd);
        const label = subcmd === 'show' ? '显示小鑫' : subcmd === 'hide' ? '隐藏小鑫' : '归位小鑫';
        return this._sendReply(reply, `🐾 已执行桌宠操作：${label}`, { handled: true });
      } catch (err) {
        return this._sendReply(reply, `⚠️ 桌宠操作失败：${err.message}`, { handled: true });
      }
    }

    const openMatch = raw.match(/^\/open(?:\s+(\S+))?$/i);
    if (openMatch) {
      const agentId = normalizeEngine(openMatch[1] || '');
      if (!agentId) {
        return this._sendReply(reply, '用法：/open <agentId>（例如：/open antigravity、/open claude、/open cursor）', { handled: true });
      }
      if (!this.openApp) {
        return this._sendReply(reply, 'ℹ️ 当前为纯后台模式，无法打开桌面应用。', { handled: true });
      }
      try {
        await this.openApp(agentId);
        return this._sendReply(reply, `🚀 已打开 ${agentId}`, { handled: true });
      } catch (err) {
        return this._sendReply(reply, `⚠️ 打开 ${agentId} 失败：${err.message}`, { handled: true });
      }
    }

    // 4. Direct engine dispatch commands: /claude, @claude, /codex, @codex, /antigravity, /agy, @antigravity, @agy, /dsh, @dsh, /run
    const engineCmdMatch = raw.match(/^(?:\/|@)(claude|codex|antigravity|agy|dsh|run)(?:(?:\s+|[:：]\s*)([\s\S]*))?$/i);
    if (engineCmdMatch) {
      const rawCmd = engineCmdMatch[1].toLowerCase();
      const prompt = (engineCmdMatch[2] || '').trim()
        || (validImages.length > 0 ? '请分析这张图片中的问题并给出解决方案' : '');
      const targetEngine = rawCmd === 'run'
        ? this._effectiveEngine(ctx)
        : normalizeEngine(rawCmd);

      if (!prompt) {
        return this._sendReply(reply, `请在指令后输入任务内容，例如：/${rawCmd} 检查当前目录状态`, { handled: true });
      }
      return this._dispatchTask({ ctx, engine: targetEngine, prompt, images: validImages, reply, onProgress });
    }

    // Reject unknown slash commands cleanly rather than forwarding them as prompts.
    if (raw.startsWith('/')) {
      const unknownCmd = raw.split(/\s+/)[0];
      return this._sendReply(reply, `❓ 未知指令 "${unknownCmd}"，发送 /help 查看全部可用指令。`, { handled: true });
    }

    // 5. Plain text (or image-only) message -> follow up with chat's bound engine & sessionId.
    const defaultEngine = this._effectiveEngine(ctx);
    const effectivePrompt = raw || '请分析这张图片中的问题并给出解决方案';
    return this._dispatchTask({ ctx, engine: defaultEngine, prompt: effectivePrompt, images: validImages, reply, onProgress });
  }
}

module.exports = { CommandRouter };
