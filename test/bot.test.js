import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import os, { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const {
  TaskDispatcher,
  parseClaudeStreamLine,
  parseCodexJsonLine,
  sanitizeWorkspace,
  mirrorInboxEvent,
} = require('../bot/dispatcher.cjs');
const { CommandRouter } = require('../bot/commands.cjs');
const {
  QQOneBotAdapter,
  WS_GUID,
  computeWebSocketAccept,
  encodeWsFrame,
  decodeWsFrames,
  extractOneBotText,
  chunkText,
  parseOneBotTarget,
  downloadTempImage,
} = require('../bot/channels/qq-onebot.cjs');
const {
  WeComAdapter,
  DEFAULT_WECOM_WS_URL,
  buildSubscribeFrame,
  buildPingFrame,
  buildRespondStreamFrame,
  buildSendMsgFrame,
  parseCallbackFrame,
  chunkMarkdown,
  downloadTempImage: downloadWeComTempImage,
} = require('../bot/channels/wecom.cjs');
const { LocalChatBridge } = require('../bot/local-chat.cjs');
const { MobileBridgeServer } = require('../bot/mobile-bridge.cjs');
const {
  BotService,
  DEFAULT_BOT_CONFIG,
  generatePairingCode,
  formatStatusAlert,
  normalizeBotConfig,
} = require('../bot/service.cjs');
const { startBotServer } = require('../bot/server.cjs');
const { Providers } = require('../runtime/providers.cjs');
const { AutoStartManager, LAUNCH_AGENT_LABEL } = require('../runtime/autostart.cjs');

async function makeMockExecutable(filePath, jsSource) {
  await mkdir(dirname(filePath), { recursive: true });
  const script = `#!/usr/bin/env node\n${jsSource}\n`;
  await writeFile(filePath, script, 'utf8');
  await chmod(filePath, 0o755);
  return filePath;
}

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 20, message = 'condition timed out' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await predicate();
    if (res) return res;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}

