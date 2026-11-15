import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyEvent, sessionRows, ACTIVE_TTL } = require('../runtime/workbuddy-state.cjs');
const hookState = require('../runtime/hook-state.cjs');
const { Providers } = require('../runtime/providers.cjs');
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
