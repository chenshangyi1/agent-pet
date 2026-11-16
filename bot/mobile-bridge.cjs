'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MOBILE_PORT = 18472;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const WS_BROADCAST_DEBOUNCE_MS = 60;

function computeWebSocketAccept(secWebSocketKey) {
  return crypto
    .createHash('sha1')
    .update(String(secWebSocketKey || '') + WS_GUID, 'utf8')
    .digest('base64');
}

function safeCompareToken(supplied, expected) {
  const a = String(supplied || '').trim().toUpperCase();
  const b = String(expected || '').trim().toUpperCase();
  if (a.length < 4 || b.length < 4 || a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function encodeWsFrame(payload, options = {}) {
  const { opcode = 0x1, fin = true } = options;
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(String(payload ?? ''), 'utf8');
  const len = body.length;
  const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0f);

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = firstByte;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, body]);
}

function decodeWsFrames(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const fin = (b0 & 0x80) !== 0;
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
        throw new Error('WebSocket frame too large');
      }
      payloadLen = Number(bigLen);
      cursor += 8;
    }

    if (payloadLen > MAX_FRAME_BYTES) {
      throw new Error('WebSocket frame too large');
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

    frames.push({
      fin,
      opcode,
      payload,
      text: opcode === 0x1 && fin ? payload.toString('utf8') : undefined,
    });
    offset = cursor + payloadLen;
  }

  return {
    frames,
    rest: offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0),
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw Object.assign(new Error('无效的 JSON 请求体'), { statusCode: 400 });
  }
}

