import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyEvent, sessionRows, ACTIVE_TTL } = require('../runtime/workbuddy-state.cjs');
const hookState = require('../runtime/hook-state.cjs');
const { Providers } = require('../runtime/providers.cjs');
const { CONNECTOR_CATALOG } = require('../connectors/catalog.cjs');
const { ConnectorRegistry } = require('../connectors/registry.cjs');
const { validateWaveBase64, sanitizeSpeechText } = require('../runtime/local-speech.cjs');
const event = (name, at, extra = {}) => ({ v:1, id:randomUUID(), provider:'workbuddy', sessionId:'one', event:name, at, ...extra });
const agyEvent = (name, at, extra = {}) => ({ v:1, id:randomUUID(), provider:'antigravity', sessionId:'conv-1', event:name, at, ...extra });

test('迟到 SessionStart、并发工具、失败恢复和其他会话不覆盖当前任务', () => {
  const store = Object.create(null); const now = Date.now() - 100;
  applyEvent(store, event('UserPromptSubmit', now));
  applyEvent(store, event('SessionStart', now+1));
  assert.equal(store.one.status, 'running');
  applyEvent(store, event('PreToolUse', now+2, {tool:'Bash',toolId:'a'}));
  applyEvent(store, event('PreToolUse', now+3, {tool:'Read',toolId:'b'}));
  applyEvent(store, event('PostToolUseFailure', now+4, {toolId:'a'}));
  assert.equal(store.one.status,'running'); assert.equal(Object.keys(store.one.tools).length,1);
  applyEvent(store, event('Notification', now+5, {sessionId:'two',notification:'permission_prompt'}));
  assert.equal(store.two.status,'waiting'); assert.equal(store.one.status,'running');
  applyEvent(store, event('Stop', now+6)); assert.equal(store.one.status,'ready');
  applyEvent(store, event('PreToolUse', now+2)); assert.equal(store.one.status,'ready');
  assert.equal(sessionRows(store,now+7).find(row=>row.sessionId==='workbuddy:two').capabilities.reply,false);
});
test('过期忙态明确标为未知，不伪装成已完成', () => {
  const store=Object.create(null), now=Date.now(); applyEvent(store,event('UserPromptSubmit',now));
  const rows=sessionRows(store,now+ACTIVE_TTL+1); assert.equal(rows[0].status,'unknown'); assert.equal(rows[0].unread,false);
});
test('超过冷却窗口的历史 StopFailure 不再长期作为未读失败告警挂起', async () => {
  const store = Object.create(null);
  const now = Date.now() - 1000;
  hookState.applyEvent(store, {
    v: 1,
    id: randomUUID(),
    provider: 'claude',
    sessionId: '8c778582-test',
    event: 'StopFailure',
    at: now,
    workspace: 'sub2api-main',
  }, 'claude');
  const fresh = hookState.sessionRows(store, 'claude', now + 60_000);
  assert.equal(fresh[0].status, 'blocked');
  assert.equal(fresh[0].unread, true);
  const aged = hookState.sessionRows(store, 'claude', now + hookState.BLOCKED_TTL + 1);
  assert.equal(aged[0].status, 'history');
  assert.equal(aged[0].unread, false);

  const uiCss = await readFile(new URL('../runtime/ui.css', import.meta.url), 'utf8');
  const uiJs = await readFile(new URL('../runtime/ui.js', import.meta.url), 'utf8');
  assert.equal(uiCss.includes('#pet.expanded.show #activity-list'), false);
  assert.ok(uiCss.includes('#pet:not(.activities-open) #activity-list'));
  assert.match(uiJs, /composeButton\.addEventListener\('click'[\s\S]*?pet\.classList\.remove\('show'\)/);
  assert.match(uiJs, /activitiesButton\.addEventListener\('click'[\s\S]*?setActivitiesOpen\(!currentlyShowing\)/);
  assert.match(uiJs, /const key = readyKey\(item\);\s*if \(dismissed\.has\(key\)\)/);
});
test('并发真实 hook 进程只保存必要元数据，独立运行时仍读取 WorkBuddy', async t => {
  const dir=await mkdtemp(join(tmpdir(),'agent-pet-events-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const execute = payload => new Promise((resolve,reject)=>{
    const child=spawn('python3',[new URL('../connectors/workbuddy/emit.py',import.meta.url).pathname],{env:{...process.env,AGENT_PET_DATA:dir},stdio:['pipe','pipe','pipe']});
    child.on('error',reject); child.on('exit',code=>code===0?resolve():reject(new Error('hook failed'))); child.stdin.end(JSON.stringify(payload));
  });
  await Promise.all(Array.from({length:12},(_,i)=>execute({hook_event_name:'UserPromptSubmit',session_id:`s${i}`,prompt:'PRIVATE PROMPT',tool_input:{secret:'NEVER STORE'}})));
  const inbox=join(dir,'workbuddy/inbox'), files=await readdir(inbox); assert.equal(files.length,12);
  for(const name of files) assert.ok(!(await readFile(join(inbox,name),'utf8')).includes('PRIVATE'));
  const providers=new Providers(dir); await providers.refresh();
  assert.equal(providers.snapshot.items.length,12); assert.equal(providers.snapshot.sources[0].connected,false);
  assert.equal((await readdir(inbox)).length,0);
  await new Providers(dir).refresh();
  assert.ok(!(await readFile(join(dir,'workbuddy/state.json'),'utf8')).includes('NEVER'));
  await execute({hook_event_name:'Stop',session_id:'s0'}); await providers.refresh();
  assert.equal(providers.snapshot.items.find(row=>row.sessionId==='workbuddy:s0').status,'ready');
});
test('DSH 重启换凭据后自动重连、各来源筛选隔离', async t => {
  const dir=await mkdtemp(join(tmpdir(),'agent-pet-reconnect-')); const servers=[];
  t.after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}await rm(dir,{recursive:true,force:true});});
  const start=async token=>{
    const server=createServer((req,res)=>{if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end('{}');return;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify({items:[{sessionId:'same',status:'running',updatedAt:1}]}));});
    servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));
    await writeFile(join(dir,'dsh-bridge.json'),JSON.stringify({endpoint:`http://127.0.0.1:${server.address().port}/action`,token}));return server;
  };
  const first=await start('first');const providers=new Providers(dir); await providers.refresh();assert.equal(providers.list('dsh').items.length,1);
  first.closeAllConnections();await new Promise(r=>first.close(r));servers.shift();await providers.refresh();assert.equal(providers.snapshot.sources[0].connected,false);
  await start('second');await providers.refresh();assert.equal(providers.snapshot.sources[0].connected,true);assert.equal(providers.list('workbuddy').items.length,0);
});