async function createLoopbackWsServer({ onConnection, onUpgradeCheck } = {}) {
  const sockets = new Set();
  const server = createServer((_req, res) => {
    res.writeHead(426);
    res.end('Upgrade Required');
  });

  server.on('upgrade', (req, socket, head) => {
    if (onUpgradeCheck) {
      const check = onUpgradeCheck(req);
      if (check && check.rejectStatus) {
        socket.write(`HTTP/1.1 ${check.rejectStatus} Rejected\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
    }
    const key = String(req.headers['sec-websocket-key'] || '');
    const accept = computeWebSocketAccept(key);
    socket.setNoDelay(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);

    let rxBuffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    const conn = {
      req,
      socket,
      messages: [],
      sendJson(obj) {
        if (!socket.destroyed) socket.write(encodeWsFrame(JSON.stringify(obj), { opcode: 0x1 }));
      },
      sendText(text) {
        if (!socket.destroyed) socket.write(encodeWsFrame(String(text), { opcode: 0x1 }));
      },
      close() {
        try { socket.end(encodeWsFrame(Buffer.alloc(0), { opcode: 0x8 })); } catch {}
        try { socket.destroy(); } catch {}
      },
    };

    const flush = () => {
      const decoded = decodeWsFrames(rxBuffer);
      rxBuffer = decoded.rest;
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x8) {
          conn.close();
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeWsFrame(frame.payload, { opcode: 0xA }));
          continue;
        }
        if (frame.opcode === 0x1) {
          const text = frame.payload.toString('utf8');
          conn.messages.push(text);
          conn.onText?.(text);
        }
      }
    };

    socket.on('data', chunk => {
      rxBuffer = rxBuffer.length ? Buffer.concat([rxBuffer, chunk]) : Buffer.from(chunk);
      flush();
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    onConnection?.(conn);
    if (rxBuffer.length > 0) flush();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    async close() {
      for (const s of sockets) {
        try { s.destroy(); } catch {}
      }
      sockets.clear();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('TaskDispatcher 引擎探测与 sanitizeWorkspace 工作区白名单及软链逃逸拦截', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-bot-ws-'));
  const dir = await realpath(rawDir);
  const allowedRoot = join(dir, 'allowed');
  const subDir = join(allowedRoot, 'repo');
  const outsideDir = join(dir, 'outside');
  const escapedLink = join(allowedRoot, 'escape-link');
  const fileTarget = join(allowedRoot, 'plain.txt');
  const binDir = join(dir, 'bin');
  const dataDir = join(dir, 'data');

  await mkdir(subDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(fileTarget, 'not a directory', 'utf8');
  await symlink(outsideDir, escapedLink, 'dir');

  const mockClaude = await makeMockExecutable(join(binDir, 'claude'), 'process.exit(0);');
  const mockCodex = await makeMockExecutable(join(binDir, 'codex'), 'process.exit(0);');
  const mockAgy = await makeMockExecutable(join(binDir, 'agy'), 'process.exit(0);');

  const prevEnv = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    CODEX_BIN: process.env.CODEX_BIN,
    AGY_BIN: process.env.AGY_BIN,
  };
  t.after(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(rawDir, { recursive: true, force: true });
  });

  assert.equal(sanitizeWorkspace(allowedRoot, [allowedRoot]), allowedRoot);
  assert.equal(sanitizeWorkspace(subDir, [allowedRoot]), subDir);
  assert.equal(sanitizeWorkspace('~', [os.homedir()]), await realpath(os.homedir()));
  assert.throws(() => sanitizeWorkspace('', [allowedRoot]), /不能为空/);
  assert.throws(() => sanitizeWorkspace(join(allowedRoot, 'does-not-exist'), [allowedRoot]), /不存在/);
  assert.throws(() => sanitizeWorkspace(fileTarget, [allowedRoot]), /不是目录/);
  assert.throws(() => sanitizeWorkspace(outsideDir, [allowedRoot]), /白名单/);
  assert.throws(() => sanitizeWorkspace(escapedLink, [allowedRoot]), /白名单/);

  process.env.CLAUDE_BIN = mockClaude;
  process.env.CODEX_BIN = mockCodex;
  process.env.AGY_BIN = mockAgy;
  await writeFile(join(dataDir, 'dsh-bridge.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:1/action', token: 'tok' }));

  const dispatcher = new TaskDispatcher({
    dataDir,
    providers: { snapshot: { sources: [{ id: 'dsh', connected: true }] }, dsh: async () => ({}) },
    allowedWorkspaces: [allowedRoot],
    defaultCwd: allowedRoot,
  });
  const probes = dispatcher.probeEngines();
  assert.equal(probes.claude.available, true);
  assert.equal(probes.claude.path, mockClaude);
  assert.equal(probes.codex.available, true);
  assert.equal(probes.codex.path, mockCodex);
  assert.equal(probes.antigravity.available, true);
  assert.equal(probes.antigravity.mode, 'cli');
  assert.equal(probes.antigravity.path, mockAgy);
  assert.equal(probes.dsh.available, true);
});

test('parseClaudeStreamLine / parseCodexJsonLine 与 Claude mock 子进程流式派活、inbox 镜像、--resume 及 /stop', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-bot-claude-'));
  const dir = await realpath(rawDir);
  const workDir = join(dir, 'work');
  const dataDir = join(dir, 'data');
  const argsLog = join(dir, 'claude-args.jsonl');
  await mkdir(workDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const mockClaude = await makeMockExecutable(
    join(dir, 'mock-claude'),
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 ? args[pIdx + 1] : '';
const rIdx = args.indexOf('--resume');
const resumed = rIdx >= 0 ? args[rIdx + 1] : null;
const sid = resumed || 'ses-claude-mock-1';

if (prompt.includes('SLOW_CANCEL')) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ses-claude-slow' }));
  process.on('SIGTERM', () => process.exit(0));
  setTimeout(() => process.exit(0), 10000);
} else {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }));
  console.log(JSON.stringify({
    type: 'assistant',
    session_id: sid,
    message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash' }, { type: 'text', text: '正在检查项目' }] }
  }));
  console.log(JSON.stringify({
    type: 'user',
    session_id: sid,
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: false }] }
  }));
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: sid,
    result: resumed ? '已续接会话: ' + prompt : '首次完成: ' + prompt
  }));
}
`,
  );

  const prevClaude = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mockClaude;
  t.after(async () => {
    if (prevClaude === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prevClaude;
    await rm(rawDir, { recursive: true, force: true });
  });

  // Unit assertions on line parsers
  assert.equal(parseClaudeStreamLine(''), null);
  assert.equal(parseClaudeStreamLine('not-json'), null);
  const parsedTool = parseClaudeStreamLine(JSON.stringify({
    type: 'assistant',
    session_id: 's-1',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }, { type: 'text', text: 'hello' }] },
  }));
  assert.equal(parsedTool.sessionId, 's-1');
  assert.deepEqual(parsedTool.tools, [{ name: 'Read', id: 't1' }]);
  assert.equal(parsedTool.text, 'hello');

  const parsedErr = parseClaudeStreamLine(JSON.stringify({
    type: 'result',
    subtype: 'error_max_turns',
    session_id: 's-1',
    errors: ['max turns reached'],
  }));
  assert.equal(parsedErr.isResult, true);
  assert.equal(parsedErr.isError, true);
  assert.equal(parsedErr.text, 'max turns reached');

  assert.equal(parseCodexJsonLine('plain text'), null);
  const codexCmd = parseCodexJsonLine(JSON.stringify({
    type: 'item.started',
    item: { id: 'cmd-1', type: 'command_execution', command: 'npm test' },
  }));
  assert.equal(codexCmd.tool, 'command_execution');
  assert.match(codexCmd.toolSummary, /npm test/);

  const codexFail = parseCodexJsonLine(JSON.stringify({
    type: 'turn.failed',
    error: { message: 'boom' },
  }));
  assert.equal(codexFail.hasError, true);
  assert.equal(codexFail.errorMessage, 'boom');

  // Dispatch + inbox mirror + Providers.refresh + resume + stopJob
  const providers = new Providers(dataDir, {}, { enabledProviders: ['dsh', 'claude', 'codex'] });
  const dispatcher = new TaskDispatcher({
    dataDir,
    providers,
    allowedWorkspaces: [dir],
    defaultCwd: workDir,
    sandboxMode: 'auto',
  });

  const progressEvents = [];
  const res1 = await dispatcher.dispatch({
    engine: 'claude',
    prompt: 'SECRET_CLAUDE_PROMPT_NEVER_IN_INBOX',
    cwd: workDir,
    onProgress: ev => progressEvents.push(ev),
  });
  assert.equal(res1.status, 'completed');
  assert.equal(res1.sessionId, 'ses-claude-mock-1');
  assert.match(res1.text, /首次完成/);
  assert.deepEqual(res1.toolsUsed, ['Bash']);
  assert.ok(progressEvents.some(e => e.type === 'tool' && e.tool === 'Bash'));
  assert.ok(progressEvents.some(e => e.type === 'text' && e.text.includes('正在检查项目')));
  assert.equal(dispatcher.isDispatchedSession('claude:ses-claude-mock-1'), true);

  // Check inbox files before Providers consumes them: 32hex filenames, 0600 mode, zero secret prompt leaks
  const claudeInbox = join(dataDir, 'claude/inbox');
  const inboxFiles = await readdir(claudeInbox);
  assert.ok(inboxFiles.length >= 4);
  for (const fname of inboxFiles) {
    assert.match(fname, /^[a-f0-9]{32}\.json$/);
    const st = await stat(join(claudeInbox, fname));
    assert.equal(st.mode & 0o777, 0o600);
    const content = await readFile(join(claudeInbox, fname), 'utf8');
    assert.ok(!content.includes('SECRET_CLAUDE_PROMPT_NEVER_IN_INBOX'));
  }

  await providers.refresh();
  assert.equal((await readdir(claudeInbox)).length, 0);
  const claudeRow = providers.snapshot.items.find(r => r.sessionId === 'claude:ses-claude-mock-1');
  assert.ok(claudeRow);
  assert.equal(claudeRow.status, 'ready');

  // Follow-up resume
  const res2 = await dispatcher.dispatch({
    engine: 'claude',
    prompt: '继续验证',
    cwd: workDir,
    sessionId: res1.sessionId,
  });
  assert.equal(res2.status, 'completed');
  assert.equal(res2.sessionId, 'ses-claude-mock-1');
  assert.match(res2.text, /已续接会话: 继续验证/);

  const invocations = (await readFile(argsLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(invocations.length, 2);
  assert.ok(invocations[0].includes('--permission-mode'));
  assert.ok(invocations[0].includes('acceptEdits'));
  assert.ok(!invocations[0].includes('--resume'));
  assert.ok(invocations[1].includes('--resume'));
  assert.equal(invocations[1][invocations[1].indexOf('--resume') + 1], 'ses-claude-mock-1');

  // Cancel slow job
  const slowPromise = dispatcher.dispatch({ engine: 'claude', prompt: 'SLOW_CANCEL', cwd: workDir });
  const running = await waitFor(() => dispatcher.listJobs(5).find(j => j.status === 'running'));
  const stopRes = await dispatcher.stopJob(running.jobId);
  assert.equal(stopRes.stopped, true);
  assert.equal(stopRes.engine, 'claude');
  const cancelledRes = await slowPromise;
  assert.equal(cancelledRes.status, 'cancelled');
});

test('Codex mock 派活与 --resume 续接、Antigravity 缺省 CLI 提示及 DSH 桥接调度', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-bot-codex-dsh-'));
  const dir = await realpath(rawDir);
  const workDir = join(dir, 'work');
  const dataDir = join(dir, 'data');
  const codexArgsLog = join(dir, 'codex-args.jsonl');
  await mkdir(workDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const mockCodex = await makeMockExecutable(
    join(dir, 'mock-codex'),
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(codexArgsLog)}, JSON.stringify(args) + '\\n');
const isResume = args[0] === 'exec' && args[1] === 'resume';
const prompt = args[args.length - 1];
const tid = isResume ? args[args.length - 2] : 'thread-codex-99';

if (prompt.includes('SLOW_CODEX')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-slow' }));
  process.on('SIGTERM', () => process.exit(0));
  setTimeout(() => process.exit(0), 10000);
} else {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: tid }));
  console.log(JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls -la' } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', status: 'completed', exit_code: 0 } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'a.js' }] } }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: (isResume ? 'Codex 续接: ' : 'Codex 完成: ') + prompt } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
}
`,
  );

  const prevCodex = process.env.CODEX_BIN;
  const prevAgy = process.env.AGY_BIN;
  process.env.CODEX_BIN = mockCodex;
  delete process.env.AGY_BIN;
  t.after(async () => {
    if (prevCodex === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prevCodex;
    if (prevAgy === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prevAgy;
    await rm(rawDir, { recursive: true, force: true });
  });

  // Mock DSH RPC backend
  const dshCalls = [];
  const dshSessions = new Map();
  const providers = new Providers(dataDir, {}, { enabledProviders: ['dsh', 'codex'] });
  providers.dsh = async body => {
    dshCalls.push(body);
    if (body.action === 'create') {
      const sid = body.sessionId || 'dsh-s1';
      dshSessions.set(sid, { status: 'idle', lastSeq: 0, messages: [], pollCount: 0 });
      return { sessionId: sid };
    }
    if (body.action === 'prompt') {
      const s = dshSessions.get(body.sessionId) || { status: 'idle', lastSeq: 0, messages: [], pollCount: 0 };
      s.status = 'running';
      s.detail = 'DSH 正在思考';
      s.messages.push({ role: 'user', text: body.text });
      s.lastSeq++;
      s.pollCount = 0;
      dshSessions.set(body.sessionId, s);
      return { ok: true };
    }
    if (body.action === 'list') {
      return {
        items: [...dshSessions.entries()].map(([id, s]) => ({
          sessionId: id,
          status: s.status,
          detail: s.detail || '',
        })),
      };
    }
    if (body.action === 'conversation') {
      const s = dshSessions.get(body.sessionId);
      if (!s) return null;
      if (s.status === 'running') {
        s.pollCount++;
        if (s.pollCount >= 2 && !s.messages.some(m => m.text === 'SLOW_DSH')) {
          s.status = 'ready';
          s.detail = '完成';
          const lastUser = [...s.messages].reverse().find(m => m.role === 'user')?.text || '';
          s.messages.push({ role: 'assistant', text: `DSH 回复: ${lastUser}` });
          s.lastSeq++;
        }
      }
      return {
        status: s.status,
        detail: s.detail,
        lastSeq: s.lastSeq,
        messages: [...s.messages],
      };
    }
    if (body.action === 'cancel') {
      const s = dshSessions.get(body.sessionId);
      if (s) s.status = 'cancelled';
      return { ok: true };
    }
    return {};
  };

  const dispatcher = new TaskDispatcher({
    dataDir,
    providers,
    allowedWorkspaces: [dir],
    defaultCwd: workDir,
    dshPollIntervalMs: 15,
    dshTimeoutMs: 2000,
  });

  // 1. Codex initial + resume + inbox + stop
  const codexProgress = [];
  const cdx1 = await dispatcher.dispatch({
    engine: 'codex',
    prompt: 'SECRET_CODEX_PROMPT',
    cwd: workDir,
    onProgress: ev => codexProgress.push(ev),
  });
  assert.equal(cdx1.status, 'completed');
  assert.equal(cdx1.sessionId, 'thread-codex-99');
  assert.match(cdx1.text, /Codex 完成/);
  assert.ok(codexProgress.some(e => e.tool === 'command_execution'));
  assert.ok(dispatcher.isDispatchedSession('codex:thread-codex-99'));

  const codexInbox = join(dataDir, 'codex/inbox');
  const codexFiles = await readdir(codexInbox);
  assert.ok(codexFiles.length >= 3);
  for (const name of codexFiles) {
    assert.ok(!(await readFile(join(codexInbox, name), 'utf8')).includes('SECRET_CODEX_PROMPT'));
  }
  await providers.refresh();
  assert.equal(providers.snapshot.items.find(r => r.sessionId === 'codex:thread-codex-99')?.status, 'ready');

  const cdx2 = await dispatcher.dispatch({
    engine: 'codex',
    prompt: '再查一下',
    cwd: workDir,
    sessionId: cdx1.sessionId,
  });
  assert.equal(cdx2.status, 'completed');
  assert.match(cdx2.text, /Codex 续接: 再查一下/);

  const codexCalls = (await readFile(codexArgsLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(codexCalls[0][0], 'exec');
  assert.equal(codexCalls[0][1], '--json');
  assert.ok(codexCalls[0].includes('-C'));
  assert.equal(codexCalls[1][0], 'exec');
  assert.equal(codexCalls[1][1], 'resume');
  assert.ok(codexCalls[1].includes('thread-codex-99'));

  const slowCodex = dispatcher.dispatch({ engine: 'codex', prompt: 'SLOW_CODEX', cwd: workDir });
  const slowJob = await waitFor(() => dispatcher.listJobs(5).find(j => j.engine === 'codex' && j.status === 'running'));
  await dispatcher.stopJob(slowJob.jobId);
  assert.equal((await slowCodex).status, 'cancelled');

  // 2. Antigravity missing-CLI error message (verify real host probe when agy not installed, plus fallback probe override)
  const hostAgyProbe = dispatcher.probeEngines().antigravity;
  if (!hostAgyProbe.available) {
    assert.equal(hostAgyProbe.mode, 'gui-only');
    await assert.rejects(
      () => dispatcher.dispatch({ engine: 'antigravity', prompt: 'test', cwd: workDir }),
      /未检测到 Antigravity CLI.*\/open antigravity/,
    );
  } else {
    const origProbe = dispatcher.probeEngines.bind(dispatcher);
    dispatcher.probeEngines = () => ({
      ...origProbe(),
      antigravity: { available: false, mode: 'gui-only', path: null, label: 'Antigravity', note: 'gui-only' },
    });
    await assert.rejects(
      () => dispatcher.dispatch({ engine: 'antigravity', prompt: 'test', cwd: workDir }),
      /未检测到 Antigravity CLI.*\/open antigravity/,
    );
    dispatcher.probeEngines = origProbe;
  }

  // 3. DSH bridge dispatch + follow-up + cancel
  const dshProgress = [];
  const dsh1 = await dispatcher.dispatch({
    engine: 'dsh',
    prompt: '总结变更',
    cwd: workDir,
    onProgress: ev => dshProgress.push(ev),
  });
  assert.equal(dsh1.status, 'completed');
  assert.equal(dsh1.text, 'DSH 回复: 总结变更');
  assert.ok(dshProgress.some(e => e.text.includes('DSH 正在思考')));
  assert.ok(dispatcher.isDispatchedSession(`dsh:${dsh1.sessionId}`));

  const dsh2 = await dispatcher.dispatch({
    engine: 'dsh',
    prompt: '补充测试',
    cwd: workDir,
    sessionId: dsh1.sessionId,
  });
  assert.equal(dsh2.status, 'completed');
  assert.equal(dsh2.sessionId, dsh1.sessionId);
  assert.equal(dsh2.text, 'DSH 回复: 补充测试');

  // Cancel slow DSH job
  const slowDshPromise = dispatcher.dispatch({ engine: 'dsh', prompt: 'SLOW_DSH', cwd: workDir });
  const slowDshJob = await waitFor(() => dispatcher.listJobs(5).find(j => j.engine === 'dsh' && j.status === 'running'));
  const dshStop = await dispatcher.stopJob(slowDshJob.jobId);
  assert.equal(dshStop.stopped, true);
  assert.equal((await slowDshPromise).status, 'cancelled');
  assert.ok(dshCalls.some(c => c.action === 'cancel'));
});

test('CommandRouter 鉴权拦截、/pair 配对与全量指令交互及会话绑定', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-bot-cmd-'));
  const dir = await realpath(rawDir);
  const subDir = join(dir, 'project-a');
  const outsideDir = join(dirname(dir), 'outside-check-nonexist');
  await mkdir(subDir, { recursive: true });
  t.after(() => rm(rawDir, { recursive: true, force: true }));

  const authorizedCalls = [];
  const desktopCalls = [];
  const openedApps = [];
  const dispatchCalls = [];

  const mockDispatcher = {
    defaultCwd: dir,
    validateWorkspace(target) {
      return sanitizeWorkspace(target, [dir]);
    },
    probeEngines() {
      return {
        claude: { available: true, path: '/usr/local/bin/claude', label: 'Claude Code' },
        codex: { available: true, path: '/usr/local/bin/codex', label: 'Codex' },
        antigravity: {
          available: false,
          mode: 'gui-only',
          path: null,
          label: 'Antigravity',
          note: '仅桌面端状态监听（未安装 CLI）',
        },
        dsh: { available: true, path: null, label: 'DSH' },
      };
    },
    listJobs() {
      return [{
        jobId: 'job-123456',
        engine: 'claude',
        cwd: dir,
        promptPreview: '检查测试',
        status: 'running',
        startedAt: Date.now() - 5000,
        sessionId: 'ses-c1',
      }];
    },
    async stopJob(jobId) {
      return { stopped: true, jobId: jobId || 'job-123456', engine: 'claude' };
    },
    async dispatch({ engine, prompt, cwd, sessionId, onProgress }) {
      dispatchCalls.push({ engine, prompt, cwd, sessionId });
      if (engine === 'antigravity') {
        throw new Error('当前未检测到 Antigravity CLI (agy)');
      }
      onProgress?.({ type: 'tool', tool: 'Read', text: '🔧 正在使用 Read' });
      const nextSid = sessionId || `${engine}-sid-1`;
      return {
        jobId: `job-${engine}-1`,
        engine,
        status: 'completed',
        sessionId: nextSid,
        text: `[${engine}] ${prompt}`,
      };
    },
  };

  const mockProviders = {
    snapshot: { items: [], sources: [] },
    async refresh() {
      return {
        sources: [{ id: 'claude', connected: true }, { id: 'dsh', connected: false }],
        items: [{
          provider: 'claude',
          providerLabel: 'Claude Code',
          sessionId: 'claude:s1',
          title: 'pet · s1',
          status: 'waiting',
          detail: '等待确认 Bash',
          unread: true,
          updatedAt: Date.now(),
        }],
      };
    },
  };

  const router = new CommandRouter({
    dispatcher: mockDispatcher,
    providers: mockProviders,
    desktopCommand: cmd => desktopCalls.push(cmd),
    openApp: id => openedApps.push(id),
    getConfig: () => ({ defaultEngine: 'claude', defaultCwd: dir }),
    onAuthorizeUser: payload => authorizedCalls.push(payload),
  });

  // Unauthorized check + /pair
  const unauth = await router.handleMessage({
    channel: 'qq',
    chatKey: 'private:1001',
    senderId: '1001',
    text: '/status',
    isAuthorized: false,
    pairingCode: 'AB12CD',
  });
  assert.equal(unauth.handled, false);
  assert.equal(unauth.unauthorized, true);
  assert.match(unauth.text, /\/pair/);

  const badPair = await router.handleMessage({
    channel: 'qq',
    chatKey: 'private:1001',
    senderId: '1001',
    text: '/pair WRONG9',
    isAuthorized: false,
    pairingCode: 'AB12CD',
  });
  assert.equal(badPair.paired, false);

  const okPair = await router.handleMessage({
    channel: 'qq',
    chatKey: 'private:1001',
    senderId: '1001',
    senderName: 'Alice',
    text: '/pair ab12cd',
    isAuthorized: false,
    pairingCode: 'AB12CD',
  });
  assert.equal(okPair.paired, true);
  assert.equal(authorizedCalls.length, 1);
  assert.equal(authorizedCalls[0].senderId, '1001');

  const send = async text => router.handleMessage({
    channel: 'qq',
    chatKey: 'private:1001',
    senderId: '1001',
    text,
    isAuthorized: true,
    pairingCode: 'AB12CD',
  });

  assert.match((await send('/help')).text, /\/claude/);
  assert.match((await send('/status')).text, /等待确认 Bash/);
  assert.match((await send('/engines')).text, /Claude Code/);
  assert.match((await send('/engines')).text, /Antigravity/);

  assert.match((await send(`/cd ${subDir}`)).text, new RegExp(subDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match((await send('/cd')).text, new RegExp(subDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match((await send(`/cd ${outsideDir}`)).text, /切换失败/);

  assert.match((await send('/use')).text, /当前默认引擎/);
  assert.match((await send('/use invalid-eng')).text, /不支持的引擎/);
  assert.match((await send('/use agy')).text, /已切换为：antigravity[\s\S]*仅桌面端状态监听/);
  assert.match((await send('/use codex')).text, /已切换为：codex/);
  assert.match((await send('/jobs')).text, /job-123456/);
  assert.match((await send('/stop job-123456')).text, /已停止任务 job-123456/);

  assert.match((await send('/pet show')).text, /显示小鑫/);
  assert.match((await send('/pet hide')).text, /隐藏小鑫/);
  assert.match((await send('/pet reset')).text, /归位小鑫/);
  assert.match((await send('/pet bad')).text, /用法/);
  assert.deepEqual(desktopCalls, ['show', 'hide', 'reset']);

  assert.match((await send('/open agy')).text, /已打开 antigravity/);
  assert.deepEqual(openedApps, ['antigravity']);

  assert.match((await send('/unknowncmd')).text, /未知指令/);

  // Engine dispatch + per-engine session persistence + /new reset
  const rClaude = await send('@claude 写测试');
  assert.match(rClaude.text, /\[claude\] 写测试/);
  assert.match(rClaude.text, /claude-sid-1/);

  const rCodex = await send('@codex 跑检查');
  assert.match(rCodex.text, /\[codex\] 跑检查/);
  assert.equal(dispatchCalls[1].sessionId, null);

  const rDsh = await send('@dsh 总结状态');
  assert.match(rDsh.text, /\[dsh\] 总结状态/);

  const rAgy = await send('/agy 试试看');
  assert.match(rAgy.text, /派活失败 \(antigravity\)/);
  assert.equal(dispatchCalls[3].engine, 'antigravity');

  // Plain follow-up uses last bound engine (dsh) and its sessionId (failed /agy did not overwrite ctx.engine)
  const rFollow = await send('再详细说说');
  assert.match(rFollow.text, /\[dsh\] 再详细说说/);
  assert.equal(dispatchCalls[4].engine, 'dsh');
  assert.equal(dispatchCalls[4].sessionId, 'dsh-sid-1');
  assert.equal(dispatchCalls[4].cwd, subDir);

  await send('/use claude');
  await send('/run 补充边界');
  assert.equal(dispatchCalls[5].engine, 'claude');
  assert.equal(dispatchCalls[5].sessionId, 'claude-sid-1');

  await send('/new');
  await send('全新提问');
  assert.equal(dispatchCalls[6].engine, 'claude');
  assert.equal(dispatchCalls[6].sessionId, null);
});

test('QQOneBotAdapter RFC6455 编解码、反向 WS 服务端与正向 WS 客户端全流程', async t => {
  // 1. Pure RFC6455 & OneBot helpers
  assert.equal(WS_GUID, '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  assert.equal(computeWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

  const shortMasked = encodeWsFrame('hello', { opcode: 0x1, mask: true });
  const medPayload = 'x'.repeat(300);
  const medUnmasked = encodeWsFrame(medPayload, { opcode: 0x1, mask: false });
  const combined = Buffer.concat([shortMasked, medUnmasked, Buffer.from([0x81, 0x05])]);
  const decoded = decodeWsFrames(combined);
  assert.equal(decoded.frames.length, 2);
  assert.equal(decoded.frames[0].text, 'hello');
  assert.equal(decoded.frames[1].text, medPayload);
  assert.equal(decoded.rest.length, 2);

  const segExtracted = extractOneBotText({
    post_type: 'message',
    message_type: 'group',
    self_id: 99999,
    user_id: 12345,
    group_id: 654321,
    message: [
      { type: 'at', data: { qq: '99999' } },
      { type: 'text', data: { text: ' @claude 帮我看一下 ' } },
    ],
  });
  assert.equal(segExtracted.mentioned, true);
  assert.equal(segExtracted.isGroup, true);
  assert.equal(segExtracted.chatKey, 'group:654321');
  assert.equal(segExtracted.text, '@claude 帮我看一下');

  const rawExtracted = extractOneBotText({
    post_type: 'message',
    message_type: 'group',
    self_id: 99999,
    user_id: 12345,
    group_id: 654321,
    raw_message: '[CQ:at,qq=99999] [CQ:at,qq=88888,name=Bob] /status',
  });
  assert.equal(rawExtracted.mentioned, true);
  assert.equal(rawExtracted.text, '@Bob  /status');

  assert.equal(chunkText('a\n'.repeat(2500), 3500).length, 2);
  assert.deepEqual(parseOneBotTarget('private:123'), { type: 'private', id: '123' });
  assert.deepEqual(parseOneBotTarget('group:456'), { type: 'group', id: '456' });
  assert.deepEqual(parseOneBotTarget('789'), { type: 'private', id: '789' });

  // 2. Reverse WS server mode on 127.0.0.1:0
  const receivedReverse = [];
  const reverseAdapter = new QQOneBotAdapter({
    config: {
      enabled: true,
      mode: 'server',
      listenHost: '127.0.0.1',
      listenPort: 0,
      listenPath: '/onebot/v11/ws',
      accessToken: 'secret-token',
      groupRequireMention: true,
      pushTargets: ['private:11111', 'group:22222', '33333'],
      actionTimeoutMs: 3000,
    },
    onMessage: async msg => {
      receivedReverse.push(msg);
      if (msg.text === 'BIG_CHUNK') {
        await msg.reply('L'.repeat(3600));
      } else {
        await msg.reply(`echo:${msg.text}`);
      }
    },
  });

  t.after(async () => {
    await reverseAdapter.stop();
  });

  const listenStatus = await reverseAdapter.start();
  assert.equal(listenStatus.status, 'listening');
  const port = listenStatus.port;
  assert.ok(port > 0);

  // Auth / path rejection checks via raw TCP HTTP upgrade
  const checkHttpStatus = (reqPath, extraHeaders = '') => new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(
        `GET ${reqPath} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + extraHeaders
        + '\r\n',
      );
    });
    let data = '';
    sock.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.includes('\r\n\r\n')) {
        sock.destroy();
        resolve(data.split('\r\n')[0]);
      }
    });
    sock.on('error', reject);
  });

  assert.match(await checkHttpStatus('/wrong/path'), /404/);
  assert.match(await checkHttpStatus('/onebot/v11/ws'), /401/);
  assert.match(await checkHttpStatus('/onebot/v11/ws?access_token=bad'), /401/);

  // Connect real globalThis.WebSocket client with valid token
  const clientActions = [];
  const wsClient = new globalThis.WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws?access_token=secret-token`);
  t.after(() => { try { wsClient.close(); } catch {} });

  await new Promise((resolve, reject) => {
    wsClient.addEventListener('open', resolve, { once: true });
    wsClient.addEventListener('error', reject, { once: true });
  });
  wsClient.addEventListener('message', ev => {
    const frame = JSON.parse(String(ev.data));
    clientActions.push(frame);
    if (frame.echo) {
      wsClient.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: frame.echo }));
    }
  });

  await waitFor(() => reverseAdapter.getStatus().status === 'connected');

  // Unmentioned group chatter ignored
  wsClient.send(JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    self_id: 99999,
    user_id: 1001,
    group_id: 22222,
    raw_message: 'plain chatter without mention',
  }));
  await new Promise(r => setTimeout(r, 60));
  assert.equal(receivedReverse.length, 0);

  // Mentioned group command accepted & chunked reply works
  wsClient.send(JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    self_id: 99999,
    user_id: 1001,
    group_id: 22222,
    raw_message: '[CQ:at,qq=99999] BIG_CHUNK',
  }));
  await waitFor(() => clientActions.filter(a => a.action === 'send_group_msg').length >= 2);
  const groupChunks = clientActions.filter(a => a.action === 'send_group_msg');
  assert.equal(groupChunks[0].params.group_id, 22222);
  assert.equal(groupChunks.map(c => c.params.message).join('').length, 3600);

  // Push to private:, group:, and plain QQ id
  const pushRes = await reverseAdapter.push('服务告警测试');
  assert.equal(pushRes.ok, true);
  assert.equal(pushRes.sent, 3);
  assert.ok(clientActions.some(a => a.action === 'send_private_msg' && a.params.user_id === 11111));
  assert.ok(clientActions.some(a => a.action === 'send_group_msg' && a.params.group_id === 22222 && a.params.message === '服务告警测试'));
  assert.ok(clientActions.some(a => a.action === 'send_private_msg' && a.params.user_id === 33333));

  // Raw TCP client sends Ping + fragmented text frame (fin=false + continuation fin=true)
  await new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(
        `GET /onebot/v11/ws HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Authorization: Bearer secret-token\r\n'
        + 'X-Self-ID: 77777\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + 'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let upgraded = false;
    let buf = Buffer.alloc(0);
    let gotPong = false;
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const headText = buf.subarray(0, idx).toString('utf8');
        assert.match(headText, /101 Switching Protocols/);
        upgraded = true;
        buf = buf.subarray(idx + 4);
        sock.write(encodeWsFrame('ping1', { opcode: 0x9, mask: true }));
        const payload = JSON.stringify({
          post_type: 'message',
          message_type: 'private',
          user_id: 555,
          raw_message: 'frag-ok',
        });
        const half = Math.floor(payload.length / 2);
        sock.write(encodeWsFrame(payload.slice(0, half), { opcode: 0x1, fin: false, mask: true }));
        sock.write(encodeWsFrame(payload.slice(half), { opcode: 0x0, fin: true, mask: true }));
      }
      if (upgraded && buf.length > 0) {
        const res = decodeWsFrames(buf);
        buf = res.rest;
        for (const f of res.frames) {
          if (f.opcode === 0xA && f.payload.toString('utf8') === 'ping1') gotPong = true;
          if (f.opcode === 0x1) {
            const act = JSON.parse(f.text);
            if (act.echo) {
              sock.write(encodeWsFrame(JSON.stringify({ status: 'ok', retcode: 0, echo: act.echo }), { opcode: 0x1, mask: true }));
            }
            if (act.action === 'send_private_msg' && act.params.message === 'echo:frag-ok' && gotPong) {
              sock.destroy();
              resolve();
            }
          }
        }
      }
    });
    sock.on('error', reject);
  });

  // 3. Forward WS client mode against loopback WS server
  let serverConn = null;
  let sawAccessToken = '';
  const mockOneBotServer = await createLoopbackWsServer({
    onUpgradeCheck: req => {
      const u = new URL(req.url, 'http://127.0.0.1');
      sawAccessToken = u.searchParams.get('access_token') || '';
      return sawAccessToken === 'fwd-secret' ? null : { rejectStatus: 401 };
    },
    onConnection: conn => {
      serverConn = conn;
      conn.onText = raw => {
        const act = JSON.parse(raw);
        if (act.echo) conn.sendJson({ status: 'ok', retcode: 0, data: {}, echo: act.echo });
      };
    },
  });
  t.after(() => mockOneBotServer.close());

  const clientAdapter = new QQOneBotAdapter({
    config: {
      enabled: true,
      mode: 'client',
      wsUrl: mockOneBotServer.url,
      accessToken: 'fwd-secret',
      actionTimeoutMs: 3000,
    },
    onMessage: async msg => {
      await msg.reply(`client-reply:${msg.text}`);
    },
  });
  t.after(() => clientAdapter.stop());

  await clientAdapter.start();
  await waitFor(() => clientAdapter.isConnected() && serverConn);
  assert.equal(sawAccessToken, 'fwd-secret');

  serverConn.sendJson({
    post_type: 'message',
    message_type: 'private',
    self_id: 888,
    user_id: 4242,
    raw_message: '/help',
  });
  await waitFor(() => serverConn.messages.some(m => m.includes('client-reply:/help')));
});

