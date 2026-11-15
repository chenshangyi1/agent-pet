import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionView, sortSessions } from '../src/session-view.js';
const events = rows => rows.map(([type, data], seq) => ({ type, data, seq }));
const end = kind => ['turn/end', { reason: { kind } }];
test('权限确认优先于进行中，已决定后恢复工具状态', () => {
  const rows = [['turn/start', {}], ['tool/call', {callId:'tool1',name:'shell'}], ['approval/asked',{id:'approval1'}]];
  assert.equal(sessionView(events(rows), {running:true}).status, 'waiting');
  const resumed = sessionView(events([...rows,['approval/decided',{id:'approval1'}]]), {running:true});
  assert.equal(resumed.status, 'running'); assert.equal(resumed.detail,'正在运行命令');
  assert.equal(sessionView(events([...rows,end('aborted')])).status,'cancelled');
});
test('已完成未读、错误、输出限制与中止均由真实结束原因决定', () => {
  assert.equal(sessionView(events([end('completed')])).unread,true);
  assert.equal(sessionView(events([end('completed')]), {seen:0}).unread,false);
  for (const kind of ['error','blocked','max-tokens','interrupted']) assert.equal(sessionView(events([end(kind)])).status,'blocked');
  assert.equal(sessionView(events([end('completed'), ['turn/start',{}]]),{running:true}).status,'running');
});
test('提问等待结束后清除，工具输出不伪装成助手发言', () => {
  const rows = [['user/message',{source:{kind:'user'},content:[{type:'text',text:'你好'},{type:'image'}]}], ['tool/call',{callId:'q',name:'ask_user_question'}]];
  assert.equal(sessionView(events(rows)).status,'waiting');
  const view = sessionView(events([...rows,['tool/result',{callId:'q',content:[{type:'text',text:'工具秘密'}]}],['assistant/message',{message:{content:[{type:'text',text:'收到'}]}}],end('completed')]));
  assert.equal(view.status,'ready');
  assert.equal(view.detail,'已调用 ask_user_question');
  assert.deepEqual(view.messages.map(m=>m.text),['你好','收到']);
  assert.equal(view.messages[0].attachments,1);
  assert.equal(sessionView([], {projections:{userQuestions:{active:[{}]}}}).status,'waiting');
});
test('进度只取当前回合的真实待办，完成后清除', () => {
  const todo = ['turn/start', {}];
  const write = ['todo/write', { todos: [
    { content: '检查入口', status: 'completed' },
    { content: '修复交互', status: 'in_progress' },
    { content: '运行验证', status: 'pending' },
  ] }];
  const working = sessionView(events([todo, write, ['tool/call', { callId: 't', name: 'shell' }]]), { running: true });
  assert.deepEqual(working.progress, { completed: 1, total: 3 });
  assert.equal(working.detail, '修复交互');
  const waiting = sessionView(events([todo, write, ['approval/asked', { id: 'a' }]]), { running: true });
  assert.deepEqual(waiting.progress, { completed: 1, total: 3 });
  assert.equal(sessionView(events([todo, write, end('completed')])).progress, undefined);
  assert.equal(sessionView(events([todo, write, ['turn/start', {}]]), { running: true }).progress, undefined);
});
test('快捷聊天不展示 DSH 注入的上下文和技能目录', () => {
  const view = sessionView(events([
    ['user/message',{source:{kind:'user'},content:[{type:'text',text:'测试消息'}]}],
    ['user/message',{source:{kind:'runtime-context'},content:[{type:'text',text:'内部运行上下文'}]}],
    ['user/message',{source:{kind:'plugin',plugin:'skills'},content:[{type:'text',text:'内部技能目录'}]}],
    ['assistant/message',{message:{content:[{type:'text',text:'已连接'}]}}],
  ]));
  assert.deepEqual(view.messages.map(m=>m.text),['测试消息','已连接']);
});
test('工具副标题按 Codex 的分类区分编辑、命令、搜索与通用调用', () => {
  const run = name => sessionView(events([['turn/start', {}], ['tool/call', { callId: 't', name }]]), { running: true });
  assert.equal(run('apply_patch').detail, '正在编辑文件');
  assert.equal(run('shell').detail, '正在运行命令');
  assert.equal(run('web_search').detail, '正在搜索网页');
  assert.equal(run('custom_tool').detail, '正在调用 custom_tool');
  assert.equal(sessionView(events([['turn/start', {}], ['tool/call', { callId: 't', name: 'apply_patch' }], end('completed')])).detail, '已编辑文件');
});
test('待审批卡片带上真实工具名与原因，并给出状态标签', () => {
  const view = sessionView(events([['turn/start', {}],
    ['approval/asked', { id: 'a1', toolName: 'shell', reason: '需要执行 rm -rf' }]]), { running: true });
  assert.equal(view.status, 'waiting');
  assert.equal(view.statusText, '需要输入');
  assert.equal(view.detail, '需要批准 shell');
  assert.deepEqual(view.pending, [{ id: 'a1', toolName: 'shell', reason: '需要执行 rm -rf' }]);
  const decided = sessionView(events([['turn/start', {}],
    ['approval/asked', { id: 'a1', toolName: 'shell' }], ['approval/decided', { id: 'a1', outcome: 'allowed-once' }]]), { running: true });
  assert.equal(decided.pending, undefined);
  assert.equal(decided.status, 'running');
});
test('需要确认和未读结果排在工作与已读历史前', () => {
  const input=[['idle',false],['running',false],['ready',false],['ready',true],['blocked',true],['waiting',false]].map(([status,unread],i)=>({status,unread,updatedAt:i}));
  assert.deepEqual(sortSessions(input).map(s=>[s.status,s.unread]),[['waiting',false],['blocked',true],['ready',true],['running',false],['ready',false],['idle',false]]);
});