test('Antigravity 状态机、只读能力及失败/取消映射', () => {
  const store = Object.create(null);
  const now = Date.now() - 200;
  hookState.applyEvent(store, agyEvent('SessionStart', now, { workspace: 'pet' }), 'antigravity');
  assert.equal(store['conv-1'].status, 'idle');
  hookState.applyEvent(store, agyEvent('PreInvocation', now + 1), 'antigravity');
  assert.equal(store['conv-1'].status, 'running');
  hookState.applyEvent(store, agyEvent('PreToolUse', now + 2, { tool: 'ask_question', toolId: 'q1' }), 'antigravity');
  assert.equal(store['conv-1'].status, 'waiting');
  hookState.applyEvent(store, agyEvent('PostToolUse', now + 3, { tool: 'ask_question', toolId: 'q1' }), 'antigravity');
  assert.equal(store['conv-1'].status, 'running');
  hookState.applyEvent(store, agyEvent('PreToolUse', now + 4, { tool: 'run_command', toolId: 'c1' }), 'antigravity');
  hookState.applyEvent(store, agyEvent('PostToolUse', now + 5, { tool: 'run_command', toolId: 'c1', hasError: true }), 'antigravity');
  assert.equal(store['conv-1'].status, 'running');
  assert.match(store['conv-1'].detail, /遇到问题/);
  hookState.applyEvent(store, agyEvent('Stop', now + 6, { terminationReason: 'NO_TOOL_CALL' }), 'antigravity');
  assert.equal(store['conv-1'].status, 'ready');
  hookState.applyEvent(store, agyEvent('PreInvocation', now + 10, { sessionId: 'conv-err' }), 'antigravity');
  hookState.applyEvent(store, agyEvent('Stop', now + 11, { sessionId: 'conv-err', terminationReason: 'ERROR' }), 'antigravity');
  assert.equal(store['conv-err'].status, 'blocked');
  hookState.applyEvent(store, agyEvent('PreInvocation', now + 20, { sessionId: 'conv-cancel' }), 'antigravity');
  hookState.applyEvent(store, agyEvent('Stop', now + 21, { sessionId: 'conv-cancel', terminationReason: 'USER_CANCELED' }), 'antigravity');
  assert.equal(store['conv-cancel'].status, 'cancelled');
  const rows = hookState.sessionRows(store, 'antigravity', now + 30);
  const readyRow = rows.find(r => r.sessionId === 'antigravity:conv-1');
  assert.equal(readyRow.providerLabel, 'Antigravity');
  assert.equal(readyRow.title, 'pet · conv-1');
  assert.equal(readyRow.capabilities.reply, false);
  assert.equal(readyRow.capabilities.cancel, false);
});

test('Antigravity hook 仅保留元数据、始终输出 {} 退出码 0 且与 DSH/WorkBuddy 隔离', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pet-agy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const emitPath = new URL('../connectors/antigravity/emit.py', import.meta.url).pathname;
  const execute = raw => new Promise((resolve, reject) => {
    const child = spawn('python3', [emitPath], { env: { ...process.env, AGENT_PET_DATA: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(`hook exited ${code}`)));
    child.stdin.end(typeof raw === 'string' ? raw : JSON.stringify(raw));
  });

  // Malformed JSON and missing fields must still output {} and exit 0 so Antigravity never blocks.
  assert.equal(await execute('not-json'), '{}');
  assert.equal(await execute({ hookEventName: 'PostToolUse' }), '{}');

  const outputs = await Promise.all([
    execute({
      hookEventName: 'PreInvocation',
      conversationId: 'agy-1',
      cwd: '/tmp/my-project',
      lastUserInput: 'SECRET PROMPT SHOULD NEVER BE SAVED',
      transcriptPath: '/secret/transcript.jsonl',
    }),
    execute({
      hookEventName: 'PostToolUse',
      conversationId: 'agy-2',
      cwd: '/tmp/other',
      toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'SECRET_CMD_ARG' } },
    }),
  ]);
  for (const out of outputs) assert.equal(out, '{}');

  const inbox = join(dir, 'antigravity/inbox');
  const files = await readdir(inbox);
  assert.equal(files.length, 2);
  for (const name of files) {
    const content = await readFile(join(inbox, name), 'utf8');
    assert.ok(!content.includes('SECRET'));
    assert.ok(!content.includes('transcript'));
  }

  const providers = new Providers(dir);
  await providers.refresh();
  assert.equal(providers.list('antigravity').items.length, 2);
  assert.equal(providers.list('workbuddy').items.length, 0);
  assert.equal(providers.list('dsh').items.length, 0);
  assert.equal(providers.snapshot.sources.find(s => s.id === 'antigravity').connected, true);
  assert.equal((await readdir(inbox)).length, 0);
  const stateContent = await readFile(join(dir, 'antigravity/state.json'), 'utf8');
  assert.ok(!stateContent.includes('SECRET'));

  assert.equal(await execute({ hookEventName: 'Stop', conversationId: 'agy-1', terminationReason: 'NO_TOOL_CALL' }), '{}');
  await providers.refresh();
  assert.equal(providers.snapshot.items.find(row => row.sessionId === 'antigravity:agy-1').status, 'ready');
});