test('WeComAdapter 帧构造/解析、本地 WS 长连接流式回复与 Webhook HTTP POST', async t => {
  // 1. Pure helpers
  assert.equal(DEFAULT_WECOM_WS_URL, 'wss://openws.work.weixin.qq.com');
  const sub = buildSubscribeFrame({ botId: 'b1', secret: 's1', reqId: 'r1' });
  assert.deepEqual(sub, { cmd: 'aibot_subscribe', headers: { req_id: 'r1' }, body: { bot_id: 'b1', secret: 's1' } });
  const ping = buildPingFrame({ reqId: 'p1' });
  assert.deepEqual(ping, { cmd: 'ping', headers: { req_id: 'p1' } });
  const stream = buildRespondStreamFrame({ reqId: 'rq', streamId: 'st', content: 'hi', finish: false });
  assert.equal(stream.cmd, 'aibot_respond_msg');
  assert.equal(stream.body.stream.finish, false);
  const send = buildSendMsgFrame({ chatId: 'group:wr123', content: 'alert' });
  assert.equal(send.cmd, 'aibot_send_msg');
  assert.equal(send.body.chatid, 'wr123');

  const cbGroup = parseCallbackFrame({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-g1' },
    body: {
      msgid: 'm1',
      chattype: 'group',
      chatid: 'wr-room-1',
      from: { userid: 'zhangsan', name: '张三' },
      text: { content: '@小鑫 @claude 检查接口' },
    },
  }, { botName: '小鑫' });
  assert.equal(cbGroup.chattype, 'group');
  assert.equal(cbGroup.chatKey, 'group:wr-room-1');
  assert.equal(cbGroup.senderId, 'zhangsan');
  assert.equal(cbGroup.text, '@claude 检查接口');
  assert.equal(chunkMarkdown('line\n'.repeat(5000), 16000).length, 2);

  // 2. Local mock WeCom WS server + Webhook HTTP server
  let wecomConn = null;
  const wsFrames = [];
  const mockWecomWs = await createLoopbackWsServer({
    onConnection: conn => {
      wecomConn = conn;
      conn.onText = raw => {
        const frame = JSON.parse(raw);
        wsFrames.push(frame);
        if (frame.cmd === 'aibot_subscribe') {
          conn.sendJson({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' });
        } else if (frame.cmd === 'ping') {
          conn.sendJson({ cmd: 'pong', headers: { req_id: frame.headers.req_id } });
        }
      };
    },
  });
  t.after(() => mockWecomWs.close());

  const webhookBodies = [];
  let webhookFailNext = false;
  const webhookSrv = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    webhookBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (webhookFailNext) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errcode: 40001, errmsg: 'invalid webhook' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
  });
  await new Promise(resolve => webhookSrv.listen(0, '127.0.0.1', resolve));
  const webhookUrl = `http://127.0.0.1:${webhookSrv.address().port}/webhook`;
  t.after(async () => {
    webhookSrv.closeAllConnections?.();
    await new Promise(resolve => webhookSrv.close(resolve));
  });

  const adapter = new WeComAdapter({
    config: {
      enabled: true,
      wsUrl: mockWecomWs.url,
      botId: 'bot-123',
      secret: 'sec-456',
      botName: '小鑫',
      webhookUrl,
      pushTargets: ['lisi', 'group:wr999'],
      heartbeatMs: 80,
      streamThrottleMs: 500,
    },
    onMessage: async msg => {
      msg.onProgress({ text: '🔧 正在执行测试' });
      await new Promise(r => setTimeout(r, 20));
      await msg.reply(`完成: ${msg.text}`);
    },
  });
  t.after(() => adapter.stop());

  await adapter.start();
  await waitFor(() => adapter.getStatus().subscribed === true && wsFrames.some(f => f.cmd === 'ping'));
  assert.equal(adapter.getStatus().status, 'connected');
  assert.equal(adapter.getStatus().state, 'connected');

  const subFrame = wsFrames.find(f => f.cmd === 'aibot_subscribe');
  assert.deepEqual(subFrame.body, { bot_id: 'bot-123', secret: 'sec-456' });

  // Simulate incoming callback -> streaming progress + finish
  wecomConn.sendJson({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'cb-req-1' },
    body: {
      msgid: 'msg-1',
      chattype: 'single',
      from: { userid: 'zhangsan' },
      text: { content: '运行验证' },
    },
  });

  await waitFor(() => wsFrames.some(f => f.cmd === 'aibot_respond_msg' && f.body?.stream?.finish === true));
  const streamFrames = wsFrames.filter(f => f.cmd === 'aibot_respond_msg');
  assert.ok(streamFrames.length >= 2);
  assert.equal(streamFrames[0].headers.req_id, 'cb-req-1');
  assert.equal(streamFrames[0].body.stream.finish, false);
  assert.match(streamFrames[0].body.stream.content, /正在执行测试/);
  const finalFrame = streamFrames[streamFrames.length - 1];
  assert.equal(finalFrame.headers.req_id, 'cb-req-1');
  assert.equal(finalFrame.body.stream.id, streamFrames[0].body.stream.id);
  assert.equal(finalFrame.body.stream.finish, true);
  assert.equal(finalFrame.body.stream.content, '完成: 运行验证');

  // Push via aibot_send_msg + Webhook
  const pushOk = await adapter.push('企微告警推送');
  assert.equal(pushOk.ok, true);
  assert.equal(pushOk.sent, 3); // 2 pushTargets + 1 webhook
  const sentFrames = wsFrames.filter(f => f.cmd === 'aibot_send_msg');
  assert.equal(sentFrames.length, 2);
  assert.equal(sentFrames[0].body.chatid, 'lisi');
  assert.equal(sentFrames[1].body.chatid, 'wr999');
  assert.equal(webhookBodies.length, 1);
  assert.equal(webhookBodies[0].markdown.content, '企微告警推送');

  // Webhook error path
  webhookFailNext = true;
  const pushErr = await adapter.push('再推一次');
  assert.equal(pushErr.ok, false);
  assert.match(pushErr.detail, /invalid webhook/);
});