function sendJson(res, statusCode, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

class MobileBridgeServer {
  constructor({ botService, providers, host, port } = {}) {
    this.botService = botService || null;
    this.providers = providers || botService?.providers || null;
    this.host = host || '0.0.0.0';
    this.configuredPort = port;
    this.server = null;
    this.actualPort = null;
    this.started = false;
    this.wsClients = new Set();
    this._broadcastTimer = null;
  }

  _targetPort() {
    if (this.configuredPort !== undefined && this.configuredPort !== null) {
      return Number(this.configuredPort);
    }
    const cfgPort = this.botService?.config?.mobilePort;
    if (Number.isInteger(cfgPort) && cfgPort >= 0 && cfgPort <= 65535) {
      return cfgPort;
    }
    return DEFAULT_MOBILE_PORT;
  }

  _extractToken(req, urlObj) {
    const authHeader = String(req.headers?.authorization || '');
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch && bearerMatch[1]) {
      return bearerMatch[1].trim();
    }
    const queryToken = urlObj?.searchParams?.get('token');
    return queryToken ? queryToken.trim() : '';
  }

  _isAuthorized(req, urlObj) {
    const expected = this.botService?.config?.pairingCode;
    const supplied = this._extractToken(req, urlObj);
    return safeCompareToken(supplied, expected);
  }

  buildStatePayload({ targetAgent, cwd, includeExtra = false, forceScan = false } = {}) {
    const localChat = this.botService?.localChat;
    const snapshot = this.providers?.snapshot || { items: [], sources: [] };
    const effectiveEngine = targetAgent || localChat?.selectedEngine || this.botService?.config?.defaultEngine;
    const workspaces = localChat
      ? localChat.discoverWorkspaces({ engine: effectiveEngine, providers: this.providers })
      : [];
    const payload = {
      ok: true,
      currentCwd: localChat ? localChat.currentCwd() : (this.botService?.config?.defaultCwd || ''),
      currentSessionId: localChat?.selectedSessionId || null,
      defaultEngine: this.botService?.config?.defaultEngine || 'claude',
      engines: this.botService?.probeEngines ? this.botService.probeEngines() : {},
      workspaces,
      sessions: localChat ? localChat.discoverSessions({ engine: effectiveEngine, cwd }) : [],
      activities: Array.isArray(snapshot.items) ? snapshot.items : [],
      sources: Array.isArray(snapshot.sources) ? snapshot.sources : [],
      jobs: this.botService?.listJobs ? this.botService.listJobs() : [],
    };
    if (includeExtra && localChat && typeof localChat.discoverExtraWorkspaces === 'function') {
      payload.extraWorkspaces = localChat.discoverExtraWorkspaces({
        excludePaths: workspaces.map(w => w.path),
        forceScan: Boolean(forceScan),
      });
    }
    return payload;
  }

  _syncMobileRouterCwd(cwd) {
    const router = this.botService?.router;
    if (!router || typeof router._getContext !== 'function' || !cwd) return;
    const ctx = router._getContext('mobile:default');
    ctx.cwd = cwd;
  }

  async _handleHttpRequest(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    let urlObj;
    try {
      urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { ok: false, error: '无效的请求路径' });
      return;
    }

    const pathname = urlObj.pathname;

    if (req.method === 'GET' && pathname === '/api/mobile/ping') {
      sendJson(res, 200, {
        ok: true,
        name: '小鑫 · Agent Pet',
        version: '0.3.0',
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/mobile/pair') {
      const body = await readJsonBody(req);
      const expected = this.botService?.config?.pairingCode || '';
      if (!safeCompareToken(body.code, expected)) {
        sendJson(res, 401, { ok: false, error: '配对码无效' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        token: expected,
        defaultEngine: this.botService?.config?.defaultEngine || 'claude',
        currentCwd: this.botService?.localChat?.currentCwd() || this.botService?.config?.defaultCwd || '',
      });
      return;
    }

    if (!pathname.startsWith('/api/mobile/')) {
      sendJson(res, 404, { ok: false, error: 'Not Found' });
      return;
    }

    if (!this._isAuthorized(req, urlObj)) {
      sendJson(res, 401, { ok: false, error: '未授权，请先使用配对码连接' });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/mobile/state') {
      const targetAgent = urlObj.searchParams.get('targetAgent') || undefined;
      const cwd = urlObj.searchParams.get('cwd') || undefined;
      const extraParam = urlObj.searchParams.get('extra');
      const includeExtra = extraParam === '1' || extraParam === 'true';
      const forceScanParam = urlObj.searchParams.get('forceScan');
      const forceScan = forceScanParam === '1' || forceScanParam === 'true';
      sendJson(res, 200, this.buildStatePayload({ targetAgent, cwd, includeExtra, forceScan }));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/mobile/workspace') {
      const body = await readJsonBody(req);
      if (!this.botService?.localChat) {
        sendJson(res, 503, { ok: false, error: '本地对话服务未就绪' });
        return;
      }
      const result = await this.botService.localChat.handleAction({
        action: 'selectWorkspace',
        cwd: body.cwd,
        targetAgent: body.targetAgent,
      });
      this._syncMobileRouterCwd(result.currentCwd);
      this.scheduleBroadcast();
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/mobile/session') {
      const body = await readJsonBody(req);
      if (!this.botService?.localChat) {
        sendJson(res, 503, { ok: false, error: '本地对话服务未就绪' });
        return;
      }
      const result = await this.botService.localChat.handleAction({
        action: 'selectSession',
        sessionId: body.sessionId,
        cliSessionId: body.cliSessionId,
        cwd: body.cwd,
        title: body.title,
        targetAgent: body.targetAgent,
        provider: body.provider,
      });
      if (result.cwd) {
        this._syncMobileRouterCwd(result.cwd);
      }
      this.scheduleBroadcast();
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/mobile/conversation') {
      const sessionId = (urlObj.searchParams.get('sessionId') || '').trim();
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: '缺少 sessionId 参数' });
        return;
      }
      const localChat = this.botService?.localChat;
      if (localChat && localChat._resolveSession(sessionId)) {
        const conv = await localChat.handleAction({ action: 'conversation', sessionId });
        sendJson(res, 200, { ok: true, ...conv });
        return;
      }
      const items = Array.isArray(this.providers?.snapshot?.items) ? this.providers.snapshot.items : [];
      const activity = items.find(item => item?.sessionId === sessionId);
      sendJson(res, 200, {
        ok: true,
        sessionId,
        title: activity?.title || sessionId,
        status: activity?.status || 'idle',
        detail: activity?.detail || '',
        lastSeq: activity?.lastSeq || 0,
        messages: [],
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/mobile/chat') {
      const body = await readJsonBody(req);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const images = Array.isArray(body.images) ? body.images : [];
      if (!text && images.length === 0) {
        sendJson(res, 400, { ok: false, error: '消息内容不能为空' });
        return;
      }

      if (text.startsWith('/')) {
        if (!this.botService?.router) {
          sendJson(res, 503, { ok: false, error: '指令路由未就绪' });
          return;
        }
        const effectiveCwd = body.cwd || this.botService?.localChat?.currentCwd();
        if (effectiveCwd) this._syncMobileRouterCwd(effectiveCwd);
        const result = await this.botService.router.handleMessage({
          channel: 'mobile',
          chatKey: 'mobile:default',
          senderId: 'mobile',
          senderName: 'iPhone',
          text,
          images,
          isAuthorized: true,
          pairingCode: this.botService.config.pairingCode,
        });
        this.scheduleBroadcast();
        sendJson(res, 200, {
          ok: true,
          sessionId: body.sessionId || this.botService?.localChat?.selectedSessionId || null,
          reply: result?.text || '',
        });
        return;
      }

      if (!this.botService?.localChat) {
        sendJson(res, 503, { ok: false, error: '本地对话服务未就绪' });
        return;
      }

      const result = await this.botService.localChat.handleAction({
        action: 'prompt',
        targetAgent: body.targetAgent,
        text,
        cwd: body.cwd,
        sessionId: body.sessionId,
        images,
      });
      this.scheduleBroadcast();
      sendJson(res, 200, {
        ok: true,
        sessionId: result.sessionId,
        status: result.status || 'running',
        cwd: result.cwd || body.cwd || this.botService.localChat.currentCwd(),
        reply: '',
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/mobile/command') {
      const body = await readJsonBody(req);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) {
        sendJson(res, 400, { ok: false, error: '指令内容不能为空' });
        return;
      }
      if (!this.botService?.router) {
        sendJson(res, 503, { ok: false, error: '指令路由未就绪' });
        return;
      }
      const isCdCmd = /^\/cd(?:\s|$)/i.test(text);
      if (!isCdCmd) {
        const currentCwd = body.cwd || this.botService?.localChat?.currentCwd();
        if (currentCwd) this._syncMobileRouterCwd(currentCwd);
      }
      const result = await this.botService.router.handleMessage({
        channel: 'mobile',
        chatKey: 'mobile:default',
        senderId: 'mobile',
        senderName: 'iPhone',
        text,
        isAuthorized: true,
        pairingCode: this.botService.config.pairingCode,
      });
      if (isCdCmd && this.botService?.localChat) {
        const ctx = this.botService.router._getContext('mobile:default');
        if (ctx?.cwd) {
          this.botService.localChat.selectedCwd = ctx.cwd;
        }
      }
      this.scheduleBroadcast();
      sendJson(res, 200, {
        ok: true,
        text: result?.text || '',
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not Found' });
  }

  _handleUpgrade(req, socket, head) {
    let urlObj;
    try {
      urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }

    if (urlObj.pathname !== '/api/mobile/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!this._isAuthorized(req, urlObj)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const upgrade = String(req.headers?.upgrade || '').toLowerCase();
    const wsKey = req.headers?.['sec-websocket-key'];
    if (upgrade !== 'websocket' || !wsKey) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = computeWebSocketAccept(wsKey);
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n');

    socket.write(headers);
    socket.setNoDelay(true);

    const client = { socket, buffer: head && head.length ? Buffer.from(head) : Buffer.alloc(0) };
    this.wsClients.add(client);

    const cleanup = () => {
      this.wsClients.delete(client);
      if (!socket.destroyed) socket.destroy();
    };

    const processBuffer = () => {
      if (client.buffer.length === 0) return;
      let parsed;
      try {
        parsed = decodeWsFrames(client.buffer);
      } catch {
        cleanup();
        return;
      }
      client.buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          try {
            socket.write(encodeWsFrame(Buffer.alloc(0), { opcode: 0x8 }));
          } catch {}
          cleanup();
          return;
        }
        if (frame.opcode === 0x9) {
          try {
            socket.write(encodeWsFrame(frame.payload, { opcode: 0xA }));
          } catch {}
        } else if (frame.opcode === 0x1 && frame.text) {
          try {
            const msg = JSON.parse(frame.text);
            if (msg?.type === 'ping') {
              socket.write(encodeWsFrame(JSON.stringify({ type: 'pong', ts: Date.now() }), { opcode: 0x1 }));
            } else if (msg?.type === 'refresh') {
              socket.write(encodeWsFrame(JSON.stringify({ type: 'state', ...this.buildStatePayload() }), { opcode: 0x1 }));
            }
          } catch {}
        }
      }
    };

    socket.on('data', chunk => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      processBuffer();
    });
    socket.on('error', cleanup);
    socket.on('close', cleanup);

    processBuffer();

    try {
      const initial = JSON.stringify({ type: 'state', ...this.buildStatePayload() });
      socket.write(encodeWsFrame(initial, { opcode: 0x1 }));
    } catch {
      cleanup();
    }
  }

  scheduleBroadcast() {
    if (!this.started || this.wsClients.size === 0) return;
    if (this._broadcastTimer) return;
    this._broadcastTimer = setTimeout(() => {
      this._broadcastTimer = null;
      this.broadcastState();
    }, WS_BROADCAST_DEBOUNCE_MS);
    if (typeof this._broadcastTimer.unref === 'function') {
      this._broadcastTimer.unref();
    }
  }

  broadcastState() {
    if (!this.started || this.wsClients.size === 0) return;
    const frame = encodeWsFrame(
      JSON.stringify({ type: 'state', ...this.buildStatePayload() }),
      { opcode: 0x1 }
    );
    for (const client of this.wsClients) {
      if (client.socket.destroyed || !client.socket.writable) {
        this.wsClients.delete(client);
        continue;
      }
      try {
        client.socket.write(frame);
      } catch {
        this.wsClients.delete(client);
        client.socket.destroy();
      }
    }
  }

  async _listenOnPort(port) {
    return new Promise((resolve, reject) => {
      const onError = err => {
        this.server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off('error', onError);
        const addr = this.server.address();
        resolve(addr && typeof addr === 'object' ? addr.port : port);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(port, this.host);
    });
  }

  async start() {
    if (this.started) return this.getStatus();

    this.server = http.createServer((req, res) => {
      Promise.resolve(this._handleHttpRequest(req, res)).catch(err => {
        const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 400;
        sendJson(res, statusCode, { ok: false, error: err?.message || '请求处理失败' });
      });
    });
    this.server.requestTimeout = 30_000;
    this.server.on('upgrade', (req, socket, head) => {
      this._handleUpgrade(req, socket, head);
    });

    const desiredPort = this._targetPort();
    try {
      this.actualPort = await this._listenOnPort(desiredPort);
    } catch (err) {
      if (err?.code === 'EADDRINUSE' && desiredPort !== 0) {
        this.actualPort = await this._listenOnPort(0);
      } else {
        this.server.close();
        this.server = null;
        throw err;
      }
    }

    this.started = true;
    return this.getStatus();
  }

  async stop() {
    this.started = false;
    if (this._broadcastTimer) {
      clearTimeout(this._broadcastTimer);
      this._broadcastTimer = null;
    }
    for (const client of this.wsClients) {
      try {
        if (!client.socket.destroyed) {
          client.socket.write(encodeWsFrame(Buffer.alloc(0), { opcode: 0x8 }));
          client.socket.destroy();
        }
      } catch {}
    }
    this.wsClients.clear();

    const srv = this.server;
    this.server = null;
    this.actualPort = null;
    if (!srv) return;

    await new Promise(resolve => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      srv.close(done);
      if (typeof srv.closeAllConnections === 'function') {
        srv.closeAllConnections();
      }
    });
  }

  getStatus() {
    return {
      started: this.started,
      host: this.host,
      port: this.actualPort,
      clients: this.wsClients.size,
    };
  }
}

module.exports = {
  MobileBridgeServer,
  DEFAULT_MOBILE_PORT,
};