test('Codex 状态机、只读能力及中断映射', () => {
  const store = Object.create(null);
  const now = Date.now() - 200;
  const cdxEvent = (name, at, extra = {}) => ({ v: 1, id: randomUUID(), provider: 'codex', sessionId: 'thread-1', event: name, at, ...extra });
  hookState.applyEvent(store, cdxEvent('SessionStart', now, { workspace: 'pet' }), 'codex');
  assert.equal(store['thread-1'].status, 'idle');
  hookState.applyEvent(store, cdxEvent('UserPromptSubmit', now + 1), 'codex');
  assert.equal(store['thread-1'].status, 'running');
  hookState.applyEvent(store, cdxEvent('PostToolUse', now + 2, { tool: 'Bash', toolId: 'call-1' }), 'codex');
  assert.equal(store['thread-1'].status, 'running');
  hookState.applyEvent(store, cdxEvent('Stop', now + 3), 'codex');
  assert.equal(store['thread-1'].status, 'ready');
  hookState.applyEvent(store, cdxEvent('UserPromptSubmit', now + 10, { sessionId: 'thread-int' }), 'codex');
  hookState.applyEvent(store, cdxEvent('Stop', now + 11, { sessionId: 'thread-int', terminationReason: 'USER_CANCELED' }), 'codex');
  assert.equal(store['thread-int'].status, 'cancelled');
  const rows = hookState.sessionRows(store, 'codex', now + 20);
  const readyRow = rows.find(r => r.sessionId === 'codex:thread-1');
  assert.equal(readyRow.providerLabel, 'Codex');
  assert.equal(readyRow.title, 'pet · read-1');
  assert.equal(readyRow.capabilities.reply, false);
  assert.equal(readyRow.capabilities.cancel, false);
});

test('Codex hook 仅保留元数据、始终输出 {} 退出码 0 且与其他来源隔离', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pet-codex-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const emitPath = new URL('../connectors/codex/emit.py', import.meta.url).pathname;
  const execute = raw => new Promise((resolve, reject) => {
    const child = spawn('python3', [emitPath], { env: { ...process.env, AGENT_PET_DATA: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error(`hook exited ${code}`)));
    child.stdin.end(typeof raw === 'string' ? raw : JSON.stringify(raw));
  });

  assert.equal(await execute('not-json'), '{}');
  assert.equal(await execute({ hook_event_name: 'PostToolUse' }), '{}');

  const outputs = await Promise.all([
    execute({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'cdx-1',
      turn_id: 'turn-1',
      cwd: '/tmp/codex-proj',
      prompt: 'SECRET PROMPT NEVER SAVE',
      transcript_path: '/secret/rollout.jsonl',
    }),
    execute({
      hook_event_name: 'PostToolUse',
      session_id: 'cdx-2',
      cwd: '/tmp/other-proj',
      tool_name: 'Bash',
      tool_use_id: 'call-1',
      tool_input: { command: 'SECRET_ARG' },
      tool_response: { stdout: 'SECRET_OUT' },
    }),
  ]);
  for (const out of outputs) assert.equal(out, '{}');

  const inbox = join(dir, 'codex/inbox');
  const files = await readdir(inbox);
  assert.equal(files.length, 2);
  for (const name of files) {
    const content = await readFile(join(inbox, name), 'utf8');
    assert.ok(!content.includes('SECRET'));
    assert.ok(!content.includes('transcript'));
    assert.ok(!content.includes('rollout'));
  }

  const providers = new Providers(dir);
  await providers.refresh();
  assert.equal(providers.list('codex').items.length, 2);
  assert.equal(providers.list('antigravity').items.length, 0);
  assert.equal(providers.list('workbuddy').items.length, 0);
  assert.equal(providers.list('dsh').items.length, 0);
  assert.equal(providers.snapshot.sources.find(s => s.id === 'codex').connected, true);
  assert.equal((await readdir(inbox)).length, 0);
  const stateContent = await readFile(join(dir, 'codex/state.json'), 'utf8');
  assert.ok(!stateContent.includes('SECRET'));

  assert.equal(await execute({ hook_event_name: 'Stop', session_id: 'cdx-1', last_assistant_message: 'SECRET_REPLY' }), '{}');
  assert.equal(await execute({ hook_event_name: 'Interrupt', session_id: 'cdx-2' }), '{}');
  await providers.refresh();
  assert.equal(providers.snapshot.items.find(row => row.sessionId === 'codex:cdx-1').status, 'ready');
  assert.equal(providers.snapshot.items.find(row => row.sessionId === 'codex:cdx-2').status, 'cancelled');
  assert.ok(!(await readFile(join(dir, 'codex/state.json'), 'utf8')).includes('SECRET'));
});