test('BotService 0600 持久化、冷启动防刷屏、实时状态推送、冷却节流、自派活去重与端到端联动', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-bot-service-'));
  const dir = await realpath(rawDir);
  const dataDir = join(dir, 'data');
  const workDir = join(dir, 'work');
  const argsLog = join(dir, 'e2e-claude-args.jsonl');
  await mkdir(dataDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const mockClaude = await makeMockExecutable(
    join(dir, 'mock-claude'),
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 ? args[pIdx + 1] : '';
const rIdx = args.indexOf('--resume');
const sid = rIdx >= 0 ? args[rIdx + 1] : 'ses-e2e-1';
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: sid, result: 'E2E:' + prompt }));
`,
  );

  const prevClaude = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = mockClaude;
  t.after(async () => {
    if (prevClaude === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prevClaude;
    await rm(rawDir, { recursive: true, force: true });
  });

  // Pure helpers
  assert.equal(generatePairingCode(6).length, 6);
  const norm = normalizeBotConfig({ defaultEngine: 'invalid', allowedWorkspaces: [] });
  assert.equal(norm.defaultEngine, DEFAULT_BOT_CONFIG.defaultEngine);
  assert.deepEqual(norm.allowedWorkspaces, [os.homedir()]);
  assert.match(formatStatusAlert({ providerLabel: 'Codex', title: 'pet · 1', detail: '等待确认', sessionId: 'codex:1' }), /\[Codex\] pet · 1/);

  const svc = new BotService({
    rootDir: ROOT_DIR,
    dataDir,
  });
  t.after(() => svc.stop());

  // 1. Check bot.json 0600 permissions & persistence
  const cfgPath = join(dataDir, 'bot.json');
  assert.equal(existsSync(cfgPath), true);
  assert.equal((await stat(cfgPath)).mode & 0o777, 0o600);
  const initialPairing = svc.getState().config.pairingCode;
  assert.match(initialPairing, /^[A-Z0-9]{6}$/);

  await svc.start();
  await svc.saveConfig({
    defaultEngine: 'claude',
    defaultCwd: workDir,
    allowedWorkspaces: [dir],
    notifications: { enabled: true, onWaiting: true, onBlocked: true, onReady: true, cooldownMs: 250 },
    qq: {
      enabled: true,
      mode: 'server',
      listenHost: '127.0.0.1',
      listenPort: 0,
      listenPath: '/onebot/v11/ws',
      accessToken: 'e2e-tok',
      pushTargets: ['private:8888'],
    },
  });

  const qqStatus = svc.getState().channels.qq;
  assert.equal(qqStatus.status, 'listening');
  assert.equal(qqStatus.state, 'listening');
  const qqPort = qqStatus.port;

  // Connect mock QQ OneBot client
  const sentToQq = [];
  const ws = new globalThis.WebSocket(`ws://127.0.0.1:${qqPort}/onebot/v11/ws?access_token=e2e-tok`);
  t.after(() => { try { ws.close(); } catch {} });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', ev => {
    const frame = JSON.parse(String(ev.data));
    sentToQq.push(frame);
    if (frame.echo) {
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: frame.echo }));
    }
  });
  await waitFor(() => svc.qq.isConnected());

  // 2. Cold boot: suppress historical ready & stale waiting (>120s)
  const now = Date.now();
  const coldSent = await svc.onSnapshot({
    items: [
      { provider: 'claude', providerLabel: 'Claude Code', sessionId: 'claude:old-ready', status: 'ready', title: 'old', detail: '已完成', updatedAt: now, lastSeq: 1 },
      { provider: 'codex', providerLabel: 'Codex', sessionId: 'codex:stale-wait', status: 'waiting', title: 'stale', detail: '等待', updatedAt: now - 300_000, lastSeq: 1 },
    ],
  });
  assert.equal(coldSent, 0);

  // 3. Live status transitions + cooldown + self-dispatched dedup
  svc.dispatcher._markDispatched('claude', 'bot-own-ses');
  const liveSent1 = await svc.onSnapshot({
    items: [
      { provider: 'claude', providerLabel: 'Claude Code', sessionId: 'claude:bot-own-ses', status: 'waiting', title: 'bot', detail: '待确认', updatedAt: Date.now(), lastSeq: 1 },
      { provider: 'codex', providerLabel: 'Codex', sessionId: 'codex:term-1', status: 'waiting', title: 'proj · term-1', detail: '需要你在 Codex 中回答', updatedAt: Date.now(), lastSeq: 2 },
    ],
  });
  assert.equal(liveSent1, 1);
  assert.ok(sentToQq.some(f => f.action === 'send_private_msg' && f.params.message.includes('[Codex] proj · term-1')));

  // Immediate transition within 250ms cooldown is suppressed
  const suppressedByCooldown = await svc.onSnapshot({
    items: [
      { provider: 'codex', providerLabel: 'Codex', sessionId: 'codex:term-1', status: 'ready', title: 'proj · term-1', detail: '本轮结束', updatedAt: Date.now(), lastSeq: 3 },
    ],
  });
  assert.equal(suppressedByCooldown, 0);

  // After cooldown expires, new status change pushes again
  await new Promise(r => setTimeout(r, 280));
  const afterCooldown = await svc.onSnapshot({
    items: [
      { provider: 'codex', providerLabel: 'Codex', sessionId: 'codex:term-1', status: 'blocked', title: 'proj · term-1', detail: '遇到问题', updatedAt: Date.now(), lastSeq: 4 },
    ],
  });
  assert.equal(afterCooldown, 1);

  // 4. End-to-end QQ incoming message -> unauthorized -> /pair -> /claude -> plain follow-up
  const sendPrivateFromQq = text => {
    ws.send(JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      self_id: 90001,
      user_id: 7777,
      raw_message: text,
    }));
  };

  sendPrivateFromQq('/status');
  await waitFor(() => sentToQq.some(f => f.params?.user_id === 7777 && f.params?.message.includes('未授权')));

  sendPrivateFromQq(`/pair ${initialPairing}`);
  await waitFor(() => sentToQq.some(f => f.params?.user_id === 7777 && f.params?.message.includes('配对成功')));

  // Verify authorization persisted across BotService reload
  const svcReloaded = new BotService({ rootDir: ROOT_DIR, dataDir });
  assert.ok(svcReloaded.getState().config.authorizedUsers.qq.includes('7777'));

  sendPrivateFromQq('/claude 第一步');
  await waitFor(() => sentToQq.some(f => f.params?.user_id === 7777 && f.params?.message.includes('E2E:第一步')));

  sendPrivateFromQq('第二步追问');
  await waitFor(() => sentToQq.some(f => f.params?.user_id === 7777 && f.params?.message.includes('E2E:第二步追问')));

  const e2eArgs = (await readFile(argsLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(e2eArgs.length, 2);
  assert.ok(e2eArgs[1].includes('--resume'));
  assert.equal(e2eArgs[1][e2eArgs[1].indexOf('--resume') + 1], 'ses-e2e-1');

  // 4b. testPush & regeneratePairingCode
  const qqTestRes = await svc.testPush('qq');
  assert.equal(qqTestRes.ok, true);
  assert.equal(qqTestRes.sent, 1);
  const wecomDisabledRes = await svc.testPush('wecom');
  assert.equal(wecomDisabledRes.ok, false);
  const regenerated = svc.regeneratePairingCode();
  assert.match(regenerated.config.pairingCode, /^[A-Z0-9]{6}$/);
  assert.equal((await stat(cfgPath)).mode & 0o777, 0o600);

  // 5. Headless startBotServer smoke test
  const srvDir = join(dir, 'headless-data');
  const srv = await startBotServer({
    rootDir: ROOT_DIR,
    dataDir: srvDir,
    pollIntervalMs: 5000,
    attachSignals: false,
  });
  assert.ok(srv.botService.getState().config.pairingCode);
  await srv.stop();
});

test('独立运行 WebM 动画资产、Manager UI DOM/CSP 契约及无 ~/.dsh 独立安装/启动检查', async t => {
  // 1. All 5 required WebM animations exist in repo assets/webm/
  const requiredWebms = [
    '待机呼吸休闲.webm',
    '工作状态-忙碌点按.webm',
    '工作状态-原地踱步张望.webm',
    '工作状态-垂头叹气冒汗.webm',
    '工作状态-雀跃庆祝.webm',
  ];
  for (const name of requiredWebms) {
    const info = await stat(join(ROOT_DIR, 'assets/webm', name));
    assert.ok(info.isFile() && info.size > 1000, `missing or empty webm: ${name}`);
  }

  // 2. Manager HTML CSP & DOM ID alignment with manager.js
  const html = await readFile(join(ROOT_DIR, 'runtime/manager.html'), 'utf8');
  const js = await readFile(join(ROOT_DIR, 'runtime/manager.js'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /unsafe-inline/);
  assert.doesNotMatch(html, /\son\w+=/i);
  assert.doesNotMatch(html, /\sstyle=/i);

  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const referencedIds = [...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);
  assert.ok(referencedIds.length >= 60);
  for (const id of referencedIds) {
    assert.ok(htmlIds.has(id), `manager.js references missing DOM id: ${id}`);
  }

  // 3. scripts/install.py standalone dry check in isolated temp HOME without ~/.dsh
  const tempRoot = await mkdtemp(join(tmpdir(), 'agent-pet-standalone-'));
  const fakeHome = join(tempRoot, 'home');
  const fakeData = join(tempRoot, 'pet-data');
  await mkdir(fakeHome, { recursive: true });
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const installRes = spawnSync('python3', [join(ROOT_DIR, 'scripts/install.py')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOME: fakeHome,
      AGENT_PET_DATA: fakeData,
      AGENT_PET_ELECTRON: '/usr/bin/true',
    },
    encoding: 'utf8',
  });
  assert.equal(installRes.status, 0, installRes.stderr);
  assert.match(installRes.stdout, /standalone mode/);
  assert.equal(existsSync(join(fakeHome, '.dsh')), false);

  const launcher = join(fakeHome, 'Applications/Agent Pet.app/Contents/MacOS/AgentPet');
  assert.equal(existsSync(launcher), true);
  assert.equal((await stat(launcher)).mode & 0o111, 0o111);
  assert.equal(existsSync(join(fakeHome, 'Applications/Agent Pet.app/Contents/Info.plist')), true);
  const connectorsCfg = JSON.parse(await readFile(join(fakeData, 'connectors.json'), 'utf8'));
  assert.deepEqual(connectorsCfg.enabled, ['dsh']);

  // 4. scripts/start.cjs exits cleanly when no Electron runtime is present
  const startEnv = { ...process.env, HOME: fakeHome, PATH: '' };
  delete startEnv.AGENT_PET_ELECTRON;
  const startRes = spawnSync(process.execPath, [join(ROOT_DIR, 'scripts/start.cjs')], {
    cwd: ROOT_DIR,
    env: startEnv,
    encoding: 'utf8',
  });
  assert.equal(startRes.status, 1);
  assert.match(startRes.stderr, /无法找到 Electron 运行时/);
});

