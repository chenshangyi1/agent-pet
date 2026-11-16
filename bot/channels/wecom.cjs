'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const DEFAULT_WECOM_WS_URL = 'wss://openws.work.weixin.qq.com';
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const DEFAULT_HEARTBEAT_MS = 30000;
const STREAM_THROTTLE_MS = 800;
const MAX_STREAM_CHARS = 16000;

function genReqId(prefix = 'pet') {
  return `${prefix}-${crypto.randomUUID()}`;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeList(list) {
  if (Array.isArray(list)) {
    return list.map(v => String(v ?? '').trim()).filter(Boolean);
  }
  if (typeof list === 'string') {
    return list.split(/[\n,;]+/).map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function buildSubscribeFrame({ botId, secret, reqId = genReqId('sub') } = {}) {
  return {
    cmd: 'aibot_subscribe',
    headers: { req_id: String(reqId) },
    body: {
      bot_id: String(botId || ''),
      secret: String(secret || ''),
    },
  };
}

function buildPingFrame({ reqId = genReqId('ping') } = {}) {
  return {
    cmd: 'ping',
    headers: { req_id: String(reqId) },
  };
}

function buildRespondStreamFrame({ reqId, streamId, content, finish = true } = {}) {
  return {
    cmd: 'aibot_respond_msg',
    headers: { req_id: String(reqId || '') },
    body: {
      msgtype: 'stream',
      stream: {
        id: String(streamId || genReqId('stream')),
        finish: Boolean(finish),
        content: String(content ?? ''),
      },
    },
  };
}

function buildSendMsgFrame({ chatId, content, msgtype = 'markdown', reqId = genReqId('send') } = {}) {
  const cleanChatId = String(chatId || '').replace(/^(?:group|single|user):/, '').trim();
  const type = msgtype === 'text' ? 'text' : 'markdown';
  return {
    cmd: 'aibot_send_msg',
    headers: { req_id: String(reqId) },
    body: {
      chatid: cleanChatId,
      msgtype: type,
      [type]: {
        content: String(content ?? ''),
      },
    },
  };
}

function extractRawCallbackText(body = {}) {
  if (typeof body.text?.content === 'string') return body.text.content;
  if (typeof body.markdown?.content === 'string') return body.markdown.content;
  if (Array.isArray(body.mixed?.msg_item)) {
    return body.mixed.msg_item
      .map(item => (item?.msgtype === 'text' ? String(item.text?.content || '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof body.content === 'string') return body.content;
  return '';
}

function parseCallbackFrame(frame, options = {}) {
  let obj = frame;
  if (typeof frame === 'string') {
    try {
      obj = JSON.parse(frame);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || obj.cmd !== 'aibot_msg_callback') {
    return null;
  }

  const reqId = String(obj.headers?.req_id || '');
  const body = obj.body && typeof obj.body === 'object' ? obj.body : {};
  const senderId = String(body.from?.userid || body.from_user_id || '');
  const senderName = String(body.from?.name || body.from?.alias || senderId);
  const rawChatType = body.chattype || body.chat_type;
  const rawChatId = body.chatid || body.chat_id || '';
  const chattype = rawChatType === 'single'
    ? 'single'
    : (rawChatType === 'group' || (rawChatId && rawChatId !== senderId) ? 'group' : 'single');
  const chatId = String(rawChatId || senderId);
  const chatKey = chattype === 'group' ? `group:${chatId}` : `single:${senderId || chatId}`;

  let text = extractRawCallbackText(body).trim();
  if (chattype === 'group' && text) {
    const botName = String(options.botName || '').trim();
    if (botName) {
      const explicitRe = new RegExp(`^@${escapeRegExp(botName)}(?:\\s+|$)`, 'i');
      text = text.replace(explicitRe, '').trim();
    }
    text = text.replace(/^@(?!(?:claude|codex|antigravity|agy|dsh)\b)[^\s@]+\s+/i, '').trim();
  }

  return {
    reqId,
    msgId: String(body.msgid || body.msg_id || ''),
    msgtype: String(body.msgtype || 'text'),
    chattype,
    chatId,
    chatKey,
    senderId,
    senderName,
    text,
    raw: obj,
  };
}

function chunkMarkdown(text, maxLen = MAX_STREAM_CHARS) {
  const str = String(text ?? '');
  if (!str) return [];
  if (str.length <= maxLen) return [str];
  const chunks = [];
  let cursor = 0;
  while (cursor < str.length) {
    let end = Math.min(cursor + maxLen, str.length);
    if (end < str.length) {
      const nl = str.lastIndexOf('\n', end);
      if (nl > cursor + Math.floor(maxLen * 0.5)) {
        end = nl + 1;
      }
    }
    chunks.push(str.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

class WeComAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = this.#normalizeConfig(options.config || options);
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.started = false;
    this.subscribed = false;
    this.subscribeReqId = '';
    this.status = 'disconnected';
    this.detail = '未启用';
    this.lastError = '';
    this.ws = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.backoffMs = INITIAL_BACKOFF_MS;
  }

  #normalizeConfig(cfg = {}) {
    return {
      enabled: Boolean(cfg.enabled),
      wsUrl: String(cfg.wsUrl || DEFAULT_WECOM_WS_URL).trim() || DEFAULT_WECOM_WS_URL,
      botId: String(cfg.botId || '').trim(),
      secret: String(cfg.secret || '').trim(),
      botName: String(cfg.botName || '').trim(),
      webhookUrl: String(cfg.webhookUrl || '').trim(),
      allowUsers: normalizeList(cfg.allowUsers),
      pushTargets: normalizeList(cfg.pushTargets),
      heartbeatMs: Number.isFinite(Number(cfg.heartbeatMs)) ? Number(cfg.heartbeatMs) : DEFAULT_HEARTBEAT_MS,
      streamThrottleMs: Number.isFinite(Number(cfg.streamThrottleMs)) ? Number(cfg.streamThrottleMs) : STREAM_THROTTLE_MS,
    };
  }

  #setStatus(status, detail, lastError = '') {
    this.status = status;
    this.detail = detail;
    this.lastError = lastError;
    this.emit('status', this.getStatus());
  }

  getStatus() {
    return {
      enabled: this.config.enabled,
      status: this.status,
      state: this.status,
      detail: this.detail,
      lastError: this.lastError || undefined,
      subscribed: this.subscribed,
      webhookConfigured: Boolean(this.config.webhookUrl),
    };
  }

  isWsConnected() {
    const openState = this.WebSocketImpl?.OPEN ?? 1;
    return Boolean(this.ws && this.ws.readyState === openState);
  }

  async updateConfig(nextConfig) {
    this.config = this.#normalizeConfig(nextConfig);
    if (this.started) {
      await this.stop();
      if (this.config.enabled) {
        await this.start();
      } else {
        this.#setStatus('disconnected', '未启用');
      }
    } else if (!this.config.enabled) {
      this.#setStatus('disconnected', '未启用');
    }
  }

  async start() {
    if (!this.config.enabled) {
      this.started = false;
      this.#setStatus('disconnected', '未启用');
      return this.getStatus();
    }
    this.started = true;
    this.backoffMs = INITIAL_BACKOFF_MS;

    if (!this.config.botId || !this.config.secret) {
      if (this.config.webhookUrl) {
        this.#setStatus('connected', '仅 Webhook 推送模式（未配置长连接 BotID / Secret）');
      } else {
        this.#setStatus('error', '请配置 BotID / Secret 或 Webhook URL', 'Missing botId/secret');
      }
      return this.getStatus();
    }

    if (this.ws) {
      return this.getStatus();
    }

    this.#connectWs();
    return this.getStatus();
  }

  async stop() {
    this.started = false;
    this.subscribed = false;
    this.subscribeReqId = '';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(); } catch {}
    }
    this.#setStatus('disconnected', this.config.enabled ? '已断开' : '未启用');
  }

  #scheduleReconnect() {
    if (!this.started || !this.config.enabled || !this.config.botId || !this.config.secret) return;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started && this.config.enabled && this.config.botId && this.config.secret) {
        this.#connectWs();
      }
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  #startHeartbeat(ws) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || !this.isWsConnected()) return;
      try {
        ws.send(JSON.stringify(buildPingFrame()));
      } catch {}
    }, this.config.heartbeatMs);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  #connectWs() {
    if (typeof this.WebSocketImpl !== 'function') {
      this.#setStatus('error', '当前 Node 环境不支持全局 WebSocket', 'WebSocket unavailable');
      return;
    }

    this.#setStatus('connecting', `正在连接 ${this.config.wsUrl}`);
    let ws;
    try {
      ws = new this.WebSocketImpl(this.config.wsUrl);
    } catch (err) {
      this.#setStatus('error', `连接失败：${err.message}`, err.message);
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.subscribed = false;

    const handleOpen = () => {
      if (this.ws !== ws) return;
      this.backoffMs = INITIAL_BACKOFF_MS;
      const reqId = genReqId('sub');
      this.subscribeReqId = reqId;
      const subFrame = buildSubscribeFrame({
        botId: this.config.botId,
        secret: this.config.secret,
        reqId,
      });
      try {
        ws.send(JSON.stringify(subFrame));
        this.#startHeartbeat(ws);
        this.#setStatus('connected', '企业微信长连接已建立');
      } catch (err) {
        this.#setStatus('error', `订阅握手失败：${err.message}`, err.message);
      }
    };

    const handleMessage = async event => {
      if (this.ws !== ws) return;
      let raw = event?.data;
      if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
        raw = Buffer.from(raw instanceof ArrayBuffer ? raw : raw.buffer, raw.byteOffset || 0, raw.byteLength).toString('utf8');
      } else if (typeof Blob !== 'undefined' && raw instanceof Blob) {
        raw = await raw.text();
      }
      this.#handleIncomingRaw(String(raw ?? ''));
    };

    const handleError = event => {
      if (this.ws !== ws) return;
      const msg = event?.error?.message || event?.message || '企业微信 WebSocket 异常';
      this.#setStatus('error', `连接异常：${msg}`, msg);
    };

    const handleClose = event => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.subscribed = false;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.started && this.config.enabled) {
        const reason = event?.reason ? ` (${event.reason})` : '';
        if (this.status !== 'error') {
          this.#setStatus('disconnected', `长连接已断开${reason}，等待重连`);
        }
        this.#scheduleReconnect();
      } else {
        this.#setStatus('disconnected', '已断开');
      }
    };

    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', handleOpen);
      ws.addEventListener('message', handleMessage);
      ws.addEventListener('error', handleError);
      ws.addEventListener('close', handleClose);
    } else {
      ws.onopen = handleOpen;
      ws.onmessage = handleMessage;
      ws.onerror = handleError;
      ws.onclose = handleClose;
    }
  }

  #sendWsJson(frame) {
    if (!this.isWsConnected()) {
      throw new Error('企业微信 WebSocket 未连接');
    }
    this.ws.send(JSON.stringify(frame));
  }

  #handleIncomingRaw(rawText) {
    let frame;
    try {
      frame = JSON.parse(rawText);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;

    const ackReqId = String(frame.headers?.req_id || '');
    if (typeof frame.errcode === 'number') {
      if (ackReqId && ackReqId === this.subscribeReqId) {
        if (frame.errcode === 0) {
          this.subscribed = true;
          this.#setStatus('connected', '企业微信智能机器人已订阅就绪');
        } else {
          this.subscribed = false;
          const errMsg = frame.errmsg || `errcode ${frame.errcode}`;
          this.#setStatus('error', `企业微信订阅失败：${errMsg}`, errMsg);
        }
        return;
      }
      if (frame.errcode !== 0) {
        const errMsg = frame.errmsg || `errcode ${frame.errcode}`;
        this.lastError = errMsg;
        if (this.listenerCount('error') > 0) this.emit('error', new Error(`WeCom API 错误: ${errMsg}`));
      }
      return;
    }

    if (frame.cmd === 'pong') return;

    const parsed = parseCallbackFrame(frame, { botName: this.config.botName });
    if (!parsed || !parsed.text) return;

    const streamId = genReqId('stream');
    let streamFinished = false;
    let lastStreamSentAt = 0;
    let pendingTimer = null;
    let latestProgressText = '';
    const progressLog = [];

    const flushProgress = () => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (streamFinished || !latestProgressText || !this.isWsConnected()) return;
      lastStreamSentAt = Date.now();
      try {
        this.#sendWsJson(buildRespondStreamFrame({
          reqId: parsed.reqId,
          streamId,
          content: latestProgressText.slice(0, MAX_STREAM_CHARS),
          finish: false,
        }));
      } catch {}
    };

    const reply = async text => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      const chunks = chunkMarkdown(String(text || '（无输出）'), MAX_STREAM_CHARS);
      const first = chunks[0] || '（无输出）';
      if (!streamFinished) {
        streamFinished = true;
        this.#sendWsJson(buildRespondStreamFrame({
          reqId: parsed.reqId,
          streamId,
          content: first,
          finish: true,
        }));
      } else if (parsed.chatId) {
        await this.sendMessage(parsed.chatId, first);
      }
      for (let i = 1; i < chunks.length; i++) {
        if (parsed.chatId) {
          await this.sendMessage(parsed.chatId, chunks[i]);
        }
      }
    };

    const onProgress = progress => {
      if (streamFinished) return;
      const line = typeof progress === 'string' ? progress.trim() : String(progress?.text || '').trim();
      if (!line) return;
      if (progressLog[progressLog.length - 1] !== line) {
        progressLog.push(line);
        if (progressLog.length > 6) progressLog.shift();
      }
      latestProgressText = `⏳ **小鑫正在执行...**\n\n${progressLog.map(item => `- ${item}`).join('\n')}`;
      const elapsed = Date.now() - lastStreamSentAt;
      if (elapsed >= this.config.streamThrottleMs) {
        flushProgress();
      } else if (!pendingTimer) {
        pendingTimer = setTimeout(flushProgress, this.config.streamThrottleMs - elapsed);
        if (typeof pendingTimer.unref === 'function') pendingTimer.unref();
      }
    };

    const msg = {
      channel: 'wecom',
      chatKey: parsed.chatKey,
      messageType: parsed.chattype,
      chatId: parsed.chatId,
      reqId: parsed.reqId,
      senderId: parsed.senderId,
      senderName: parsed.senderName,
      text: parsed.text,
      raw: frame,
      reply,
      onProgress,
    };

    this.emit('message', msg);
    if (this.onMessage) {
      Promise.resolve(this.onMessage(msg)).catch(err => {
        if (this.listenerCount('error') > 0) this.emit('error', err);
      });
    }
  }

  async sendMessage(target, text) {
    const chunks = chunkMarkdown(text, MAX_STREAM_CHARS);
    if (!chunks.length) return;
    for (const chunk of chunks) {
      this.#sendWsJson(buildSendMsgFrame({
        chatId: target,
        content: chunk,
        msgtype: 'markdown',
      }));
    }
  }

  async sendWebhook(text) {
    if (!this.config.webhookUrl) {
      throw new Error('未配置企业微信 Webhook URL');
    }
    let parsed;
    try {
      parsed = new URL(this.config.webhookUrl);
    } catch {
      throw new Error('企业微信 Webhook URL 格式无效');
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error('企业微信 Webhook URL 协议无效');
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('当前环境不支持 fetch');
    }
    const response = await this.fetchImpl(parsed.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: String(text ?? '') },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || (typeof payload.errcode === 'number' && payload.errcode !== 0)) {
      throw new Error(payload.errmsg || `Webhook HTTP ${response.status}`);
    }
    return payload;
  }

  async push(text) {
    const targets = this.config.pushTargets;
    const hasWebhook = Boolean(this.config.webhookUrl);
    if (!targets.length && !hasWebhook) {
      return { ok: false, sent: 0, detail: '未配置企业微信推送目标 (pushTargets) 或 Webhook URL' };
    }

    let sent = 0;
    const errors = [];

    if (targets.length > 0) {
      if (this.isWsConnected()) {
        for (const target of targets) {
          try {
            await this.sendMessage(target, text);
            sent++;
          } catch (err) {
            errors.push(`${target}: ${err.message}`);
          }
        }
      } else if (!hasWebhook) {
        return { ok: false, sent: 0, detail: this.detail || '企业微信 WebSocket 未连接' };
      } else {
        errors.push('长连接未建立，已跳过 pushTargets');
      }
    }

    if (hasWebhook) {
      try {
        await this.sendWebhook(text);
        sent++;
      } catch (err) {
        errors.push(`Webhook: ${err.message}`);
      }
    }

    return {
      ok: sent > 0 && errors.length === 0,
      sent,
      total: targets.length + (hasWebhook ? 1 : 0),
      detail: errors.length ? errors.join('; ') : `已推送至企业微信 (${sent} 个目标)`,
    };
  }
}

module.exports = {
  WeComAdapter,
  DEFAULT_WECOM_WS_URL,
  buildSubscribeFrame,
  buildPingFrame,
  buildRespondStreamFrame,
  buildSendMsgFrame,
  parseCallbackFrame,
  chunkMarkdown,
};