test('Codex rollout 日志增量读取只保留状态元数据且实时反映运行/等待/完成/中断', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pet-codex-rollout-'));
  const sessionsDir = join(dir, 'sessions/2026/11/15');
  await mkdir(sessionsDir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now() - 5000;
  const iso = offset => new Date(now + offset).toISOString();
  const rollout = join(sessionsDir, 'rollout-2026-11-15T21-00-00-01a1df75-285e-7fe1-acdd-4b108a20e3cf.jsonl');
  const lines1 = [
    { timestamp: iso(0), type: 'session_meta', payload: { id: '01a1df75-285e-7fe1-acdd-4b108a20e3cf', cwd: '/Users/demo/聊天框' } },
    { timestamp: iso(10), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: iso(20), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SECRET_USER_PROMPT' }] } },
    { timestamp: iso(30), type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'c1', arguments: '{"secret":"SECRET_ARGS"}' } },
  ];
  await writeFile(rollout, lines1.map(x => JSON.stringify(x)).join('\n') + '\n');

  const providers = new Providers(join(dir, 'data'), {}, { codexSessionsDir: join(dir, 'sessions') });
  await providers.refresh();
  let row = providers.list('codex').items.find(r => r.sessionId === 'codex:01a1df75-285e-7fe1-acdd-4b108a20e3cf');
  assert.equal(row.status, 'waiting');
  assert.equal(row.title, '聊天框 · 20e3cf');

  const lines2 = [
    { timestamp: iso(40), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'SECRET_TOOL_OUTPUT' } },
  ];
  await writeFile(rollout, [...lines1, ...lines2].map(x => JSON.stringify(x)).join('\n') + '\n');
  await providers.refresh();
  row = providers.list('codex').items.find(r => r.sessionId === 'codex:01a1df75-285e-7fe1-acdd-4b108a20e3cf');
  assert.equal(row.status, 'running');

  const lines3 = [
    { timestamp: iso(50), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'SECRET_REPLY' } },
  ];
  await writeFile(rollout, [...lines1, ...lines2, ...lines3].map(x => JSON.stringify(x)).join('\n') + '\n');
  await providers.refresh();
  row = providers.list('codex').items.find(r => r.sessionId === 'codex:01a1df75-285e-7fe1-acdd-4b108a20e3cf');
  assert.equal(row.status, 'ready');

  const lines4 = [
    { timestamp: iso(60), type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } },
    { timestamp: iso(70), type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } },
  ];
  await writeFile(rollout, [...lines1, ...lines2, ...lines3, ...lines4].map(x => JSON.stringify(x)).join('\n') + '\n');
  await providers.refresh();
  row = providers.list('codex').items.find(r => r.sessionId === 'codex:01a1df75-285e-7fe1-acdd-4b108a20e3cf');
  assert.equal(row.status, 'cancelled');

  const stateContent = await readFile(join(dir, 'data/codex/state.json'), 'utf8');
  assert.ok(!stateContent.includes('SECRET'));
});

test('ConnectorRegistry 默认只启用 dsh 并能检测本机已安装 AI Agent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pet-reg-detect-'));
  const home = join(dir, 'home');
  const apps = join(dir, 'Applications');
  const data = join(dir, 'data');
  await mkdir(join(apps, 'Cursor.app'), { recursive: true });
  await mkdir(join(apps, 'OpenCode.app'), { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.kiro'), { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const reg = new ConnectorRegistry({
    rootDir: new URL('..', import.meta.url).pathname.replace(/\/$/, ''),
    homeDir: home,
    dataDir: data,
    appsDirs: [apps],
    pathDirs: [],
    pythonPath: 'python3',
  });

  assert.deepEqual(reg.enabledIds(), ['dsh']);
  const detected = reg.detectAll();
  assert.equal(detected.find(x => x.id === 'dsh').enabled, true);
  assert.equal(detected.find(x => x.id === 'cursor').installed, true);
  assert.equal(detected.find(x => x.id === 'cursor').enabled, false);
  assert.equal(detected.find(x => x.id === 'opencode').installed, true);
  assert.equal(detected.find(x => x.id === 'claude').installed, true);
  assert.equal(detected.find(x => x.id === 'kiro').installed, true);
  assert.equal(detected.find(x => x.id === 'trae').installed, false);
  assert.throws(() => reg.disable('dsh'), /不可关闭/);
});

test('ConnectorRegistry 接入与卸载会备份原配置、保留无关配置并幂等清理', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pet-reg-toggle-'));
  const home = join(dir, 'home');
  const data = join(dir, 'data');
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude/settings.json'), JSON.stringify({
    model: 'sonnet',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
    },
  }));
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(join(home, '.cursor/hooks.json'), JSON.stringify({
    version: 1,
    hooks: { stop: [{ command: 'echo user-stop' }] },
  }));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const reg = new ConnectorRegistry({
    rootDir: new URL('..', import.meta.url).pathname.replace(/\/$/, ''),
    homeDir: home,
    dataDir: data,
    appsDirs: [],
    pathDirs: [],
    pythonPath: 'python3',
  });

  for (const id of ['claude', 'cursor', 'opencode', 'kiro', 'trae', 'antigravity']) {
    reg.enable(id);
  }
  assert.deepEqual(reg.enabledIds(), ['dsh', 'claude', 'cursor', 'opencode', 'antigravity', 'kiro', 'trae']);

  // Repeated enable stays idempotent without duplicating hook entries.
  reg.enable('claude');
  const claudeCfg = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(claudeCfg.model, 'sonnet');
  assert.equal(claudeCfg.hooks.PreToolUse.length, 2);

  const cursorCfg = JSON.parse(await readFile(join(home, '.cursor/hooks.json'), 'utf8'));
  assert.equal(cursorCfg.hooks.stop.length, 2);

  // Backups exist before modification.
  const backups = await readdir(join(data, 'backups'));
  assert.ok(backups.some(name => name.startsWith('connector-enable-claude-')));

  // Disable restores clean user-only configs & deletes drop-in files.
  for (const id of ['claude', 'cursor', 'opencode', 'kiro', 'trae', 'antigravity']) {
    reg.disable(id);
  }
  assert.deepEqual(reg.enabledIds(), ['dsh']);

  const claudeAfter = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(claudeAfter.model, 'sonnet');
  assert.equal(claudeAfter.hooks.PreToolUse.length, 1);
  assert.equal(claudeAfter.hooks.PreToolUse[0].hooks[0].command, 'echo user-hook');
  assert.equal(claudeAfter.hooks.Stop, undefined);

  const cursorAfter = JSON.parse(await readFile(join(home, '.cursor/hooks.json'), 'utf8'));
  assert.equal(cursorAfter.hooks.stop.length, 1);
  assert.equal(cursorAfter.hooks.stop[0].command, 'echo user-stop');

  await assert.rejects(() => readFile(join(home, '.config/opencode/plugins/agent-pet.js')));
  await assert.rejects(() => readFile(join(home, '.kiro/hooks/agent-pet.json')));

  // Corrupt target JSON fails loudly instead of overwriting user file.
  await writeFile(join(home, '.claude/settings.json'), '{broken json');
  assert.throws(() => reg.enable('claude'));
});

