'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_LEN = 3500;
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;

function computeWebSocketAccept(secWebSocketKey) {
  return crypto
    .createHash('sha1')
    .update(String(secWebSocketKey || '') + WS_GUID, 'utf8')
    .digest('base64');
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function encodeWsFrame(payload, options = {}) {
  const { opcode = 0x1, fin = true, mask = false } = options;
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(String(payload ?? ''), 'utf8');
  const len = body.length;
  const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  const maskBit = mask ? 0x80 : 0x00;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = firstByte;
    header[1] = maskBit | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  if (!mask) {
    return Buffer.concat([header, body]);
  }

  const maskKey = crypto.randomBytes(4);
  const maskedBody = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    maskedBody[i] = body[i] ^ maskKey[i & 3];
  }
  return Buffer.concat([header, maskKey, maskedBody]);
}

function decodeWsFrames(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = (b0 & 0x70) >> 4;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let cursor = offset + 2;

    if (payloadLen === 126) {
      if (cursor + 2 > buf.length) break;
      payloadLen = buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLen === 127) {
      if (cursor + 8 > buf.length) break;
      const bigLen = buf.readBigUInt64BE(cursor);
      if (bigLen > BigInt(MAX_FRAME_BYTES)) {
        throw new Error(`WebSocket frame exceeds ${MAX_FRAME_BYTES} bytes`);
      }
      payloadLen = Number(bigLen);
      cursor += 8;
    }

    if (payloadLen > MAX_FRAME_BYTES) {
      throw new Error(`WebSocket frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }

    let maskKey = null;
    if (masked) {
      if (cursor + 4 > buf.length) break;
      maskKey = buf.subarray(cursor, cursor + 4);
      cursor += 4;
    }

    if (cursor + payloadLen > buf.length) break;

    let payload = buf.subarray(cursor, cursor + payloadLen);
    if (masked) {
      const unmasked = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i] ^ maskKey[i & 3];
      }
      payload = unmasked;
    } else {
      payload = Buffer.from(payload);
    }

    const frame = { fin, rsv, opcode, masked, payload };
    if (opcode === 0x1 && fin) {
      frame.text = payload.toString('utf8');
    }
    frames.push(frame);
    offset = cursor + payloadLen;
  }

  return {
    frames,
    rest: offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0),
  };
}

function unescapeCQ(text) {
  return String(text || '')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

function stripCQCodeText(raw, effectiveSelfId) {
  let mentioned = false;
  let text = String(raw || '').replace(/\[CQ:([a-zA-Z0-9_-]+)(?:,([^\]]*))?\]/g, (_full, type, paramsRaw = '') => {
    if (type === 'at') {
      const qqMatch = /(?:^|,)qq=([^,\]]+)/.exec(paramsRaw);
      const qq = qqMatch ? qqMatch[1].trim() : '';
      if (effectiveSelfId && qq === effectiveSelfId) {
        mentioned = true;
        return '';
      }
      const nameMatch = /(?:^|,)name=([^,\]]+)/.exec(paramsRaw);
      if (nameMatch && nameMatch[1]) return `@${unescapeCQ(nameMatch[1].trim())} `;
      return qq ? `@${qq} ` : '';
    }
    return '';
  });
  text = unescapeCQ(text);
  if (effectiveSelfId) {
    const escapedSelf = effectiveSelfId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selfAtRe = new RegExp(`^@${escapedSelf}(?=\\s|$)\\s*`);
    if (selfAtRe.test(text)) {
      mentioned = true;
      text = text.replace(selfAtRe, '');
    }
  }
  return { text: text.trim(), mentioned };
}

function extractOneBotText(event, fallbackSelfId = '') {
  if (!event || event.post_type !== 'message') return null;

  const effectiveSelfId = event.self_id != null
    ? String(event.self_id)
    : (fallbackSelfId ? String(fallbackSelfId) : '');
  const messageType = event.message_type === 'group' ? 'group' : 'private';
  const userId = event.user_id != null ? String(event.user_id) : '';
  const groupId = messageType === 'group' && event.group_id != null ? String(event.group_id) : '';
  const chatKey = messageType === 'group' ? `group:${groupId}` : `private:${userId}`;
  const senderName = String(event.sender?.card || event.sender?.nickname || userId || '');

  let mentioned = false;
  let text = '';

  if (Array.isArray(event.message) && event.message.length > 0) {
    const parts = [];
    for (const seg of event.message) {
      if (!seg || typeof seg !== 'object') continue;
      if (seg.type === 'text') {
        parts.push(String(seg.data?.text ?? ''));
      } else if (seg.type === 'at') {
        const qq = seg.data?.qq != null ? String(seg.data.qq) : '';
        if (effectiveSelfId && qq === effectiveSelfId) {
          mentioned = true;
        } else if (seg.data?.name) {
          parts.push(`@${seg.data.name} `);
        } else if (qq) {
          parts.push(`@${qq} `);
        }
      }
    }
    text = parts.join('').trim();
    if (effectiveSelfId) {
      const escapedSelf = effectiveSelfId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const selfAtRe = new RegExp(`^@${escapedSelf}(?=\\s|$)\\s*`);
      if (selfAtRe.test(text)) {
        mentioned = true;
        text = text.replace(selfAtRe, '').trim();
      }
    }
  } else {
    const raw = typeof event.message === 'string' && event.message
      ? event.message
      : String(event.raw_message || '');
    const parsed = stripCQCodeText(raw, effectiveSelfId);
    text = parsed.text;
    mentioned = parsed.mentioned;
  }

  return {
    text,
    mentioned,
    isPrivate: messageType === 'private',
    isGroup: messageType === 'group',
    messageType,
    userId,
    groupId,
    selfId: effectiveSelfId,
    senderName,
    chatKey,
  };
}

function chunkText(text, maxLen = MAX_CHUNK_LEN) {
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

function parseOneBotTarget(target) {
  if (target && typeof target === 'object') {
    const type = target.type === 'group' ? 'group' : 'private';
    const id = String(target.id ?? '').trim();
    if (!id) throw new Error('QQ 发送目标为空');
    return { type, id };
  }
  const raw = String(target ?? '').trim();
  if (!raw) throw new Error('QQ 发送目标为空');
  if (raw.startsWith('group:')) {
    const id = raw.slice('group:'.length).trim();
    if (!id) throw new Error('QQ 群目标 ID 为空');
    return { type: 'group', id };
  }
  if (raw.startsWith('private:')) {
    const id = raw.slice('private:'.length).trim();
    if (!id) throw new Error('QQ 私聊目标 ID 为空');
    return { type: 'private', id };
  }
  return { type: 'private', id: raw };
}

function normalizeTargetList(list) {
  if (Array.isArray(list)) {
    return list.map(v => String(v ?? '').trim()).filter(Boolean);
  }
  if (typeof list === 'string') {
    return list.split(/[\n,;]+/).map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function toOneBotId(id) {
  const s = String(id).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  return s;
}

function normalizePath(p) {
  const raw = String(p || '/onebot/v11/ws').trim() || '/';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

class QQOneBotAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = this.#normalizeConfig(options.config || options);
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.started = false;
    this.selfId = '';
    this.status = 'disconnected';
    this.detail = '未启用';
    this.lastError = '';
    this.ws = null;
    this.httpServer = null;
    this.serverClients = new Set();
    this.activeServerClient = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.pendingEchoes = new Map();
    this.echoSeq = 0;
  }

  #normalizeConfig(cfg = {}) {
    const mode = cfg.mode === 'server' ? 'server' : 'client';
    return {
      enabled: Boolean(cfg.enabled),
      mode,
      wsUrl: String(cfg.wsUrl || 'ws://127.0.0.1:3001').trim() || 'ws://127.0.0.1:3001',
      listenHost: String(cfg.listenHost || cfg.host || '127.0.0.1').trim() || '127.0.0.1',
      listenPort: Number.isFinite(Number(cfg.listenPort)) ? Number(cfg.listenPort) : 8080,
      listenPath: normalizePath(cfg.listenPath || '/onebot/v11/ws'),
      accessToken: String(cfg.accessToken || ''),
      allowUsers: normalizeTargetList(cfg.allowUsers),
      allowGroups: normalizeTargetList(cfg.allowGroups),
      groupRequireMention: cfg.groupRequireMention !== false,
      pushTargets: normalizeTargetList(cfg.pushTargets),
      actionTimeoutMs: Number.isFinite(Number(cfg.actionTimeoutMs)) ? Number(cfg.actionTimeoutMs) : 10000,
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
      mode: this.config.mode,
      status: this.status,
      state: this.status,
      detail: this.detail,
      lastError: this.lastError || undefined,
      selfId: this.selfId || undefined,
      port: this.httpServer?.address()?.port,
    };
  }

  isConnected() {
    if (this.config.mode === 'server') {
      return Boolean(this.activeServerClient && !this.activeServerClient.closed && !this.activeServerClient.socket.destroyed);
    }
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
    if (this.started && (this.ws || this.httpServer)) {
      return this.getStatus();
    }
    this.started = true;
    this.backoffMs = INITIAL_BACKOFF_MS;
    if (this.config.mode === 'server') {
      await this.#startServer();
    } else {
      this.#startClient();
    }
    return this.getStatus();
  }

  async stop() {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.#rejectAllPending(new Error('QQ OneBot 连接已停止'));

    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(); } catch {}
    }

    for (const client of this.serverClients) {
      client.close(1001, 'Server stopping');
    }
    this.serverClients.clear();
    this.activeServerClient = null;

    if (this.httpServer) {
      const srv = this.httpServer;
      this.httpServer = null;
      await new Promise(resolve => {
        try { srv.close(() => resolve()); } catch { resolve(); }
      });
    }

    this.#setStatus('disconnected', this.config.enabled ? '已断开' : '未启用');
  }

  #rejectAllPending(err) {
    for (const [echo, entry] of this.pendingEchoes) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pendingEchoes.delete(echo);
    }
  }

  #scheduleReconnect() {
    if (!this.started || !this.config.enabled || this.config.mode !== 'client') return;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started && this.config.enabled && this.config.mode === 'client') {
        this.#startClient();
      }
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  #buildClientUrl() {
    const parsed = new URL(this.config.wsUrl);
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    if (!['ws:', 'wss:'].includes(parsed.protocol)) {
      throw new Error(`无效的 QQ WebSocket 地址: ${this.config.wsUrl}`);
    }
    if (this.config.accessToken && !parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', this.config.accessToken);
    }
    return parsed.toString();
  }

  #startClient() {
    if (typeof this.WebSocketImpl !== 'function') {
      this.#setStatus('error', '当前 Node 环境不支持全局 WebSocket', 'WebSocket unavailable');
      return;
    }
    let url;
    try {
      url = this.#buildClientUrl();
    } catch (err) {
      this.#setStatus('error', err.message, err.message);
      return;
    }

    this.#setStatus('connecting', `正在连接 ${this.config.wsUrl}`);
    let ws;
    try {
      ws = new this.WebSocketImpl(url);
    } catch (err) {
      this.#setStatus('error', `连接失败：${err.message}`, err.message);
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    const handleOpen = () => {
      if (this.ws !== ws) return;
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.#setStatus('connected', `正向 WS 已连接 (${this.config.wsUrl})`);
    };

    const handleMessage = async event => {
      if (this.ws !== ws) return;
      let raw = event?.data;
      if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
        raw = Buffer.from(raw instanceof ArrayBuffer ? raw : raw.buffer, raw.byteOffset || 0, raw.byteLength).toString('utf8');
      } else if (typeof Blob !== 'undefined' && raw instanceof Blob) {
        raw = await raw.text();
      }
      this.#handleIncomingPayload(String(raw ?? ''));
    };

    const handleError = event => {
      if (this.ws !== ws) return;
      const msg = event?.error?.message || event?.message || 'WebSocket 连接异常';
      this.#setStatus('error', `连接异常：${msg}`, msg);
    };

    const handleClose = event => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.#rejectAllPending(new Error('QQ WebSocket 连接已断开'));
      if (this.started && this.config.enabled) {
        const reason = event?.reason ? ` (${event.reason})` : '';
        if (this.status !== 'error') {
          this.#setStatus('disconnected', `连接已断开${reason}，等待重连`);
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

  async #startServer() {
    const host = this.config.listenHost;
    const port = this.config.listenPort;
    const targetPath = this.config.listenPath;

    const server = http.createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('OneBot v11 Reverse WebSocket endpoint expects WebSocket Upgrade');
    });

    server.on('upgrade', (req, socket, head) => {
      let reqUrl;
      try {
        reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      if (normalizePath(reqUrl.pathname) !== targetPath) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      if (this.config.accessToken) {
        const authHeader = String(req.headers.authorization || '');
        const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
        const bearerToken = bearerMatch ? bearerMatch[1].trim() : '';
        const queryToken = reqUrl.searchParams.get('access_token') || '';
        const tokenOk = (bearerToken && timingSafeStringEqual(bearerToken, this.config.accessToken))
          || (queryToken && timingSafeStringEqual(queryToken, this.config.accessToken));
        if (!tokenOk) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      const upgradeHeader = String(req.headers.upgrade || '').toLowerCase();
      const wsKey = String(req.headers['sec-websocket-key'] || '').trim();
      if (upgradeHeader !== 'websocket' || !wsKey) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const accept = computeWebSocketAccept(wsKey);
      socket.setNoDelay(true);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );

      this.#attachServerClient(socket, head, req.headers['x-self-id']);
    });

    this.httpServer = server;
    await new Promise((resolve, reject) => {
      const onError = err => {
        server.off('listening', onListening);
        this.httpServer = null;
        this.#setStatus('error', `反向 WS 监听失败 (${host}:${port}): ${err.message}`, err.message);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address();
        const actualPort = addr && typeof addr === 'object' ? addr.port : port;
        this.#setStatus('listening', `反向 WS 监听中 ws://${host}:${actualPort}${targetPath}`);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

    server.on('error', err => {
      this.#setStatus('error', `反向 WS 运行异常: ${err.message}`, err.message);
    });

    this.heartbeatTimer = setInterval(() => {
      for (const client of this.serverClients) {
        if (!client.closed && !client.socket.destroyed) {
          try {
            client.socket.write(encodeWsFrame(Buffer.from('hb'), { opcode: 0x9 }));
          } catch {}
        }
      }
    }, 30000);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  #attachServerClient(socket, head, headerSelfId) {
    if (headerSelfId) {
      this.selfId = String(headerSelfId);
    }
    let rxBuffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    let fragmentedChunks = null;
    let fragmentedOpcode = null;

    const client = {
      socket,
      closed: false,
      sendText: text => {
        if (client.closed || socket.destroyed) throw new Error('OneBot 客户端连接已断开');
        socket.write(encodeWsFrame(text, { opcode: 0x1 }));
      },
      close: (code = 1000, reason = '') => {
        if (client.closed) return;
        client.closed = true;
        if (!socket.destroyed) {
          const reasonBuf = Buffer.from(reason, 'utf8');
          const closePayload = Buffer.allocUnsafe(2 + reasonBuf.length);
          closePayload.writeUInt16BE(code, 0);
          reasonBuf.copy(closePayload, 2);
          try {
            socket.end(encodeWsFrame(closePayload, { opcode: 0x8 }));
          } catch {
            socket.destroy();
          }
        }
      },
    };

    this.serverClients.add(client);
    this.activeServerClient = client;
    const addr = this.httpServer?.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : this.config.listenPort;
    this.#setStatus(
      'connected',
      `反向 WS 已连接 (:${actualPort}${this.config.listenPath})${this.selfId ? ` · QQ ${this.selfId}` : ''}`,
    );

    const cleanup = () => {
      client.closed = true;
      this.serverClients.delete(client);
      if (this.activeServerClient === client) {
        const remaining = [...this.serverClients].filter(c => !c.closed && !c.socket.destroyed);
        this.activeServerClient = remaining.length ? remaining[remaining.length - 1] : null;
      }
      if (!this.activeServerClient && this.started && this.config.enabled) {
        this.#rejectAllPending(new Error('OneBot 客户端已断开'));
        const curAddr = this.httpServer?.address();
        const curPort = curAddr && typeof curAddr === 'object' ? curAddr.port : this.config.listenPort;
        this.#setStatus('listening', `反向 WS 监听中 ws://${this.config.listenHost}:${curPort}${this.config.listenPath}`);
      }
    };

    const processBuffer = () => {
      if (rxBuffer.length > MAX_FRAME_BYTES) {
        client.close(1009, 'Message too big');
        socket.destroy();
        return;
      }
      let decoded;
      try {
        decoded = decodeWsFrames(rxBuffer);
      } catch {
        client.close(1009, 'Invalid frame');
        socket.destroy();
        return;
      }
      rxBuffer = decoded.rest;

      for (const frame of decoded.frames) {
        if (frame.opcode === 0x8) {
          if (!client.closed) {
            client.closed = true;
            try {
              const codePayload = frame.payload.length >= 2 ? frame.payload.subarray(0, 2) : Buffer.alloc(0);
              socket.end(encodeWsFrame(codePayload, { opcode: 0x8 }));
            } catch {
              socket.destroy();
            }
          }
          return;
        }
        if (frame.opcode === 0x9) {
          if (!client.closed && !socket.destroyed) {
            socket.write(encodeWsFrame(frame.payload, { opcode: 0xA }));
          }
          continue;
        }
        if (frame.opcode === 0xA) {
          continue;
        }
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          if (frame.fin) {
            if (fragmentedChunks !== null) {
              client.close(1002, 'Unexpected non-continuation frame');
              return;
            }
            if (frame.opcode === 0x1) {
              this.#handleIncomingPayload(frame.payload.toString('utf8'));
            }
          } else {
            fragmentedOpcode = frame.opcode;
            fragmentedChunks = [frame.payload];
          }
        } else if (frame.opcode === 0x0) {
          if (fragmentedChunks === null) {
            client.close(1002, 'Unexpected continuation frame');
            return;
          }
          fragmentedChunks.push(frame.payload);
          const totalLen = fragmentedChunks.reduce((acc, buf) => acc + buf.length, 0);
          if (totalLen > MAX_FRAME_BYTES) {
            client.close(1009, 'Fragmented message too big');
            return;
          }
          if (frame.fin) {
            const joined = Buffer.concat(fragmentedChunks);
            const finalOpcode = fragmentedOpcode;
            fragmentedChunks = null;
            fragmentedOpcode = null;
            if (finalOpcode === 0x1) {
              this.#handleIncomingPayload(joined.toString('utf8'));
            }
          }
        }
      }
    };

    socket.on('data', chunk => {
      rxBuffer = rxBuffer.length ? Buffer.concat([rxBuffer, chunk]) : Buffer.from(chunk);
      processBuffer();
    });
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    if (rxBuffer.length > 0) {
      processBuffer();
    }
  }

  #handleIncomingPayload(rawText) {
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    if (payload.self_id != null && !this.selfId) {
      this.selfId = String(payload.self_id);
    }

    if (payload.echo && this.pendingEchoes.has(String(payload.echo))) {
      const echoKey = String(payload.echo);
      const pending = this.pendingEchoes.get(echoKey);
      this.pendingEchoes.delete(echoKey);
      clearTimeout(pending.timer);
      const failed = payload.status === 'failed'
        || (typeof payload.retcode === 'number' && payload.retcode !== 0 && payload.status !== 'async');
      if (failed) {
        pending.reject(new Error(`OneBot API 错误 (${payload.retcode ?? 'unknown'}): ${payload.wording || payload.msg || payload.status || 'failed'}`));
      } else {
        pending.resolve(payload.data ?? payload);
      }
      return;
    }

    if (payload.post_type === 'meta_event') {
      if (payload.self_id != null) {
        this.selfId = String(payload.self_id);
      }
      return;
    }

    if (payload.post_type !== 'message') return;

    const extracted = extractOneBotText(payload, this.selfId);
    if (!extracted) return;
    if (extracted.selfId && extracted.userId === extracted.selfId) return;

    const isCommandPrefix = /^(\/|@(?:claude|codex|antigravity|agy|dsh)\b)/i.test(extracted.text);
    if (extracted.isGroup && this.config.groupRequireMention !== false) {
      if (!extracted.mentioned && !isCommandPrefix) return;
    }
    if (!extracted.text) return;

    const replyTarget = extracted.isGroup
      ? { type: 'group', id: extracted.groupId }
      : { type: 'private', id: extracted.userId };

    let progressSentAt = 0;
    const msg = {
      channel: 'qq',
      chatKey: extracted.chatKey,
      messageType: extracted.messageType,
      senderId: extracted.userId,
      senderName: extracted.senderName,
      groupId: extracted.groupId || undefined,
      mentioned: extracted.mentioned,
      text: extracted.text,
      raw: payload,
      reply: text => this.sendMessage(replyTarget, text),
      onProgress: progress => {
        const now = Date.now();
        if (progressSentAt && now - progressSentAt < 20000) return;
        const text = typeof progress === 'string' ? progress : String(progress?.text || '').trim();
        if (!text) return;
        progressSentAt = now;
        this.sendMessage(replyTarget, text).catch(() => {});
      },
    };

    this.emit('message', msg);
    if (this.onMessage) {
      Promise.resolve(this.onMessage(msg)).catch(err => {
        if (this.listenerCount('error') > 0) this.emit('error', err);
      });
    }
  }

  #sendRaw(jsonString) {
    if (this.config.mode === 'server') {
      const client = this.activeServerClient;
      if (!client || client.closed || client.socket.destroyed) {
        throw new Error('QQ OneBot 反向 WS 尚未有客户端接入');
      }
      client.sendText(jsonString);
      return;
    }
    const openState = this.WebSocketImpl?.OPEN ?? 1;
    if (!this.ws || this.ws.readyState !== openState) {
      throw new Error('QQ OneBot WebSocket 未连接');
    }
    this.ws.send(jsonString);
  }

  sendAction(action, params = {}) {
    if (!this.isConnected()) {
      return Promise.reject(new Error('QQ OneBot WebSocket 未连接'));
    }
    const echo = `pet-qq-${++this.echoSeq}-${crypto.randomUUID().slice(0, 8)}`;
    const body = JSON.stringify({ action, params, echo });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingEchoes.has(echo)) {
          this.pendingEchoes.delete(echo);
          reject(new Error(`OneBot 请求超时: ${action}`));
        }
      }, this.config.actionTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pendingEchoes.set(echo, { resolve, reject, timer });
      try {
        this.#sendRaw(body);
      } catch (err) {
        clearTimeout(timer);
        this.pendingEchoes.delete(echo);
        reject(err);
      }
    });
  }

  async sendMessage(target, text) {
    const parsed = parseOneBotTarget(target);
    const chunks = chunkText(text, MAX_CHUNK_LEN);
    if (chunks.length === 0) return [];
    const results = [];
    for (const chunk of chunks) {
      if (parsed.type === 'group') {
        results.push(await this.sendAction('send_group_msg', { group_id: toOneBotId(parsed.id), message: chunk }));
      } else {
        results.push(await this.sendAction('send_private_msg', { user_id: toOneBotId(parsed.id), message: chunk }));
      }
    }
    return results;
  }

  async push(text) {
    const targets = this.config.pushTargets;
    if (!targets.length) {
      return { ok: false, sent: 0, detail: '未配置 QQ 推送目标 (pushTargets)' };
    }
    if (!this.isConnected()) {
      return { ok: false, sent: 0, detail: this.detail || 'QQ OneBot WebSocket 未连接' };
    }
    let sent = 0;
    const errors = [];
    for (const target of targets) {
      try {
        await this.sendMessage(target, text);
        sent++;
      } catch (err) {
        errors.push(`${target}: ${err.message}`);
      }
    }
    return {
      ok: sent > 0 && errors.length === 0,
      sent,
      total: targets.length,
      detail: errors.length ? errors.join('; ') : `已推送至 ${sent} 个 QQ 目标`,
    };
  }
}

module.exports = {
  QQOneBotAdapter,
  WS_GUID,
  computeWebSocketAccept,
  encodeWsFrame,
  decodeWsFrames,
  extractOneBotText,
  chunkText,
  parseOneBotTarget,
};