test('LocalChatBridge 会话创建、图片 base64 落盘与清理、多轮 --resume、列表/详情与取消', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-local-chat-'));
  const dir = await realpath(rawDir);
  const workDir = join(dir, 'work');
  const dataDir = join(dir, 'data');
  const claudeArgsLog = join(dir, 'local-claude-args.jsonl');
  const codexArgsLog = join(dir, 'local-codex-args.jsonl');
  await mkdir(join(workDir, 'src'), { recursive: true });
  await mkdir(join(workDir, 'node_modules/ignored'), { recursive: true });
  await mkdir(join(workDir, '.git'), { recursive: true });
  await writeFile(join(workDir, 'src/app.js'), 'console.log("ok");\n', 'utf8');
  await writeFile(join(workDir, 'README.md'), '# demo\n', 'utf8');
  await writeFile(join(workDir, 'node_modules/ignored/pkg.js'), 'x\n', 'utf8');
  await mkdir(dataDir, { recursive: true });

  const mockClaude = await makeMockExecutable(
    join(dir, 'mock-claude'),
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 ? args[pIdx + 1] : '';
const rIdx = args.indexOf('--resume');
const resumed = rIdx >= 0 ? args[rIdx + 1] : null;
const sid = resumed || 'cli-claude-ses-1';
const addDirs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--add-dir' && args[i + 1]) addDirs.push(args[i + 1]);
}
const imgMatch = prompt.match(/\\[附加图片路径: ([^\\]]+) —/);
const imgPaths = imgMatch ? imgMatch[1].split(', ').map(s => s.trim()) : [];
const imgExisted = imgPaths.map(p => fs.existsSync(p));
fs.appendFileSync(${JSON.stringify(claudeArgsLog)}, JSON.stringify({ args, prompt, resumed, addDirs, imgPaths, imgExisted }) + '\\n');

if (prompt.includes('SLOW_LOCAL_CANCEL')) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cli-claude-slow' }));
  process.on('SIGTERM', () => process.exit(0));
  setTimeout(() => process.exit(0), 10000);
} else {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }));
  console.log(JSON.stringify({
    type: 'assistant',
    session_id: sid,
    message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Read' }] },
  }));
  setTimeout(() => {
    console.log(JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: sid,
      result: (resumed ? 'Claude续接:' : 'Claude首轮:') + prompt.split('\\n').pop(),
    }));
  }, 40);
}
`,
  );

  const mockCodex = await makeMockExecutable(
    join(dir, 'mock-codex'),
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
const isResume = args[0] === 'exec' && args[1] === 'resume';
const prompt = args[args.length - 1];
const tid = isResume ? args[args.length - 2] : 'thread-local-codex-1';
const iPaths = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-i' && args[i + 1]) iPaths.push(args[i + 1]);
}
fs.appendFileSync(${JSON.stringify(codexArgsLog)}, JSON.stringify({ args, isResume, tid, prompt, iPaths }) + '\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: tid }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: (isResume ? 'Codex续接:' : 'Codex首轮:') + prompt } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`,
  );

  const prevClaude = process.env.CLAUDE_BIN;
  const prevCodex = process.env.CODEX_BIN;
  process.env.CLAUDE_BIN = mockClaude;
  process.env.CODEX_BIN = mockCodex;
  t.after(async () => {
    if (prevClaude === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prevClaude;
    if (prevCodex === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prevCodex;
    await rm(rawDir, { recursive: true, force: true });
  });

  const dispatcher = new TaskDispatcher({
    dataDir,
    allowedWorkspaces: [dir],
    defaultCwd: workDir,
    sandboxMode: 'auto',
  });
  const cfg = { defaultEngine: 'claude', defaultCwd: workDir };
  const bridge = new LocalChatBridge({ dispatcher, getConfig: () => cfg });

  assert.equal(bridge.isLocalSessionId('local:claude:123'), true);
  assert.equal(bridge.isLocalSessionId('session-123'), false);
  assert.equal(bridge.resolveEngine('codex'), 'codex');
  assert.equal(bridge.resolveEngine('auto'), 'claude');

  const infoRes = await bridge.handleAction({ action: 'info' }, 'auto');
  assert.equal(infoRes.connected, true);
  assert.equal(infoRes.speechAvailable, true);
  assert.equal(infoRes.model, 'claude');
  assert.deepEqual(infoRes.models, ['claude', 'codex']);

  const modelsRes = await bridge.handleAction({ action: 'models' }, 'auto');
  assert.equal(modelsRes.current, 'claude');
  assert.equal(modelsRes.groups[0].models.length, 2);

  const skillsRes = await bridge.handleAction({ action: 'skills' }, 'auto');
  assert.ok(skillsRes.skills.some(s => s.name === 'diff'));

  const filesRes = await bridge.handleAction({ action: 'files', query: 'app' }, 'auto');
  assert.ok(filesRes.candidates.some(f => f.path === 'src/app.js'));
  assert.ok(!filesRes.candidates.some(f => f.path.includes('node_modules')));

  // 1. Create + ui.js style base64 image + data URL image prompt
  const created = await bridge.handleAction({ action: 'create', sessionId: 'session-ui-alias-1' }, 'claude');
  assert.match(created.sessionId, /^local:claude:/);
  assert.equal(created.status, 'idle');

  const pngBase64 = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const promptRes = await bridge.handleAction({
    action: 'prompt',
    sessionId: created.sessionId,
    content: [
      { type: 'text', text: '分析截图报错' },
      { type: 'image', mediaType: 'image/png', data: pngBase64 },
    ],
    images: [`data:image/jpeg;base64,${Buffer.from('ffd8ffe0', 'hex').toString('base64')}`],
  }, 'claude');
  assert.equal(promptRes.status, 'running');

  const listWhileRunning = bridge.listSessions('claude');
  assert.equal(listWhileRunning.length, 1);
  assert.equal(listWhileRunning[0].status, 'running');
  assert.deepEqual(listWhileRunning[0].capabilities, { reply: true, cancel: true, open: true });

  await waitFor(async () => {
    const conv = await bridge.handleAction({ action: 'conversation', sessionId: created.sessionId }, 'claude');
    return conv.status === 'ready' ? conv : null;
  });

  // Lookup via original explicit alias works too, and conversation marks unread=false
  const convAlias = await bridge.handleAction({ action: 'conversation', sessionId: 'session-ui-alias-1' }, 'claude');
  assert.equal(convAlias.sessionId, created.sessionId);
  assert.equal(convAlias.messages.length, 2);
  assert.equal(convAlias.messages[0].role, 'user');
  assert.equal(convAlias.messages[0].seq, 1);
  assert.equal(convAlias.messages[1].role, 'assistant');
  assert.ok(convAlias.messages[1].seq > convAlias.messages[0].seq);
  assert.match(convAlias.messages[1].text, /Claude首轮:分析截图报错/);
  assert.equal(bridge.listSessions('claude')[0].unread, false);

  // Follow-up turn uses --resume with captured cliSessionId
  await bridge.handleAction({
    action: 'prompt',
    sessionId: created.sessionId,
    text: '继续修复',
  }, 'claude');
  await waitFor(async () => {
    const conv = await bridge.handleAction({ action: 'conversation', sessionId: created.sessionId }, 'claude');
    return conv.status === 'ready' && conv.messages.length === 4 ? conv : null;
  });
  const conv2 = await bridge.handleAction({ action: 'conversation', sessionId: created.sessionId }, 'claude');
  assert.match(conv2.messages[3].text, /Claude续接:继续修复/);

  const claudeCalls = (await readFile(claudeArgsLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(claudeCalls.length, 2);
  assert.equal(claudeCalls[0].imgPaths.length, 2);
  assert.deepEqual(claudeCalls[0].imgExisted, [true, true]);
  assert.ok(claudeCalls[0].addDirs.includes(dirname(claudeCalls[0].imgPaths[0])));
  assert.equal(claudeCalls[1].resumed, 'cli-claude-ses-1');
  // Temp base64 image files must be cleaned up after completion
  for (const tmpImg of claudeCalls[0].imgPaths) {
    assert.equal(existsSync(tmpImg), false);
  }

  // 2. selectModel('codex') + multi-turn codex exec resume + listSessions filter
  const codexSess = await bridge.handleAction({ action: 'create' }, 'auto');
  assert.match(codexSess.sessionId, /^local:claude:/);
  await bridge.handleAction({
    action: 'selectModel',
    sessionId: codexSess.sessionId,
    model: { provider: 'local', model: 'codex' },
  }, 'auto');
  assert.equal(bridge.resolveEngine('auto'), 'codex');

  await bridge.handleAction({ action: 'prompt', sessionId: codexSess.sessionId, text: '第一轮codex' }, 'auto');
  await waitFor(async () => {
    const c = await bridge.handleAction({ action: 'conversation', sessionId: codexSess.sessionId }, 'auto');
    return c.status === 'ready' ? c : null;
  });
  await bridge.handleAction({ action: 'prompt', sessionId: codexSess.sessionId, text: '第二轮codex' }, 'auto');
  await waitFor(async () => {
    const c = await bridge.handleAction({ action: 'conversation', sessionId: codexSess.sessionId }, 'auto');
    return c.status === 'ready' && c.messages.length === 4 ? c : null;
  });
  const codexCalls = (await readFile(codexArgsLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(codexCalls.length, 2);
  assert.equal(codexCalls[0].isResume, false);
  assert.equal(codexCalls[1].isResume, true);
  assert.equal(codexCalls[1].tid, 'thread-local-codex-1');
  assert.equal(bridge.listSessions('codex').length, 1);
  assert.equal(bridge.listSessions('claude').length, 1);
  assert.equal(bridge.listSessions('auto').length, 2);

  // 3. Cancel active local job + error validation
  const slowSess = await bridge.handleAction({ action: 'create' }, 'claude');
  await bridge.handleAction({ action: 'prompt', sessionId: slowSess.sessionId, text: 'SLOW_LOCAL_CANCEL' }, 'claude');
  await waitFor(() => dispatcher.listJobs(5).find(j => j.status === 'running'));
  const cancelRes = await bridge.handleAction({ action: 'cancel', sessionId: slowSess.sessionId }, 'claude');
  assert.equal(cancelRes.cancelled, true);
  const slowConv = await bridge.handleAction({ action: 'conversation', sessionId: slowSess.sessionId }, 'claude');
  assert.equal(slowConv.status, 'cancelled');

  await assert.rejects(() => bridge.handleAction({ action: 'conversation', sessionId: 'local:claude:missing' }, 'claude'), /未找到/);
  await assert.rejects(() => bridge.handleAction({ action: 'prompt', sessionId: slowSess.sessionId, text: '   ' }, 'claude'), /不能为空/);
  await assert.rejects(() => bridge.handleAction({ action: 'unknownOp' }, 'claude'), /不支持/);
});

test('Git 工程化指令 (/diff, /log, /commit, /revert 预览与 confirm) 与非 Git 目录保护', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-bot-git-'));
  const dir = await realpath(rawDir);
  const repoDir = join(dir, 'repo');
  const plainDir = join(dir, 'non-git');
  await mkdir(repoDir, { recursive: true });
  await mkdir(plainDir, { recursive: true });
  t.after(() => rm(rawDir, { recursive: true, force: true }));

  const runGit = args => {
    const res = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return res.stdout.trim();
  };

  runGit(['init']);
  runGit(['config', 'user.name', 'Test Bot']);
  runGit(['config', 'user.email', 'test-bot@example.com']);
  await writeFile(join(repoDir, 'tracked.txt'), 'line 1\n', 'utf8');
  await mkdir(join(repoDir, 'sub'), { recursive: true });
  await writeFile(join(repoDir, 'sub/module.js'), 'export const v = 1;\n', 'utf8');
  runGit(['add', '-A']);
  runGit(['commit', '-m', 'chore: initial commit']);

  const dispatcher = new TaskDispatcher({
    dataDir: join(dir, 'data'),
    allowedWorkspaces: [dir],
    defaultCwd: repoDir,
  });
  const router = new CommandRouter({
    dispatcher,
    getConfig: () => ({ defaultEngine: 'claude', defaultCwd: repoDir }),
  });

  const send = text => router.handleMessage({
    channel: 'qq',
    chatKey: 'private:2002',
    senderId: '2002',
    text,
    isAuthorized: true,
    pairingCode: 'XYZ123',
  });

  // Clean state checks
  assert.match((await send('/diff')).text, /工作区干净/);
  assert.match((await send('查看改动')).text, /工作区干净/);
  assert.match((await send('/revert')).text, /没有可撤销/);
  assert.match((await send('/commit')).text, /用法：\/commit/);
  assert.match((await send('/commit nothing here')).text, /工作区干净/);
  assert.match((await send('/log')).text, /chore: initial commit/);

  // Modify tracked file + add untracked file -> /diff & subpath filter & /revert preview
  await writeFile(join(repoDir, 'tracked.txt'), 'line 1\nline 2 added\n', 'utf8');
  await writeFile(join(repoDir, 'sub/module.js'), 'export const v = 2;\n', 'utf8');
  await writeFile(join(repoDir, 'new-file.txt'), 'untracked content\n', 'utf8');

  const diffAll = await send('/diff');
  assert.match(diffAll.text, /tracked\.txt/);
  assert.match(diffAll.text, /new-file\.txt/);
  assert.match(diffAll.text, /\+line 2 added/);

  const diffSub = await send('/diff sub/module.js');
  assert.match(diffSub.text, /sub\/module\.js/);
  assert.doesNotMatch(diffSub.text, /line 2 added/);

  // Preview /revert must NOT discard files
  const revertPreview = await send('/revert');
  assert.match(revertPreview.text, /将被丢弃/);
  assert.match(revertPreview.text, /\/revert confirm/);
  assert.equal(existsSync(join(repoDir, 'new-file.txt')), true);
  assert.match(await readFile(join(repoDir, 'tracked.txt'), 'utf8'), /line 2 added/);

  const revertBad = await send('/revert nope');
  assert.match(revertBad.text, /用法：\/revert/);
  assert.equal(existsSync(join(repoDir, 'new-file.txt')), true);

  // /commit + /log
  const commitRes = await send('/commit feat: update tracked and add new file');
  assert.match(commitRes.text, /提交成功/);
  assert.match((await send('/diff')).text, /工作区干净/);

  const logRes = await send('提交记录 2');
  assert.match(logRes.text, /feat: update tracked and add new file/);
  assert.match(logRes.text, /chore: initial commit/);

  // Long diff truncation check (<= 3000 chars)
  await writeFile(join(repoDir, 'tracked.txt'), 'x'.repeat(5000) + '\n', 'utf8');
  const clippedDiff = await dispatcher.gitDiff(repoDir);
  assert.ok(clippedDiff.length <= 3000);
  assert.match(clippedDiff, /截断/);

  // /revert confirm restores tracked file & removes untracked file
  await writeFile(join(repoDir, 'temp-untracked.txt'), 'should vanish\n', 'utf8');
  const revertConfirm = await send('/revert confirm');
  assert.match(revertConfirm.text, /已撤销工作区未提交改动并清理未跟踪文件/);
  assert.equal(existsSync(join(repoDir, 'temp-untracked.txt')), false);
  assert.equal(await readFile(join(repoDir, 'tracked.txt'), 'utf8'), 'line 1\nline 2 added\n');

  // Non-git directory protection
  await send(`/cd ${plainDir}`);
  assert.match((await send('/diff')).text, /不是 Git 仓库/);
  assert.match((await send('/log')).text, /不是 Git 仓库/);
});

test('图片附件下载 (downloadTempImage)、TaskDispatcher 引擎透传与 QQ/企微渠道临时文件清理', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-bot-img-'));
  const dir = await realpath(rawDir);
  const workDir = join(dir, 'work');
  const dataDir = join(dir, 'data');
  const imgDirA = join(dir, 'imgs-a');
  const imgDirB = join(dir, 'imgs-b');
  const claudeArgsLog = join(dir, 'img-claude-args.jsonl');
  const codexArgsLog = join(dir, 'img-codex-args.jsonl');
  await mkdir(workDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(imgDirA, { recursive: true });
  await mkdir(imgDirB, { recursive: true });

  const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const jpgBytes = Buffer.from('ffd8ffe000104a464946', 'hex');
  const webpBytes = Buffer.from('524946460000000057454250', 'hex');

  const imgServer = createServer((req, res) => {
    if (req.url === '/ok.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(pngBytes.length) });
      res.end(pngBytes);
    } else if (req.url === '/photo') {
      res.writeHead(200, { 'content-type': 'image/jpeg; charset=binary' });
      res.end(jpgBytes);
    } else if (req.url === '/from-url.webp') {
      res.writeHead(200);
      res.end(webpBytes);
    } else if (req.url === '/too-big.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '9999999' });
      res.end(pngBytes);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise(resolve => imgServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${imgServer.address().port}`;

  const mockClaude = await makeMockExecutable(
    join(dir, 'mock-claude'),
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(claudeArgsLog)}, JSON.stringify(args) + '\\n');
const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 ? args[pIdx + 1] : '';
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ses-img-claude' }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'ses-img-claude', result: 'CLAUDE_IMG_OK:' + prompt }));
`,
  );
  const mockCodex = await makeMockExecutable(
    join(dir, 'mock-codex'),
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(codexArgsLog)}, JSON.stringify(args) + '\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-img-codex' }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'CODEX_IMG_OK' } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`,
  );

  const prevClaude = process.env.CLAUDE_BIN;
  const prevCodex = process.env.CODEX_BIN;
  process.env.CLAUDE_BIN = mockClaude;
  process.env.CODEX_BIN = mockCodex;

  const tempDownloads = [];
  t.after(async () => {
    if (prevClaude === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prevClaude;
    if (prevCodex === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prevCodex;
    for (const p of tempDownloads) await rm(p, { force: true }).catch(() => {});
    imgServer.closeAllConnections?.();
    await new Promise(resolve => imgServer.close(resolve));
    await rm(rawDir, { recursive: true, force: true });
  });

  // 1. downloadTempImage checks (both exports)
  assert.equal(downloadTempImage, downloadWeComTempImage);
  await assert.rejects(() => downloadTempImage('file:///etc/passwd'), /不支持的图片协议/);
  await assert.rejects(() => downloadTempImage('not-a-url'), /无效的图片 URL/);
  await assert.rejects(() => downloadTempImage(`${baseUrl}/missing.png`), /HTTP 404/);
  await assert.rejects(() => downloadTempImage(`${baseUrl}/too-big.png`, { maxBytes: 1024 }), /超出限制/);

  const dlPng = await downloadTempImage(`${baseUrl}/ok.png`);
  const dlJpg = await downloadTempImage(`${baseUrl}/photo`);
  const dlWebp = await downloadTempImage(`${baseUrl}/from-url.webp`);
  tempDownloads.push(dlPng, dlJpg, dlWebp);

  assert.match(dlPng, /agent-pet-img-.*\.png$/);
  assert.match(dlJpg, /agent-pet-img-.*\.jpg$/);
  assert.match(dlWebp, /agent-pet-img-.*\.webp$/);
  assert.equal((await stat(dlPng)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(dlPng), pngBytes);
  assert.deepEqual(await readFile(dlJpg), jpgBytes);

  // 2. TaskDispatcher image forwarding (claude deduplicated --add-dir & codex -i on exec + resume)
  const img1 = join(imgDirA, 'shot1.png');
  const img2 = join(imgDirA, 'shot2.png');
  const img3 = join(imgDirB, 'shot3.jpg');
  await writeFile(img1, pngBytes);
  await writeFile(img2, pngBytes);
  await writeFile(img3, jpgBytes);

  const dispatcher = new TaskDispatcher({
    dataDir,
    allowedWorkspaces: [dir],
    defaultCwd: workDir,
  });

  const cRes = await dispatcher.dispatch({
    engine: 'claude',
    prompt: '看看这些图',
    cwd: workDir,
    images: [img1, img2, img3, join(dir, 'does-not-exist.png'), img1],
  });
  assert.equal(cRes.status, 'completed');
  const claudeInv = JSON.parse((await readFile(claudeArgsLog, 'utf8')).trim().split('\n')[0]);
  const cPrompt = claudeInv[claudeInv.indexOf('-p') + 1];
  assert.match(cPrompt, new RegExp(`\\[附加图片路径: ${img1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, ${img2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, ${img3.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — 请先读取查看图片内容\\]`));
  const addDirs = [];
  for (let i = 0; i < claudeInv.length; i++) {
    if (claudeInv[i] === '--add-dir') addDirs.push(claudeInv[i + 1]);
  }
  assert.deepEqual(addDirs, [imgDirA, imgDirB]);

  const xRes1 = await dispatcher.dispatch({ engine: 'codex', prompt: '分析首图', cwd: workDir, images: [img1, img3] });
  const xRes2 = await dispatcher.dispatch({ engine: 'codex', prompt: '追问图', cwd: workDir, sessionId: xRes1.sessionId, images: [img2] });
  assert.equal(xRes2.status, 'completed');
  const codexInvs = (await readFile(codexArgsLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.ok(codexInvs[0].includes('-i'));
  assert.equal(codexInvs[0][codexInvs[0].indexOf('-i') + 1], img1);
  assert.equal(codexInvs[1][0], 'exec');
  assert.equal(codexInvs[1][1], 'resume');
  assert.ok(codexInvs[1].includes('-i'));
  assert.equal(codexInvs[1][codexInvs[1].indexOf('-i') + 1], img2);

  // 3. End-to-end QQ + WeCom image download -> BotService -> CommandRouter -> TaskDispatcher + cleanup
  const svc = new BotService({ rootDir: ROOT_DIR, dataDir });
  t.after(() => svc.stop());
  await svc.start();
  await svc.saveConfig({
    defaultEngine: 'claude',
    defaultCwd: workDir,
    allowedWorkspaces: [dir],
    authorizedUsers: { qq: ['3003'], wecom: ['wangwu'] },
    qq: { enabled: true, mode: 'server', listenHost: '127.0.0.1', listenPort: 0, listenPath: '/onebot/v11/ws' },
  });

  const qqPort = svc.getState().channels.qq.port;
  const qqSent = [];
  const qqSeenImages = [];
  svc.qq.on('message', m => qqSeenImages.push(...m.images));
  const qqWs = new globalThis.WebSocket(`ws://127.0.0.1:${qqPort}/onebot/v11/ws`);
  t.after(() => { try { qqWs.close(); } catch {} });
  await new Promise((resolve, reject) => {
    qqWs.addEventListener('open', resolve, { once: true });
    qqWs.addEventListener('error', reject, { once: true });
  });
  qqWs.addEventListener('message', ev => {
    const f = JSON.parse(String(ev.data));
    qqSent.push(f);
    if (f.echo) qqWs.send(JSON.stringify({ status: 'ok', retcode: 0, echo: f.echo }));
  });
  await waitFor(() => svc.qq.isConnected());

  // Image-only QQ segment triggers default image prompt & temp file gets cleaned up afterwards
  qqWs.send(JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    self_id: 99001,
    user_id: 3003,
    message: [{ type: 'image', data: { url: `${baseUrl}/ok.png` } }],
  }));
  await waitFor(() => qqSent.some(f => f.params?.message?.includes('CLAUDE_IMG_OK')));
  const qqReply = qqSent.find(f => f.params?.message?.includes('CLAUDE_IMG_OK')).params.message;
  assert.match(qqReply, /请分析这张图片中的问题并给出解决方案/);
  assert.equal(qqSeenImages.length, 1);
  await waitFor(() => !existsSync(qqSeenImages[0]));

  // WeCom mixed image + text through loopback WS server
  let wecomConn = null;
  const wecomReplies = [];
  const wecomWsSrv = await createLoopbackWsServer({
    onConnection: conn => {
      wecomConn = conn;
      conn.onText = raw => {
        const frame = JSON.parse(raw);
        if (frame.cmd === 'aibot_subscribe') {
          conn.sendJson({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' });
        } else if (frame.cmd === 'aibot_respond_msg') {
          wecomReplies.push(frame);
        }
      };
    },
  });
  t.after(() => wecomWsSrv.close());

  await svc.saveConfig({
    wecom: { enabled: true, wsUrl: wecomWsSrv.url, botId: 'b-img', secret: 's-img' },
  });
  await waitFor(() => svc.wecom.subscribed && wecomConn);

  const wecomSeenImages = [];
  svc.wecom.on('message', m => wecomSeenImages.push(...m.images));
  wecomConn.sendJson({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'cb-img-1' },
    body: {
      msgid: 'm-img-1',
      chattype: 'single',
      from: { userid: 'wangwu' },
      mixed: {
        msg_item: [
          { msgtype: 'text', text: { content: '检查企微截图' } },
          { msgtype: 'image', image: { url: `${baseUrl}/photo` } },
        ],
      },
    },
  });

  await waitFor(() => wecomReplies.some(f => f.body?.stream?.finish && f.body.stream.content.includes('CLAUDE_IMG_OK')));
  const finalWecom = wecomReplies.find(f => f.body?.stream?.finish);
  assert.match(finalWecom.body.stream.content, /检查企微截图/);
  assert.equal(wecomSeenImages.length, 1);
  assert.match(wecomSeenImages[0], /\.jpg$/);
  await waitFor(() => !existsSync(wecomSeenImages[0]));
});

test('AutoStartManager LaunchAgent plist 生成、XML 转义、enable/disable/setEnabled 与临时 homeDir 隔离', async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'agent-pet-autostart-'));
  const fakeHome = join(tempRoot, "home & 'test'");
  const fakeRoot = join(tempRoot, 'repo<dir>');
  await mkdir(fakeHome, { recursive: true });
  await mkdir(fakeRoot, { recursive: true });
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const mgr = new AutoStartManager({ homeDir: fakeHome, rootDir: fakeRoot });
  assert.equal(mgr.plistPath(), join(fakeHome, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`));
  assert.equal(mgr.isEnabled(), false);

  // Fallback ProgramArguments uses node + scripts/start.cjs
  assert.deepEqual(mgr.resolveProgramArguments(), [process.execPath, join(fakeRoot, 'scripts', 'start.cjs')]);

  // Enable & validate XML plist + 0644 permissions + XML escaping
  const enabledRes = mgr.setEnabled(true);
  assert.equal(enabledRes.enabled, true);
  assert.equal(enabledRes.plistPath, mgr.plistPath());
  assert.equal(mgr.isEnabled(), true);
  assert.equal((await stat(mgr.plistPath())).mode & 0o777, 0o644);

  const xml = await readFile(mgr.plistPath(), 'utf8');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"/);
  assert.match(xml, new RegExp(`<key>Label<\\/key>\\s*<string>${LAUNCH_AGENT_LABEL}<\\/string>`));
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(xml, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
  assert.match(xml, /repo&lt;dir&gt;\/scripts\/start\.cjs/);

  // Bundled AgentPet binary takes precedence over fallback
  const bundledExec = join(fakeHome, 'Applications', 'Agent Pet.app', 'Contents', 'MacOS', 'AgentPet');
  await mkdir(dirname(bundledExec), { recursive: true });
  await writeFile(bundledExec, '#!/bin/sh\n', { mode: 0o755 });
  assert.deepEqual(mgr.resolveProgramArguments(), [bundledExec]);

  mgr.enable();
  const bundledXml = await readFile(mgr.plistPath(), 'utf8');
  assert.match(bundledXml, /home &amp; &apos;test&apos;\/Applications\/Agent Pet\.app\/Contents\/MacOS\/AgentPet/);

  // Explicit appExecPath overrides bundled binary
  const customMgr = new AutoStartManager({ homeDir: fakeHome, rootDir: fakeRoot, appExecPath: '/Custom/AgentPet' });
  assert.deepEqual(customMgr.resolveProgramArguments(), ['/Custom/AgentPet']);

  // Disable removes plist and is idempotent
  const disabledRes = mgr.setEnabled(false);
  assert.equal(disabledRes.enabled, false);
  assert.equal(mgr.isEnabled(), false);
  assert.equal(existsSync(mgr.plistPath()), false);
  assert.equal(mgr.disable(), false);
});

function execSqlite(dbPath, sql) {
  const res = spawnSync('/usr/bin/sqlite3', [dbPath, sql], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
}

function sqlStr(val) {
  return `'${String(val).replace(/'/g, "''")}'`;
}

test('LocalChatBridge Per-Agent 工作区与会话发现 (cursor/opencode/antigravity/zcode/workbuddy) 及额外项目缓存扫描', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-discover-'));
  const dir = await realpath(rawDir);
  t.after(() => rm(rawDir, { recursive: true, force: true }));

  const defaultDir = join(dir, 'default-cwd');
  const appSupportDir = join(dir, 'AppSupport');
  const cursorStorageDir = join(appSupportDir, 'Cursor', 'User', 'globalStorage');
  const zcodeDir = join(dir, 'zcode-v2');
  const opencodeDbPath = join(dir, 'opencode.db');
  const antigravityDbPath = join(dir, 'conversation_summaries.db');
  const workbuddyDbPath = join(dir, 'workbuddy.db');
  const extraRoot = join(dir, 'scan-root');

  // Cursor directories (openedWindows vs lastActiveWindow vs state.vscdb)
  const cursorOpen1 = join(dir, 'cursor open space');
  const cursorOpenWsDir = join(dir, 'cursor-ws-open');
  const cursorBackup = join(dir, 'cursor-backup');
  const cursorLastActive = join(dir, 'cursor-last-active');
  const cursorRecent = join(dir, 'cursor-recent');
  const cursorRecentWsDir = join(dir, 'cursor-recent-ws');

  // OpenCode directories
  const ocProjNew = join(dir, 'oc-proj-new');
  const ocProjOld = join(dir, 'oc-proj-old');

  // Antigravity directories
  const agyProj1 = join(dir, 'agy-proj-1');
  const agyProj2 = join(dir, 'agy-proj-2');

  // ZCode directories
  const zcodeProj1 = join(dir, 'zcode-proj-1');
  const zcodeProj2 = join(dir, 'zcode-proj-2');
  const zcodeProj3 = join(dir, 'zcode-proj-3');

  // WorkBuddy directories
  const wbProj1 = join(dir, 'wb-proj-1');
  const wbProj2 = join(dir, 'wb-proj-2');

  // Extra scan directories
  const extraProjGit = join(extraRoot, 'proj-git');
  const extraProjPkg = join(extraRoot, 'proj-pkg');
  const extraProjPy = join(extraRoot, 'group', 'proj-py');
  const extraIgnoredNodeModules = join(extraRoot, 'node_modules', 'ignored-pkg');
  const extraPlainDir = join(extraRoot, 'plain-dir');

  for (const d of [
    defaultDir, cursorStorageDir, zcodeDir,
    cursorOpen1, cursorOpenWsDir, cursorBackup, cursorLastActive, cursorRecent, cursorRecentWsDir,
    ocProjNew, ocProjOld,
    agyProj1, agyProj2,
    zcodeProj1, zcodeProj2, zcodeProj3,
    wbProj1, wbProj2,
    join(extraProjGit, '.git'), extraProjPkg, extraProjPy, extraIgnoredNodeModules, extraPlainDir,
  ]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(join(cursorOpenWsDir, 'team.code-workspace'), '{}', 'utf8');
  await writeFile(join(cursorRecentWsDir, 'old.code-workspace'), '{}', 'utf8');
  await writeFile(join(extraProjPkg, 'package.json'), '{"name":"extra-pkg"}\n', 'utf8');
  await writeFile(join(extraProjPy, 'pyproject.toml'), '[project]\nname="extra-py"\n', 'utf8');
  await writeFile(join(extraIgnoredNodeModules, 'package.json'), '{"name":"ignored"}\n', 'utf8');

  // 1. Cursor fixtures: storage.json + state.vscdb
  await writeFile(join(cursorStorageDir, 'storage.json'), JSON.stringify({
    windowsState: {
      openedWindows: [
        { folder: pathToFileURL(cursorOpen1).href },
        { workspaceIdentifier: { configURIPath: pathToFileURL(join(cursorOpenWsDir, 'team.code-workspace')).href } },
      ],
      lastActiveWindow: { folder: pathToFileURL(cursorLastActive).href },
    },
    backupWorkspaces: {
      folders: [{ folderUri: pathToFileURL(cursorBackup).href }],
    },
  }), 'utf8');

  const recentJson = JSON.stringify({
    entries: [
      { folderUri: pathToFileURL(cursorRecent).href },
      { workspace: { configPath: pathToFileURL(join(cursorRecentWsDir, 'old.code-workspace')).href } },
      { folderUri: pathToFileURL(cursorOpen1).href }, // duplicate of opened window; must stay isOpen: true
    ],
  });
  execSqlite(
    join(cursorStorageDir, 'state.vscdb'),
    `CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);
     INSERT INTO ItemTable (key, value) VALUES ('history.recentlyOpenedPathsList', ${sqlStr(recentJson)});`,
  );

  // 2. OpenCode fixture: opencode.db (project + session_v2)
  execSqlite(
    opencodeDbPath,
    `CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, time_created INTEGER, time_updated INTEGER, time_active INTEGER);
     INSERT INTO project VALUES ('p-root', '/', 100, 100, 9999);
     INSERT INTO project VALUES ('p-old', ${sqlStr(ocProjOld)}, 100, 200, 200);
     INSERT INTO project VALUES ('p-new', ${sqlStr(ocProjNew)}, 100, 500, 600);
     CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER);
     INSERT INTO session_v2 VALUES ('oc-s-old-match', ${sqlStr(ocProjOld)}, 'Match Cwd Session', 1000);
     INSERT INTO session_v2 VALUES ('oc-s-new-other', ${sqlStr(ocProjNew)}, 'Newer Other Session', 5000);`,
  );

  // 3. Antigravity fixture: conversation_summaries.db
  execSqlite(
    antigravityDbPath,
    `CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time INTEGER);
     INSERT INTO conversation_summaries VALUES ('agy-s2', 'Older Match', ${sqlStr(JSON.stringify([pathToFileURL(agyProj1).href]))}, 1500);
     INSERT INTO conversation_summaries VALUES ('agy-s1', 'Latest Other', ${sqlStr(JSON.stringify([pathToFileURL(agyProj2).href]))}, 3000);`,
  );

  // 4. ZCode fixture: setting.json + tasks-index.sqlite
  await writeFile(join(zcodeDir, 'setting.json'), JSON.stringify({
    recentProjects: [zcodeProj1, { path: zcodeProj2 }],
  }), 'utf8');
  execSqlite(
    join(zcodeDir, 'tasks-index.sqlite'),
    `CREATE TABLE tasks (task_id TEXT PRIMARY KEY, workspace_path TEXT, title TEXT, updated_at INTEGER, deleted INTEGER DEFAULT 0);
     INSERT INTO tasks VALUES ('zc-t1', ${sqlStr(zcodeProj3)}, 'Active ZCode Task', 2000, 0);
     INSERT INTO tasks VALUES ('zc-t2', ${sqlStr(zcodeProj1)}, 'Newer ZCode Task', 4000, 0);
     INSERT INTO tasks VALUES ('zc-t-del', ${sqlStr(zcodeProj3)}, 'Deleted ZCode Task', 9999, 1);`,
  );

  // 5. WorkBuddy fixture: workbuddy.db (workspaces + sessions)
  execSqlite(
    workbuddyDbPath,
    `CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT, last_opened_at INTEGER);
     INSERT INTO workspaces VALUES ('wb-w1', ${sqlStr(wbProj2)}, 1000);
     INSERT INTO workspaces VALUES ('wb-w2', ${sqlStr(wbProj1)}, 2000);
     CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, updated_at INTEGER, deleted_at INTEGER);
     INSERT INTO sessions VALUES ('wb-s1', ${sqlStr(wbProj1)}, 'WB Active Match', 1500, NULL);
     INSERT INTO sessions VALUES ('wb-s2', ${sqlStr(wbProj2)}, 'WB Newer Other', 3500, NULL);
     INSERT INTO sessions VALUES ('wb-s-del', ${sqlStr(wbProj1)}, 'WB Soft Deleted', 9999, 12345);`,
  );

  const bridge = new LocalChatBridge({
    dispatcher: {
      defaultCwd: defaultDir,
      allowedWorkspaces: [dir],
      validateWorkspace: target => sanitizeWorkspace(target, [dir]),
      probeEngines: () => ({ claude: { available: true } }),
    },
    getConfig: () => ({ defaultEngine: 'claude', defaultCwd: defaultDir }),
    appSupportDir,
    opencodeDbPath,
    zcodeDir,
    workbuddyDbPath,
    antigravityDbPath,
    extraScanRoots: [extraRoot],
  });

  // Verify Cursor workspace discovery & isOpen priority ordering (all isOpen: true before isOpen: false)
  const cursorWs = bridge.discoverWorkspaces({ engine: 'cursor' });
  assert.deepEqual(
    cursorWs.map(w => [w.path, w.isOpen]),
    [
      [cursorOpen1, true],
      [cursorOpenWsDir, true],
      [cursorBackup, true],
      [cursorLastActive, false],
      [cursorRecent, false],
      [cursorRecentWsDir, false],
    ],
  );
  assert.ok(cursorWs.findIndex(w => w.path === cursorOpen1) < cursorWs.findIndex(w => w.path === cursorLastActive));
  assert.ok(cursorWs.findIndex(w => w.path === cursorBackup) < cursorWs.findIndex(w => w.path === cursorLastActive));
  assert.ok(cursorWs.findIndex(w => w.path === cursorOpenWsDir) < cursorWs.findIndex(w => w.path === cursorRecent));
  assert.ok(cursorWs.every(w => w.sourceEngine === 'cursor'));

  // Verify OpenCode workspace + session discovery
  const ocWs = bridge.discoverWorkspaces({ engine: 'opencode' });
  assert.deepEqual(ocWs.map(w => w.path), [ocProjNew, ocProjOld]);
  const ocSessions = bridge.discoverSessions({ engine: 'opencode', cwd: ocProjOld });
  assert.equal(ocSessions.length, 2);
  assert.equal(ocSessions[0].sessionId, 'oc-s-old-match');
  assert.equal(ocSessions[0].matchesCwd, true);
  assert.equal(ocSessions[1].sessionId, 'oc-s-new-other');
  assert.equal(ocSessions[1].matchesCwd, false);

  // Verify Antigravity workspace + session discovery
  const agyWs = bridge.discoverWorkspaces({ engine: 'antigravity' });
  assert.deepEqual(agyWs.map(w => w.path), [agyProj2, agyProj1]);
  const agySessions = bridge.discoverSessions({ engine: 'antigravity', cwd: agyProj1 });
  assert.equal(agySessions.length, 2);
  assert.equal(agySessions[0].sessionId, 'agy-s2');
  assert.equal(agySessions[0].matchesCwd, true);
  assert.equal(agySessions[1].sessionId, 'agy-s1');

  // Verify ZCode workspace + session discovery (deleted = 1 excluded)
  const zcodeWs = bridge.discoverWorkspaces({ engine: 'zcode' });
  assert.deepEqual(zcodeWs.map(w => w.path), [zcodeProj1, zcodeProj2, zcodeProj3]);
  const zcodeSessions = bridge.discoverSessions({ engine: 'zcode', cwd: zcodeProj3 });
  assert.deepEqual(zcodeSessions.map(s => s.sessionId), ['zc-t1', 'zc-t2']);
  assert.equal(zcodeSessions[0].matchesCwd, true);

  // Verify WorkBuddy workspace + session discovery (deleted_at IS NOT NULL excluded)
  const wbWs = bridge.discoverWorkspaces({ engine: 'workbuddy' });
  assert.deepEqual(wbWs.map(w => w.path), [wbProj1, wbProj2]);
  const wbSessions = bridge.discoverSessions({ engine: 'workbuddy', cwd: wbProj1 });
  assert.deepEqual(wbSessions.map(s => s.sessionId), ['wb-s1', 'wb-s2']);
  assert.equal(wbSessions[0].matchesCwd, true);

  // Verify discoverExtraWorkspaces: marker recognition, excludePaths, forceScan, and 30s cache TTL
  const extra1 = bridge.discoverExtraWorkspaces({ excludePaths: [extraProjGit] });
  assert.deepEqual(extra1.map(w => w.path).sort(), [extraProjPkg, extraProjPy].sort());
  assert.ok(extra1.every(w => w.kind === 'extra'));

  const extraProjLate = join(extraRoot, 'proj-late');
  await mkdir(extraProjLate, { recursive: true });
  await writeFile(join(extraProjLate, 'Cargo.toml'), '[package]\nname="late"\n', 'utf8');

  // Within 30s TTL without forceScan: returns cached result (no extraProjLate)
  const extraCached = bridge.discoverExtraWorkspaces({ excludePaths: [extraProjGit] });
  assert.equal(extraCached.some(w => w.path === extraProjLate), false);

  // forceScan bypasses 30s cache
  const extraForced = bridge.discoverExtraWorkspaces({ excludePaths: [extraProjGit], forceScan: true });
  assert.equal(extraForced.some(w => w.path === extraProjLate), true);

  // After 30s TTL expires, next call rescans automatically
  const extraProjTtl = join(extraRoot, 'proj-ttl');
  await mkdir(join(extraProjTtl, '.git'), { recursive: true });
  bridge._extraCache.ts -= 31_000;
  const extraAfterTtl = bridge.discoverExtraWorkspaces({ excludePaths: [extraProjGit] });
  assert.equal(extraAfterTtl.some(w => w.path === extraProjTtl), true);
});

test('MobileBridgeServer GET /api/mobile/state?extra=1 按 targetAgent 返回工作区与 extraWorkspaces', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-mobile-state-'));
  const dir = await realpath(rawDir);
  t.after(() => rm(rawDir, { recursive: true, force: true }));

  const defaultDir = join(dir, 'default-cwd');
  const appSupportDir = join(dir, 'AppSupport');
  const cursorGlobal = join(appSupportDir, 'Cursor', 'User', 'globalStorage');
  const cursorOpen = join(dir, 'cursor-active-repo');
  const opencodeDbPath = join(dir, 'opencode.db');
  const ocProj = join(dir, 'oc-mobile-proj');
  const extraRoot = join(dir, 'scan-root');
  const extraRepo = join(extraRoot, 'discovered-repo');

  for (const d of [defaultDir, cursorGlobal, cursorOpen, ocProj, join(extraRepo, '.git')]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(join(cursorGlobal, 'storage.json'), JSON.stringify({
    windowsState: { openedWindows: [{ folder: pathToFileURL(cursorOpen).href }] },
  }), 'utf8');
  execSqlite(
    opencodeDbPath,
    `CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, time_created INTEGER, time_updated INTEGER, time_active INTEGER);
     INSERT INTO project VALUES ('oc-1', ${sqlStr(ocProj)}, 100, 200, 300);
     CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER);
     INSERT INTO session_v2 VALUES ('oc-ses-1', ${sqlStr(ocProj)}, 'Mobile OC Session', 500);`,
  );

  const localChat = new LocalChatBridge({
    dispatcher: {
      defaultCwd: defaultDir,
      allowedWorkspaces: [dir],
      validateWorkspace: target => sanitizeWorkspace(target, [dir]),
      probeEngines: () => ({ claude: { available: true } }),
    },
    getConfig: () => ({ defaultEngine: 'claude', defaultCwd: defaultDir }),
    appSupportDir,
    opencodeDbPath,
    extraScanRoots: [extraRoot],
  });

  const mockBotService = {
    config: { defaultEngine: 'claude', defaultCwd: defaultDir, pairingCode: 'MB7890' },
    localChat,
    probeEngines: () => ({ claude: { available: true } }),
    listJobs: () => [],
  };
  const srv = new MobileBridgeServer({
    botService: mockBotService,
    providers: { snapshot: { items: [], sources: [{ id: 'dsh', connected: false }] } },
    host: '127.0.0.1',
    port: 0,
  });
  await srv.start();
  t.after(() => srv.stop());

  const baseUrl = `http://127.0.0.1:${srv.getStatus().port}`;
  const headers = { Authorization: 'Bearer MB7890' };

  const resCursorExtra = await fetch(`${baseUrl}/api/mobile/state?targetAgent=cursor&extra=1`, { headers });
  assert.equal(resCursorExtra.status, 200);
  const bodyCursor = await resCursorExtra.json();
  assert.equal(bodyCursor.ok, true);
  assert.deepEqual(bodyCursor.workspaces.map(w => w.path), [cursorOpen]);
  assert.equal(bodyCursor.workspaces[0].isOpen, true);
  assert.equal(bodyCursor.workspaces[0].sourceEngine, 'cursor');
  assert.deepEqual(bodyCursor.extraWorkspaces.map(w => w.path), [extraRepo]);
  assert.equal(bodyCursor.extraWorkspaces[0].kind, 'extra');

  const resOpencode = await fetch(`${baseUrl}/api/mobile/state?targetAgent=opencode`, { headers });
  assert.equal(resOpencode.status, 200);
  const bodyOc = await resOpencode.json();
  assert.deepEqual(bodyOc.workspaces.map(w => w.path), [ocProj]);
  assert.equal(bodyOc.workspaces[0].sourceEngine, 'opencode');
  assert.equal(bodyOc.sessions[0].sessionId, 'oc-ses-1');
  assert.equal(bodyOc.extraWorkspaces, undefined);

  // Verify BotService forwards providers to LocalChatBridge even with a custom dispatcher lacking .providers
  const dshWorkDir = join(dir, 'dsh-live-ws');
  await mkdir(dshWorkDir, { recursive: true });
  const customProviders = {
    snapshot: { items: [], sources: [{ id: 'dsh', connected: true }] },
    list: () => ({ items: [{ provider: 'dsh', cwd: dshWorkDir, status: 'running' }] }),
  };
  const svcWithCustomDispatcher = new BotService({
    rootDir: ROOT_DIR,
    dataDir: join(dir, 'svc-data'),
    providers: customProviders,
    dispatcher: {
      defaultCwd: defaultDir,
      allowedWorkspaces: [dir],
      validateWorkspace: target => sanitizeWorkspace(target, [dir]),
      probeEngines: () => ({ claude: { available: true } }),
      listJobs: () => [],
      stopJob: async () => ({ stopped: false }),
    },
  });
  assert.equal(svcWithCustomDispatcher.localChat.providers, customProviders);
  const dshWs = svcWithCustomDispatcher.localChat.discoverWorkspaces({ engine: 'dsh' });
  assert.ok(dshWs.some(w => w.path === dshWorkDir));
});

test('LocalChatBridge Antigravity 子 Agent 去重防淹没、config/projects + app_storage.json 与主对话优先召回', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-agy-'));
  const dir = await realpath(rawDir);
  t.after(() => rm(rawDir, { recursive: true, force: true }));

  const defaultDir = join(dir, 'default-cwd');
  const appSupportDir = join(dir, 'AppSupport');
  const agyAppSupportDir = join(appSupportDir, 'Antigravity');
  const agyConfigDir = join(dir, 'gemini-config');
  const agyProjectsDir = join(agyConfigDir, 'projects');
  const agyDbPath = join(dir, 'conversation_summaries.db');

  const projMainA = join(dir, 'agy-proj-a');
  const projMainB = join(dir, 'agy-proj-b');
  const projConfigLast = join(dir, 'agy-config-last');
  const projConfigOrd1 = join(dir, 'agy-config-ord1');
  const projConfigSidecar = join(dir, 'agy-config-sidecar');

  for (const d of [
    defaultDir, agyAppSupportDir, agyProjectsDir,
    projMainA, projMainB, projConfigLast, projConfigOrd1, projConfigSidecar,
  ]) {
    await mkdir(d, { recursive: true });
  }

  // >30 sub-agents on projMainA with parent_conversation_id & CASCADE_RUN_STATUS_RUNNING must not drown out projMainB
  const inserts = [];
  const uriA = sqlStr(JSON.stringify([pathToFileURL(projMainA).href]));
  const uriB = sqlStr(JSON.stringify([pathToFileURL(projMainB).href]));
  inserts.push(`INSERT INTO conversation_summaries VALUES ('main-b', 'Main Conversation B', ${uriB}, 2000, '', 'CASCADE_RUN_STATUS_IDLE', 0);`);
  inserts.push(`INSERT INTO conversation_summaries VALUES ('main-a', 'Main Conversation A', ${uriA}, 2500, '', 'CASCADE_RUN_STATUS_IDLE', 0);`);
  for (let i = 1; i <= 35; i++) {
    const status = i === 35 ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE';
    inserts.push(
      `INSERT INTO conversation_summaries VALUES ('sub-a-${i}', 'SubAgent ${i}', ${uriA}, ${3000 + i}, 'main-a', '${status}', 0);`,
    );
  }
  execSqlite(
    agyDbPath,
    `CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      workspace_uris TEXT,
      last_modified_time INTEGER,
      parent_conversation_id TEXT,
      status TEXT,
      not_fully_idle INTEGER
    );
    ${inserts.join('\n')}`,
  );

  // app_storage.json + ~/.gemini/config/projects/*.json
  await writeFile(join(agyAppSupportDir, 'app_storage.json'), JSON.stringify({
    lastCreatedProjectId: 'proj-last',
    projectsOrder: ['proj-ord-1', 'proj-last'],
  }), 'utf8');
  await writeFile(join(agyProjectsDir, 'outside-of-project.json'), JSON.stringify({
    id: 'outside-of-project',
    projectResources: { resources: [{ folderUri: pathToFileURL(projConfigSidecar).href }] },
  }), 'utf8');
  await writeFile(join(agyProjectsDir, 'sidecar.json'), JSON.stringify({
    id: 'sidecar-proj',
    sidecar: true,
    projectResources: { resources: [{ folderUri: pathToFileURL(projConfigSidecar).href }] },
  }), 'utf8');
  await writeFile(join(agyProjectsDir, 'proj-ord-1.json'), JSON.stringify({
    id: 'proj-ord-1',
    projectResources: { resources: [{ gitFolder: { folderUri: pathToFileURL(projConfigOrd1).href } }] },
  }), 'utf8');
  await writeFile(join(agyProjectsDir, 'proj-last.json'), JSON.stringify({
    id: 'proj-last',
    projectResources: { resources: [{ folderUri: pathToFileURL(projConfigLast).href }] },
  }), 'utf8');

  const bridge = new LocalChatBridge({
    dispatcher: {
      defaultCwd: defaultDir,
      allowedWorkspaces: [dir],
      validateWorkspace: target => sanitizeWorkspace(target, [dir]),
    },
    getConfig: () => ({ defaultEngine: 'claude', defaultCwd: defaultDir }),
    appSupportDir,
    antigravityDbPath: agyDbPath,
    antigravityConfigDir: agyConfigDir,
  });

  const agyWs = bridge.discoverWorkspaces({ engine: 'antigravity' });
  assert.deepEqual(
    agyWs.map(w => [w.path, w.isOpen]),
    [
      [projMainA, true],
      [projMainB, false],
      [projConfigLast, false],
      [projConfigOrd1, false],
    ],
  );
  assert.equal(agyWs.some(w => w.path === projConfigSidecar), false);

  // discoverSessions filters out parent_conversation_id sub-agents and ranks matched cwd main conversation first
  const agySessions = bridge.discoverSessions({ engine: 'antigravity', cwd: projMainB });
  assert.deepEqual(agySessions.map(s => s.sessionId), ['main-b', 'main-a']);
  assert.equal(agySessions[0].matchesCwd, true);
  assert.equal(agySessions[1].matchesCwd, false);
});

test('LocalChatBridge WorkBuddy spaces 表、playground 过滤及 workbuddy-ai 从 sessions 召回项目', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-wb-'));
  const dir = await realpath(rawDir);
  t.after(() => rm(rawDir, { recursive: true, force: true }));

  const defaultDir = join(dir, 'default-cwd');
  const workbuddyDbPath = join(dir, 'workbuddy.db');
  const workbuddyAiDbPath = join(dir, 'workbuddy-ai.db');

  const wbSpaceProj = join(dir, 'wb-space-proj');
  const wbSessionProj = join(dir, 'wb-session-proj');
  const wbWorkspaceProj = join(dir, 'wb-workspace-proj');
  const wbPgDir = join(dir, 'WorkBuddy', '2026-11-17-00-53-57');
  const wbFlaggedPgDir = join(dir, 'wb-flagged-playground');

  const waiRealProj = join(dir, 'wai-real-proj');
  const waiPgDir = join(dir, 'WorkBuddy AI', '2026-10-09-15-20-16');
  const waiFlaggedPgDir = join(dir, 'wai-flagged-playground');

  for (const d of [
    defaultDir, wbSpaceProj, wbSessionProj, wbWorkspaceProj, wbPgDir, wbFlaggedPgDir,
    waiRealProj, waiPgDir, waiFlaggedPgDir,
  ]) {
    await mkdir(d, { recursive: true });
  }

  execSqlite(
    workbuddyDbPath,
    `CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      primary_folder_path TEXT,
      create_folder_path TEXT,
      status TEXT,
      deleted_at INTEGER,
      updated_at INTEGER
    );
    INSERT INTO spaces VALUES ('sp-1', NULL, ${sqlStr(wbSpaceProj)}, 'active', -1, 5000);
    INSERT INTO spaces VALUES ('sp-del', NULL, ${sqlStr(wbFlaggedPgDir)}, 'active', 99999, 9000);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT, last_opened_at INTEGER);
    INSERT INTO workspaces VALUES ('ws-real', ${sqlStr(wbWorkspaceProj)}, 2000);
    INSERT INTO workspaces VALUES ('ws-pg-re', ${sqlStr(wbPgDir)}, 8000);
    INSERT INTO workspaces VALUES ('ws-pg-flag', ${sqlStr(wbFlaggedPgDir)}, 9000);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      title TEXT,
      is_playground INTEGER,
      updated_at INTEGER,
      last_activity_at INTEGER,
      deleted_at INTEGER
    );
    INSERT INTO sessions VALUES ('wb-ses-pg', ${sqlStr(wbPgDir)}, 'Tarot Playground', 1, 9000, 9000, NULL);
    INSERT INTO sessions VALUES ('wb-ses-flag', ${sqlStr(wbFlaggedPgDir)}, 'Flagged Playground', 1, 8500, 8500, NULL);
    INSERT INTO sessions VALUES ('wb-ses-real', ${sqlStr(wbSessionProj)}, 'Real WB Session', 0, 3000, 4000, NULL);
    INSERT INTO sessions VALUES ('wb-ses-space', ${sqlStr(wbSpaceProj)}, 'Space Match Session', 0, 2000, 2500, NULL);`,
  );

  // workbuddy-ai: empty spaces & workspaces, real project recalled via sessions (is_playground=0)
  execSqlite(
    workbuddyAiDbPath,
    `CREATE TABLE spaces (id TEXT PRIMARY KEY, path TEXT, status TEXT, deleted_at INTEGER, updated_at INTEGER);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT, last_opened_at INTEGER);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      title TEXT,
      is_playground INTEGER,
      updated_at INTEGER,
      last_activity_at INTEGER,
      deleted_at INTEGER
    );
    INSERT INTO sessions VALUES ('wai-pg-1', ${sqlStr(waiPgDir)}, 'WAI Temp Playground', 1, 9500, 9500, NULL);
    INSERT INTO sessions VALUES ('wai-pg-2', ${sqlStr(waiFlaggedPgDir)}, 'WAI Flagged Playground', 1, 9200, 9200, NULL);
    INSERT INTO sessions VALUES ('wai-real-1', ${sqlStr(waiRealProj)}, 'WAI Real Session', 0, 4000, 4500, NULL);`,
  );

  const bridge = new LocalChatBridge({
    dispatcher: {
      defaultCwd: defaultDir,
      allowedWorkspaces: [dir],
      validateWorkspace: target => sanitizeWorkspace(target, [dir]),
    },
    getConfig: () => ({ defaultEngine: 'claude', defaultCwd: defaultDir }),
    workbuddyDbPath,
    workbuddyAiDbPath,
  });

  const wbWs = bridge.discoverWorkspaces({ engine: 'workbuddy' });
  assert.deepEqual(wbWs.map(w => w.path), [wbSpaceProj, wbSessionProj, wbWorkspaceProj]);
  assert.equal(wbWs.some(w => w.path === wbPgDir || w.path === wbFlaggedPgDir), false);

  const wbSessions = bridge.discoverSessions({ engine: 'workbuddy', cwd: wbSpaceProj });
  assert.equal(wbSessions[0].sessionId, 'wb-ses-space');
  assert.equal(wbSessions[0].matchesCwd, true);
  assert.equal(wbSessions[1].sessionId, 'wb-ses-real');
  assert.ok(wbSessions.findIndex(s => s.sessionId === 'wb-ses-real') < wbSessions.findIndex(s => s.sessionId === 'wb-ses-pg'));

  const waiWs = bridge.discoverWorkspaces({ engine: 'workbuddy-ai' });
  assert.deepEqual(waiWs.map(w => w.path), [waiRealProj]);
  assert.equal(waiWs[0].sourceEngine, 'workbuddy-ai');

  const waiSessions = bridge.discoverSessions({ engine: 'workbuddy-ai', cwd: waiRealProj });
  assert.equal(waiSessions[0].sessionId, 'wai-real-1');
  assert.equal(waiSessions[0].matchesCwd, true);
});

test('LocalChatBridge Codex global-state、Claude ~/.claude.json、Qoder CN、Kiro 与 workspaceStorage 发现及去杂', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-multi-agent-'));
  const dir = await realpath(rawDir);
  t.after(() => rm(rawDir, { recursive: true, force: true }));

  const defaultDir = join(dir, 'default-cwd');
  const appSupportDir = join(dir, 'AppSupport');
  const codexSessionsDir = join(dir, 'codex-sessions');
  const codexGlobalStatePath = join(dir, '.codex-global-state.json');
  const claudeProjectsDir = join(dir, 'claude-projects');
  const claudeJsonPath = join(dir, '.claude.json');
  const qoderCnProjectsDir = join(dir, 'qoder-cn-projects');
  const kiroDir = join(dir, 'kiro-home');

  const codexActive = join(dir, 'codex-active');
  const codexLocalProj = join(dir, 'codex-local-proj');
  const codexSavedRoot = join(dir, 'codex-saved-root');

  const claudeProjNew = join(dir, 'claude-proj-new');
  const claudeProjOld = join(dir, 'claude-proj-old');
  const claudeProbeFake = join(dir, 'CodexBar', 'ClaudeProbe');

  const qoderJsonlProj = join(dir, 'qoder-jsonl-proj');
  const qoderWsStorageNew = join(dir, 'qoder-ws-new');
  const qoderWsStorageOld = join(dir, 'qoder-ws-old');

  const kiroRootProj = join(dir, 'kiro-root-proj');
  const kiroWsStorageProj = join(dir, 'kiro-ws-storage');

  const traeCnProj = join(dir, 'trae-cn-real-proj');
  const traeSoloLiteRuntimeDir = join(appSupportDir, 'Trae CN', 'ProjectWorkspaces');
  const traeSoloLiteDefaultDir = join(appSupportDir, 'Trae CN', 'solo-lite-default-workspace');

  for (const d of [
    defaultDir, codexSessionsDir, claudeProjectsDir, qoderCnProjectsDir,
    join(kiroDir, 'workspace-roots'),
    codexActive, codexLocalProj, codexSavedRoot,
    claudeProjNew, claudeProjOld, claudeProbeFake,
    qoderJsonlProj, qoderWsStorageNew, qoderWsStorageOld,
    kiroRootProj, kiroWsStorageProj,
    traeCnProj, traeSoloLiteRuntimeDir, traeSoloLiteDefaultDir,
  ]) {
    await mkdir(d, { recursive: true });
  }

  // 1. Codex .codex-global-state.json
  await writeFile(codexGlobalStatePath, JSON.stringify({
    'active-workspace-roots': [codexActive],
    'local-projects': {
      p1: { path: codexLocalProj, updatedAt: 5000 },
    },
    'electron-saved-workspace-roots': [codexSavedRoot],
  }), 'utf8');

  // 2. Claude ~/.claude.json (with homeDir and CodexBar/ClaudeProbe that must be excluded)
  await writeFile(claudeJsonPath, JSON.stringify({
    projects: {
      [os.homedir()]: { lastSessionModified: 9999999 },
      [claudeProbeFake]: { lastSessionModified: 9999998 },
      '/Users/someone/Library/Application Support/CodexBar/ClaudeProbe': { lastSessionModified: 9999997 },
      [claudeProjOld]: { lastSessionModified: 1000 },
      [claudeProjNew]: { lastSessionModified: 5000 },
    },
  }), 'utf8');

  // 3. Qoder CN: ~/.qoder-cn/projects/*/*.jsonl + workspaceStorage/*/workspace.json
  const qoderProjSub = join(qoderCnProjectsDir, '-tmp-proj');
  await mkdir(qoderProjSub, { recursive: true });
  await writeFile(join(qoderProjSub, 'ses-1.jsonl'), [
    JSON.stringify({ type: 'workspace-directories', directories: [qoderJsonlProj] }),
    JSON.stringify({ type: 'user', text: 'hello' }),
  ].join('\n'), 'utf8');

  const qoderWsOldFile = join(appSupportDir, 'Qoder CN', 'User', 'workspaceStorage', 'ws-old', 'workspace.json');
  const qoderWsNewFile = join(appSupportDir, 'Qoder CN', 'User', 'workspaceStorage', 'ws-new', 'workspace.json');
  await mkdir(dirname(qoderWsOldFile), { recursive: true });
  await mkdir(dirname(qoderWsNewFile), { recursive: true });
  await writeFile(qoderWsOldFile, JSON.stringify({ folder: pathToFileURL(qoderWsStorageOld).href }), 'utf8');
  await writeFile(qoderWsNewFile, JSON.stringify({ folder: pathToFileURL(qoderWsStorageNew).href }), 'utf8');
  await utimes(qoderWsOldFile, new Date(1000), new Date(1000));
  await utimes(qoderWsNewFile, new Date(5000), new Date(5000));

  // 4. Kiro: ~/.kiro/workspace-roots + Kiro/User/workspaceStorage/*/workspace.json
  await writeFile(join(kiroDir, 'workspace-roots', 'roots.json'), JSON.stringify({ roots: [kiroRootProj] }), 'utf8');
  const kiroWsFile = join(appSupportDir, 'Kiro', 'User', 'workspaceStorage', 'k1', 'workspace.json');
  await mkdir(dirname(kiroWsFile), { recursive: true });
  await writeFile(kiroWsFile, JSON.stringify({ folder: pathToFileURL(kiroWsStorageProj).href }), 'utf8');

  // 5. Trae CN workspaceStorage: excludes solo-lite synthetic paths
  await writeFile(join(traeSoloLiteRuntimeDir, 'solo-lite-runtime.code-workspace'), '{}', 'utf8');
  await writeFile(join(traeSoloLiteDefaultDir, 'workspace.json'), '{}', 'utf8');
  const traeWsSolo1 = join(appSupportDir, 'Trae CN', 'User', 'workspaceStorage', 'solo1', 'workspace.json');
  const traeWsSolo2 = join(appSupportDir, 'Trae CN', 'User', 'workspaceStorage', 'solo2', 'workspace.json');
  const traeWsReal = join(appSupportDir, 'Trae CN', 'User', 'workspaceStorage', 'real1', 'workspace.json');
  await mkdir(dirname(traeWsSolo1), { recursive: true });
  await mkdir(dirname(traeWsSolo2), { recursive: true });
  await mkdir(dirname(traeWsReal), { recursive: true });
  await writeFile(traeWsSolo1, JSON.stringify({ workspace: pathToFileURL(join(traeSoloLiteRuntimeDir, 'solo-lite-runtime.code-workspace')).href }), 'utf8');
  await writeFile(traeWsSolo2, JSON.stringify({ folder: pathToFileURL(traeSoloLiteDefaultDir).href }), 'utf8');
  await writeFile(traeWsReal, JSON.stringify({ folder: pathToFileURL(traeCnProj).href }), 'utf8');

  const homeReal = await realpath(os.homedir());
  const bridge = new LocalChatBridge({
    dispatcher: {
      defaultCwd: defaultDir,
      allowedWorkspaces: [dir, homeReal],
      validateWorkspace: target => sanitizeWorkspace(target, [dir, homeReal]),
    },
    getConfig: () => ({ defaultEngine: 'claude', defaultCwd: defaultDir }),
    appSupportDir,
    codexSessionsDir,
    codexGlobalStatePath,
    claudeProjectsDir,
    claudeJsonPath,
    qoderCnProjectsDir,
    kiroDir,
  });

  const codexWs = bridge.discoverWorkspaces({ engine: 'codex' });
  assert.deepEqual(
    codexWs.map(w => [w.path, w.isOpen]),
    [
      [codexActive, true],
      [codexLocalProj, false],
      [codexSavedRoot, false],
    ],
  );

  const claudeWs = bridge.discoverWorkspaces({ engine: 'claude' });
  assert.deepEqual(claudeWs.map(w => w.path), [claudeProjNew, claudeProjOld]);
  assert.equal(claudeWs.some(w => w.path === homeReal || w.path.includes('ClaudeProbe')), false);

  const qoderCnWs = bridge.discoverWorkspaces({ engine: 'qoder-cn' });
  assert.deepEqual(qoderCnWs.map(w => w.path), [qoderWsStorageNew, qoderWsStorageOld, qoderJsonlProj]);

  const kiroWs = bridge.discoverWorkspaces({ engine: 'kiro' });
  assert.deepEqual(kiroWs.map(w => w.path), [kiroWsStorageProj, kiroRootProj]);

  const traeCnWs = bridge.discoverWorkspaces({ engine: 'trae-cn' });
  assert.deepEqual(traeCnWs.map(w => w.path), [traeCnProj]);
});

test('LocalChatBridge 跨 Agent 工作区隔离、workspaces 返回 homeDir/suggestedCwd 与 files 指定 cwd', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-isolation-'));
  const dir = await realpath(rawDir);
  t.after(() => rm(rawDir, { recursive: true, force: true }));

  const defaultDir = join(dir, 'default-cwd');
  const appSupportDir = join(dir, 'AppSupport');
  const claudeJsonPath = join(dir, '.claude.json');
  const codexGlobalStatePath = join(dir, '.codex-global-state.json');

  const claudeOnlyProj = join(dir, 'claude-only-proj');
  const codexOnlyProj = join(dir, 'codex-only-proj');
  const cursorOnlyProj = join(dir, 'cursor-only-proj');

  for (const d of [
    defaultDir,
    join(appSupportDir, 'Cursor', 'User', 'globalStorage'),
    claudeOnlyProj,
    codexOnlyProj,
    cursorOnlyProj,
  ]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(join(claudeOnlyProj, 'claude-marker.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(codexOnlyProj, 'codex-marker.py'), 'print(1)\n', 'utf8');
  await writeFile(join(cursorOnlyProj, 'cursor-marker.rs'), 'fn main() {}\n', 'utf8');

  await writeFile(claudeJsonPath, JSON.stringify({
    projects: { [claudeOnlyProj]: { lastSessionModified: 5000 } },
  }), 'utf8');
  await writeFile(codexGlobalStatePath, JSON.stringify({
    'active-workspace-roots': [codexOnlyProj],
  }), 'utf8');
  await writeFile(join(appSupportDir, 'Cursor', 'User', 'globalStorage', 'storage.json'), JSON.stringify({
    windowsState: { openedWindows: [{ folder: pathToFileURL(cursorOnlyProj).href }] },
  }), 'utf8');

  const bridge = new LocalChatBridge({
    dispatcher: {
      defaultCwd: defaultDir,
      allowedWorkspaces: [dir],
      validateWorkspace: target => sanitizeWorkspace(target, [dir]),
    },
    getConfig: () => ({ defaultEngine: 'claude', defaultCwd: defaultDir }),
    appSupportDir,
    claudeJsonPath,
    codexGlobalStatePath,
  });

  // Select claudeOnlyProj via selectWorkspace; must NOT pollute codex or cursor workspaces
  const selRes = await bridge.handleAction({
    action: 'selectWorkspace',
    cwd: claudeOnlyProj,
    targetAgent: 'claude',
  }, 'auto');
  assert.equal(selRes.currentCwd, claudeOnlyProj);
  assert.deepEqual(selRes.workspaces.map(w => w.path), [claudeOnlyProj]);

  const codexActionWs = await bridge.handleAction({ action: 'workspaces', targetAgent: 'codex' }, 'auto');
  const homeReal = await realpath(os.homedir()).catch(() => os.homedir());
  assert.equal(codexActionWs.homeDir, homeReal);
  assert.equal(codexActionWs.suggestedCwd, codexOnlyProj);
  assert.equal(codexActionWs.currentCwd, claudeOnlyProj);
  assert.equal(codexActionWs.targetAgent, 'codex');
  assert.deepEqual(codexActionWs.workspaces.map(w => w.path), [codexOnlyProj]);
  assert.equal(codexActionWs.workspaces.some(w => w.path === claudeOnlyProj), false);

  const cursorActionWs = await bridge.handleAction({ action: 'workspaces', targetAgent: 'cursor' }, 'auto');
  assert.equal(cursorActionWs.homeDir, homeReal);
  assert.equal(cursorActionWs.suggestedCwd, cursorOnlyProj);
  assert.deepEqual(cursorActionWs.workspaces.map(w => w.path), [cursorOnlyProj]);
  assert.equal(cursorActionWs.workspaces.some(w => w.path === claudeOnlyProj), false);

  // handleAction('files', { cwd }) scans the explicitly passed cwd, not this.currentCwd()
  const filesCodex = await bridge.handleAction({ action: 'files', cwd: codexOnlyProj, query: 'marker' }, 'auto');
  assert.deepEqual(filesCodex.candidates.map(f => f.path), ['codex-marker.py']);

  const filesCursor = await bridge.handleAction({ action: 'files', cwd: cursorOnlyProj, query: 'marker' }, 'auto');
  assert.deepEqual(filesCursor.candidates.map(f => f.path), ['cursor-marker.rs']);

  const filesDefault = await bridge.handleAction({ action: 'files', query: 'marker' }, 'auto');
  assert.deepEqual(filesDefault.candidates.map(f => f.path), ['claude-marker.ts']);
});