test('统一 hooks/emit.py 兼容 Cursor/Kiro/Claude 格式且绝不记录提示词与工具参数', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pet-unified-emit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const emitPath = new URL('../connectors/hooks/emit.py', import.meta.url).pathname;

  const runEmit = (args, payload) => new Promise((resolve, reject) => {
    const child = spawn('python3', [emitPath, ...args], { env: { ...process.env, AGENT_PET_DATA: dir } });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`exit ${code}`)));
    child.stdin.end(JSON.stringify(payload));
  });

  assert.equal(await runEmit(['--provider', 'cursor', '--format', 'cursor'], {
    hook_event_name: 'beforeSubmitPrompt',
    conversation_id: 'cur-1',
    workspace_roots: ['/tmp/my-cursor-app'],
    prompt: 'SECRET_CURSOR_PROMPT',
  }), '{}');
  assert.equal(await runEmit(['--provider', 'cursor', '--format', 'cursor'], {
    hook_event_name: 'stop',
    conversation_id: 'cur-1',
    status: 'aborted',
    error_message: 'SECRET_ERR',
  }), '{}');
  assert.equal(await runEmit(['--provider', 'kiro', '--format', 'kiro', '--event', 'UserPromptSubmit'], {
    cwd: '/tmp/kiro-proj',
    prompt: 'SECRET_KIRO_PROMPT',
  }), '{}');
  assert.equal(await runEmit(['--provider', 'claude', '--format', 'standard'], {
    hook_event_name: 'PreToolUse',
    session_id: 'claude-1',
    tool_name: 'Bash',
    tool_input: { command: 'SECRET_CMD' },
    cwd: '/tmp/claude-proj',
  }), '{}');

  const providers = new Providers(dir);
  await providers.refresh();

  assert.equal(providers.list('cursor').items.find(r => r.sessionId === 'cursor:cur-1').status, 'cancelled');
  assert.equal(providers.list('kiro').items.find(r => r.provider === 'kiro').status, 'running');
  const claudeRow = providers.list('claude').items.find(r => r.sessionId === 'claude:claude-1');
  assert.equal(claudeRow.status, 'running');
  assert.match(claudeRow.detail, /Bash/);

  for (const id of ['cursor', 'kiro', 'claude']) {
    const raw = await readFile(join(dir, `${id}/state.json`), 'utf8');
    assert.ok(!raw.includes('SECRET'));
  }
});

test('Providers 按 enabledProviders 动态过滤并在运行时热切换无需重启', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pet-enabled-filter-'));
  const claudeInbox = join(dir, 'claude/inbox');
  await mkdir(claudeInbox, { recursive: true });
  await writeFile(join(claudeInbox, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'), JSON.stringify({
    v: 1, id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', provider: 'claude',
    sessionId: 'c1', event: 'UserPromptSubmit', at: Date.now(), workspace: 'demo',
  }));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const providers = new Providers(dir, {}, { enabledProviders: ['dsh'] });
  await providers.refresh();
  assert.deepEqual(providers.snapshot.sources.map(s => s.id), ['dsh']);
  assert.equal(providers.list('auto').items.length, 0);

  providers.setEnabledProviders(['dsh', 'claude']);
  await providers.refresh();
  assert.deepEqual(providers.snapshot.sources.map(s => s.id), ['dsh', 'claude']);
  assert.equal(providers.list('auto').items.length, 1);
  assert.equal(providers.list('auto').items[0].providerLabel, 'Claude Code');
});

test('LocalSpeech 校验 16kHz 单声道 WAV 与语音播报文本清洗', () => {
  assert.throws(() => validateWaveBase64('not-valid!'), /格式无效/);
  const buf = Buffer.alloc(44 + 320);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + 320, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(320, 40);
  assert.equal(validateWaveBase64(buf.toString('base64')).length, 44 + 320);

  const spoken = sanitizeSpeechText('请看 [文档](https://example.com) 中的 `foo()`：\n```js\nconst a = 1;\n```\n已**完成**！');
  assert.equal(spoken, '请看 文档 中的 foo()： 代码已略过 已 完成 ！');
});

test('ConnectorRegistry.enableAllInstalled 仅一键接入本机已安装的 AI Agent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pet-reg-enable-all-'));
  const home = join(dir, 'home');
  const apps = join(dir, 'Applications');
  const data = join(dir, 'data');
  await mkdir(join(apps, 'Cursor.app'), { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.kiro'), { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const reg = new ConnectorRegistry({
    rootDir: new URL('..', import.meta.url).pathname.replace(/\/$/, ''),
    homeDir: home,
    dataDir: data,
    appsDirs: [apps],
    pathDirs: [],
    pythonPath: 'python3',
  });

  assert.deepEqual(reg.enabledIds(), ['dsh']);
  const result = reg.enableAllInstalled();
  assert.deepEqual(reg.enabledIds(), ['dsh', 'claude', 'cursor', 'kiro']);
  assert.equal(result.find(x => x.id === 'claude').enabled, true);
  assert.equal(result.find(x => x.id === 'claude').hookConfigured, true);
  assert.equal(result.find(x => x.id === 'cursor').enabled, true);
  assert.equal(result.find(x => x.id === 'cursor').hookConfigured, true);
  assert.equal(result.find(x => x.id === 'kiro').enabled, true);
  assert.equal(result.find(x => x.id === 'kiro').hookConfigured, true);
  assert.equal(result.find(x => x.id === 'trae').enabled, false);

  const saved = JSON.parse(await readFile(join(data, 'connectors.json'), 'utf8'));
  assert.deepEqual(saved.enabled, ['dsh', 'claude', 'cursor', 'kiro']);
});

test('Providers.load 聚合 sources 的 sessionCount、sessionTitle 与 detail', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pet-sources-rich-'));
  const claudeInbox = join(dir, 'claude/inbox');
  const cursorInbox = join(dir, 'cursor/inbox');
  await mkdir(claudeInbox, { recursive: true });
  await mkdir(cursorInbox, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const now = Date.now();
  await writeFile(join(claudeInbox, '11111111111111111111111111111111.json'), JSON.stringify({
    v: 1,
    id: '11111111111111111111111111111111',
    provider: 'claude',
    sessionId: 'ses-1',
    event: 'PreToolUse',
    tool: 'Bash',
    toolId: 't1',
    at: now - 100,
    workspace: 'pet',
  }));
  await writeFile(join(claudeInbox, '22222222222222222222222222222222.json'), JSON.stringify({
    v: 1,
    id: '22222222222222222222222222222222',
    provider: 'claude',
    sessionId: 'ses-2',
    event: 'SessionEnd',
    at: now - 50,
    workspace: 'other',
  }));
  await writeFile(join(cursorInbox, '33333333333333333333333333333333.json'), JSON.stringify({
    v: 1,
    id: '33333333333333333333333333333333',
    provider: 'cursor',
    sessionId: 'cur-1',
    event: 'SessionEnd',
    at: now - 10,
    workspace: 'web',
  }));

  const providers = new Providers(dir, {}, { enabledProviders: ['dsh', 'claude', 'cursor', 'kiro'] });
  await providers.refresh();

  const claudeSource = providers.snapshot.sources.find(s => s.id === 'claude');
  assert.equal(claudeSource.status, 'running');
  assert.equal(claudeSource.sessionCount, 2);
  assert.equal(claudeSource.sessionTitle, 'pet · ses-1');
  assert.equal(claudeSource.detail, 'pet · ses-1 · 正在使用 Bash');
  assert.equal(claudeSource.activityCount, 1);

  const cursorSource = providers.snapshot.sources.find(s => s.id === 'cursor');
  assert.equal(cursorSource.connected, true);
  assert.equal(cursorSource.status, 'idle');
  assert.equal(cursorSource.sessionCount, 1);
  assert.equal(cursorSource.sessionTitle, '');
  assert.equal(cursorSource.detail, '空闲');

  const kiroSource = providers.snapshot.sources.find(s => s.id === 'kiro');
  assert.equal(kiroSource.connected, false);
  assert.equal(kiroSource.sessionCount, 0);
  assert.equal(kiroSource.sessionTitle, '');
  assert.equal(kiroSource.detail, '等待首个任务');
});

test('所有主流 AI Agent 连接器均有图标并支持独立安装与安全卸载', async t => {
  for (const entry of CONNECTOR_CATALOG) {
    const iconInfo = await stat(join(process.cwd(), 'assets/icons', `${entry.id}.png`));
    assert.ok(iconInfo.size > 100, `缺少图标 ${entry.id}.png`);
  }

  const root = await mkdtemp(join(tmpdir(), 'agent-pet-mainstream-'));
  const home = join(root, 'home');
  const data = join(root, 'data');
  await mkdir(join(home, '.gemini/antigravity'), { recursive: true });
  await mkdir(join(home, '.vscode/extensions/saoudrizwan.claude-dev-3.0.0'), { recursive: true });
  await mkdir(join(home, 'Documents/Cline/Rules/Hooks'), { recursive: true });
  await writeFile(join(home, 'Documents/Cline/Rules/Hooks/TaskStart'), '#!/bin/sh\necho custom-user-hook\n');
  t.after(() => rm(root, { recursive: true, force: true }));

  const reg = new ConnectorRegistry({
    rootDir: process.cwd(),
    homeDir: home,
    dataDir: data,
    appsDirs: [],
    pathDirs: [],
    pythonPath: 'python3',
  });

  const initial = reg.detectAll();
  // ~/.gemini/antigravity alone must not false-positive as Gemini CLI
  assert.equal(initial.find(x => x.id === 'antigravity').installed, true);
  assert.equal(initial.find(x => x.id === 'gemini-cli').installed, false);
  // Cline VS Code extension should be detected
  assert.equal(initial.find(x => x.id === 'cline').installed, true);

  for (const id of ['gemini-cli', 'windsurf', 'copilot', 'cline', 'zcode', 'codebuddy', 'codebuddy-cn', 'qwen-code', 'droid', 'qoder']) {
    reg.enable(id);
    assert.equal(reg.isHookConfigured(id), true, `${id} should be configured after enable`);
  }

  // Existing user Cline hook without agent-pet marker must never be overwritten
  const customTaskStart = await readFile(join(home, 'Documents/Cline/Rules/Hooks/TaskStart'), 'utf8');
  assert.match(customTaskStart, /custom-user-hook/);

  const windsurfHooks = JSON.parse(await readFile(join(home, '.codeium/windsurf/hooks.json'), 'utf8'));
  assert.ok(Array.isArray(windsurfHooks.hooks.pre_run_command));
  const copilotHooks = JSON.parse(await readFile(join(home, '.copilot/hooks/agent-pet.json'), 'utf8'));
  assert.equal(copilotHooks.version, 1);
  assert.ok(Array.isArray(copilotHooks.hooks.userPromptSubmitted));
  const zcodeCfg = JSON.parse(await readFile(join(home, '.zcode/cli/config.json'), 'utf8'));
  assert.equal(zcodeCfg.plugins.enabledPlugins['agent-pet@agent-pet-local'], true);

  for (const id of ['gemini-cli', 'windsurf', 'copilot', 'cline', 'zcode', 'codebuddy', 'codebuddy-cn', 'qwen-code', 'droid', 'qoder']) {
    reg.disable(id);
    assert.equal(reg.isHookConfigured(id), false, `${id} should be clean after disable`);
  }
  const preservedTaskStart = await readFile(join(home, 'Documents/Cline/Rules/Hooks/TaskStart'), 'utf8');
  assert.match(preservedTaskStart, /custom-user-hook/);
});

test('统一 hooks/emit.py 兼容 Windsurf/Gemini CLI/Copilot/Cline 事件格式', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pet-emit-mainstream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const emitPy = join(process.cwd(), 'connectors/hooks/emit.py');

  const cases = [
    {
      provider: 'windsurf',
      format: 'windsurf',
      payload: { agent_action_name: 'pre_run_command', trajectory_id: 'traj-1', execution_id: 'exec-1', tool_info: { file_path: '/tmp/myproj/a.js' } },
      expectedOut: '{}',
      expectedEvent: 'PreToolUse',
      expectedTool: 'run_command',
      expectedWorkspace: 'myproj',
    },
    {
      provider: 'gemini-cli',
      format: 'gemini',
      payload: { hookEventName: 'BeforeTool', session_id: 'gem-1', tool_name: 'write_file', cwd: '/tmp/app' },
      expectedOut: '{}',
      expectedEvent: 'PreToolUse',
      expectedTool: 'write_file',
    },
    {
      provider: 'copilot',
      format: 'copilot',
      payload: { hook_event_name: 'userPromptSubmitted', sessionId: 'cop-1', cwd: '/tmp/repo' },
      expectedOut: '{}',
      expectedEvent: 'UserPromptSubmit',
    },
    {
      provider: 'cline',
      format: 'cline',
      payload: { hookEventName: 'TaskCancel', taskId: 'task-1', cwd: '/tmp/clineproj' },
      expectedOut: '{"cancel":false}',
      expectedEvent: 'Stop',
      expectedReason: 'USER_CANCELED',
    },
  ];

  for (const tc of cases) {
    const res = spawnSync('python3', [emitPy, '--provider', tc.provider, '--format', tc.format], {
      input: JSON.stringify(tc.payload),
      env: { ...process.env, AGENT_PET_DATA: dir },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), tc.expectedOut);
    const files = await readdir(join(dir, tc.provider, 'inbox'));
    assert.equal(files.length, 1);
    const written = JSON.parse(await readFile(join(dir, tc.provider, 'inbox', files[0]), 'utf8'));
    assert.equal(written.event, tc.expectedEvent);
    if (tc.expectedTool) assert.equal(written.tool, tc.expectedTool);
    if (tc.expectedWorkspace) assert.equal(written.workspace, tc.expectedWorkspace);
    if (tc.expectedReason) assert.equal(written.terminationReason, tc.expectedReason);
  }
});

test('系统 /usr/bin/python3 (3.9) 兼容 emit.py / workspaceUris 解码及 Antigravity hooks.json', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-pet-py39-agy-'));
  const home = join(root, 'home');
  const data = join(root, 'data');
  await mkdir(home, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const reg = new ConnectorRegistry({
    rootDir: process.cwd(),
    homeDir: home,
    dataDir: data,
    appsDirs: [],
    pathDirs: [],
  });
  assert.ok(reg.resolvePython());
  reg.enable('antigravity');
  assert.equal(reg.isHookConfigured('antigravity'), true);

  const hooksJson = JSON.parse(await readFile(join(home, '.gemini/config/plugins/agent-pet/hooks.json'), 'utf8'));
  const observer = hooksJson['agent-pet-observer'];
  assert.equal(observer?.PreToolUse, undefined);
  assert.ok(Array.isArray(observer?.PreInvocation) && observer.PreInvocation[0].type === 'command');
  assert.ok(Array.isArray(observer?.PostToolUse) && observer.PostToolUse[0].matcher === '.*');
  assert.match(observer.PostToolUse[0].hooks[0].command, /connectors\/hooks\/emit\.py/);
  assert.ok(Array.isArray(observer?.StopFailure) && observer.StopFailure[0].type === 'command');
  assert.match(observer.StopFailure[0].command, /--provider antigravity --format antigravity/);

  reg.disable('antigravity');
  assert.equal(reg.isHookConfigured('antigravity'), false);

  if (!existsSync('/usr/bin/python3')) return;

  const hooksEmit = join(process.cwd(), 'connectors/hooks/emit.py');
  const agyEmit = join(process.cwd(), 'connectors/antigravity/emit.py');

  const cases = [
    {
      script: hooksEmit,
      args: ['--provider', 'antigravity', '--format', 'antigravity'],
      payload: {
        hookEventName: 'PreInvocation',
        conversationId: 'py39-conv-1',
        workspaceUris: ['file:///tmp/agy%20proj'],
        prompt: 'SECRET_PROMPT_NEVER_STORE',
      },
      expectedEvent: 'PreInvocation',
    },
    {
      script: agyEmit,
      args: [],
      payload: {
        hookEventName: 'PreToolUse',
        conversationId: 'py39-conv-2',
        workspaceUris: ['file:///tmp/agy%20proj'],
        toolCall: { id: 'tc-1', name: 'Bash', args: { command: 'SECRET_CMD' } },
      },
      expectedEvent: 'PreToolUse',
      expectedTool: 'Bash',
    },
  ];

  for (const tc of cases) {
    const res = spawnSync('/usr/bin/python3', [tc.script, ...tc.args], {
      input: JSON.stringify(tc.payload),
      env: { ...process.env, AGENT_PET_DATA: data },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '{}');
  }

  const badRes = spawnSync('/usr/bin/python3', [agyEmit], {
    input: '{invalid-json',
    env: { ...process.env, AGENT_PET_DATA: data },
    encoding: 'utf8',
  });
  assert.equal(badRes.status, 0);
  assert.equal(badRes.stdout.trim(), '{}');

  const inboxDir = join(data, 'antigravity/inbox');
  const inboxFiles = await readdir(inboxDir);
  assert.equal(inboxFiles.length, 2);
  const parsed = await Promise.all(inboxFiles.map(async name => {
    const text = await readFile(join(inboxDir, name), 'utf8');
    assert.ok(!text.includes('SECRET'));
    return JSON.parse(text);
  }));
  assert.ok(parsed.every(ev => ev.v === 1 && ev.provider === 'antigravity' && ev.workspace === 'agy proj'));
  const preTool = parsed.find(ev => ev.sessionId === 'py39-conv-2');
  assert.equal(preTool.event, 'PreToolUse');
  assert.equal(preTool.tool, 'Bash');
  assert.equal(preTool.toolId, 'tc-1');
});

test('AntigravitySessionReader 与 Providers 集成：冷启动过滤、hook 工具详情保护与状态收敛', async t => {
  if (!existsSync('/usr/bin/sqlite3')) t.skip('sqlite3 binary unavailable');

  const root = await mkdtemp(join(tmpdir(), 'agent-pet-agy-db-'));
  const dataDir = join(root, 'data');
  const dbPath = join(root, 'conversation_summaries.db');
  await mkdir(dataDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const execSql = sql => {
    const res = spawnSync('/usr/bin/sqlite3', [dbPath, sql], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || `sqlite3 exited ${res.status}`);
  };
  const fmtTs = ms => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00:00');
  const t0 = Date.now() - 20_000;

  execSql(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      workspace_uris TEXT NOT NULL DEFAULT '',
      last_modified_time TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      not_fully_idle INTEGER NOT NULL DEFAULT 0,
      killed INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO conversation_summaries VALUES
      ('conv-run', 'Fix Parser Bug', '["file:///tmp/agy%20app"]', '${fmtTs(t0)}', 'CASCADE_RUN_STATUS_RUNNING', '', 0, 0),
      ('conv-idle', 'Old Finished Task', '["file:///tmp/old-proj"]', '${fmtTs(t0 - 1000)}', 'CASCADE_RUN_STATUS_IDLE', '', 0, 0),
      ('conv-child', 'Child Subagent', '["file:///tmp/agy%20app"]', '${fmtTs(t0)}', 'CASCADE_RUN_STATUS_RUNNING', 'conv-run', 1, 0);
  `);

  const providers = new Providers(dataDir, {}, { antigravityDbPath: dbPath, enabledProviders: ['dsh', 'antigravity'] });
  await providers.refresh();

  let agyItems = providers.list('antigravity').items;
  assert.equal(agyItems.length, 1);
  assert.equal(agyItems[0].sessionId, 'antigravity:conv-run');
  assert.equal(agyItems[0].status, 'running');
  assert.equal(agyItems[0].title, 'agy app · Fix Parser Bug');
  assert.equal(agyItems[0].unread, false);

  // Inject real hook PreToolUse detail, then verify steady-state DB poll preserves it.
  const agyInbox = join(dataDir, 'antigravity/inbox');
  await mkdir(agyInbox, { recursive: true });
  await writeFile(join(agyInbox, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'), JSON.stringify({
    v: 1,
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    provider: 'antigravity',
    sessionId: 'conv-run',
    event: 'PreToolUse',
    tool: 'Bash',
    toolId: 't-bash-1',
    at: t0 + 1000,
    workspace: 'agy app',
  }));
  await providers.refresh();
  let runRow = providers.list('antigravity').items.find(r => r.sessionId === 'antigravity:conv-run');
  assert.equal(runRow.status, 'running');
  assert.equal(runRow.detail, '正在使用 Bash');

  execSql(`UPDATE conversation_summaries SET last_modified_time='${fmtTs(t0 + 2000)}' WHERE conversation_id='conv-run';`);
  await providers.refresh();
  runRow = providers.list('antigravity').items.find(r => r.sessionId === 'antigravity:conv-run');
  assert.equal(runRow.status, 'running');
  assert.equal(runRow.detail, '正在使用 Bash');
  assert.equal(runRow.title, 'agy app · Fix Parser Bug');

  // Transition IDLE -> RUNNING (via not_fully_idle = 1), RUNNING -> IDLE (killed=0 => ready), RUNNING -> IDLE (killed=1 => cancelled).
  execSql(`UPDATE conversation_summaries SET not_fully_idle=1, last_modified_time='${fmtTs(t0 + 3000)}' WHERE conversation_id='conv-idle';`);
  await providers.refresh();
  let idleRow = providers.list('antigravity').items.find(r => r.sessionId === 'antigravity:conv-idle');
  assert.equal(idleRow.status, 'running');
  assert.equal(idleRow.title, 'old-proj · Old Finished Task');

  execSql(`UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_IDLE', not_fully_idle=0, killed=0, last_modified_time='${fmtTs(t0 + 4000)}' WHERE conversation_id='conv-run';`);
  await providers.refresh();
  runRow = providers.list('antigravity').items.find(r => r.sessionId === 'antigravity:conv-run');
  assert.equal(runRow.status, 'ready');
  assert.equal(runRow.unread, true);

  execSql(`UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_IDLE', not_fully_idle=0, killed=1, last_modified_time='${fmtTs(t0 + 5000)}' WHERE conversation_id='conv-idle';`);
  await providers.refresh();
  idleRow = providers.list('antigravity').items.find(r => r.sessionId === 'antigravity:conv-idle');
  assert.equal(idleRow.status, 'cancelled');
  assert.equal(idleRow.unread, false);

  // Persisted stale running session converges to ready when DB is already IDLE, and isolated Providers omits reader by default.
  const dataDir2 = join(root, 'data2');
  await mkdir(join(dataDir2, 'antigravity'), { recursive: true });
  await writeFile(join(dataDir2, 'antigravity/state.json'), JSON.stringify({
    sessions: {
      'conv-stale': {
        sessionId: 'conv-stale',
        status: 'running',
        tools: {},
        lastSeq: 1,
        updatedAt: t0,
        eventId: 'agydb:conv-stale:1',
        detail: '正在思考',
      },
    },
  }));
  execSql(`INSERT INTO conversation_summaries VALUES ('conv-stale', 'Stale Task', '["file:///tmp/stale-ws"]', '${fmtTs(t0 + 6000)}', 'CASCADE_RUN_STATUS_IDLE', '', 0, 0);`);

  const isolated = new Providers(dataDir2, {}, { enabledProviders: ['dsh', 'antigravity'] });
  assert.equal(isolated.antigravityReader, null);

  const providers2 = new Providers(dataDir2, {}, { antigravityDbPath: dbPath, enabledProviders: ['dsh', 'antigravity'] });
  await providers2.refresh();
  const staleRow = providers2.list('antigravity').items.find(r => r.sessionId === 'antigravity:conv-stale');
  assert.equal(staleRow.status, 'ready');
  assert.equal(staleRow.title, 'stale-ws · Stale Task');

  const persisted = JSON.parse(await readFile(join(dataDir2, 'antigravity/state.json'), 'utf8'));
  assert.equal(persisted.sessions['conv-stale'].status, 'ready');
});
