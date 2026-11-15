import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { encodeWave } from '../runtime/audio.js';
import { apply, authorized, Config } from '../src/index.js';

test('本机桥拒绝缺失、截短及错误凭据', () => {
  assert.equal(authorized('Bearer example','example'),true);
  for (const header of [undefined,'Bearer exampl','Bearer example1','Basic example']) assert.equal(authorized(header,'example'),false);
  assert.ok(Config['~standard'].validate({launchDesktop:'true'}).issues);
});
test('真实 HTTP 桥生命周期、会话重试、防串会话及网页请求验证', async t => {
  const dir=await mkdtemp(join(tmpdir(),'dsh-companion-test-'));
  const pet = createServer((req,res)=>{ res.statusCode=404; res.end(); });
  await new Promise(resolve=>pet.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${pet.address().port}`;
  const routes=new Map(), disposers=[], listeners=new Map(); let creates=0, prompted, selected, recognizer;
  const id='session-example';
  const ev=[{type:'user/message',seq:0,data:{source:{kind:'user'},content:[{type:'text',text:'测试'}]}},{type:'turn/end',seq:1,data:{reason:{kind:'completed'}}}];
  const runningId='session-running';
  const runningEvents=[{type:'turn/start',seq:0,data:{}},{type:'todo/write',seq:1,data:{todos:[
    {content:'已完成',status:'completed'},{content:'待进行',status:'pending'},
  ]}}];
  const sessionRows=[{sessionId:id,running:false,updatedAt:1,cwd:dir},{sessionId:runningId,running:true,updatedAt:2,cwd:dir},
    ...Array.from({length:105},(_,i)=>({sessionId:`session-history-${i}`,running:false,updatedAt:100-i,cwd:dir}))];
  const services={
    sessionSkillCatalog:{async list({sessionId}){assert.equal(sessionId,id);return {skills:[{name:'review',description:'审阅'}]};}},
    sessionFileReferences:{async list(agent,query){assert.equal(agent.id,id);assert.equal(query,'a');return [{path:'/tmp/a.ts',name:'a.ts'}];}},
    agents:{get:sessionId=>sessionId===id?{id:sessionId}:undefined},
  };
  const ctx={get:name=>name==='speechToText'?recognizer:services[name],logger:{info(){},warn(){},error(e){throw new Error(e);},debug(){}},
    on(name,fn){listeners.set(name,fn);}, effect(fn){disposers.push(fn());},
    connection:{authenticatedUrl:()=>origin+'/?token=not-a-real-token',authorizeIndex(_req,res){res.writeHead(302,{'set-cookie':'test=owner; HttpOnly'});},
      fetch:{register(route){routes.set(route.path,route);return()=>routes.delete(route.path);}}},
    webServer:{getOrigin:()=>origin,register(route){routes.set(route.path,route);return()=>routes.delete(route.path);}}, sessions:{get:sessionId=>({snapshotEvents:()=>sessionId===runningId?runningEvents:sessionId===id?ev:[]})},sessionProjections:{snapshot:()=>({values:{title:'测试任务'}})},
    sessionController:{
      async list(){return {items:sessionRows};},
      async create({sessionId,cwd}){creates++;assert.equal(cwd,join(dir,'workspace'));await pause(15);return {sessionId};},
      async inspect(){return {meta:{cwd:dir},events:ev};}, async projections(){return {values:{}};},
      async prompt(body){prompted=body;return {accepted:true};},async selectModel(body){selected=body;return {};},cancel(){return {};},
      async modelCatalog(){return {default:{provider:'p',model:'m'},groups:[{id:'p',name:'P',models:[{id:'m',name:'M'}]}],failures:[],routableProviders:['p']};}
    }};
  apply(ctx,{launchDesktop:false,dataDir:dir,quickChatCwd:join(dir,'workspace')});
  t.after(async()=>{for(const dispose of disposers.reverse()) await dispose?.(); await new Promise(resolve=>pet.close(resolve)); await rm(dir,{recursive:true,force:true});});
  let runtime;
  for(let i=0;i<50;i++){try{runtime=JSON.parse(await readFile(join(dir,'runtime.json'),'utf8'));break;}catch(e){if(e.code!=='ENOENT')throw e;await pause(10);}}
  assert.ok(runtime,'bridge starts');
  const bridge=`http://127.0.0.1:${runtime.port}/action`;
  assert.equal((await fetch(bridge,{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(bridge,{method:'POST',headers:{authorization:'Bearer wrong'},body:'{}'})).status,401);
  const route=routes.get('/api/companion/action');
  const call=(body,site=origin)=>route.fetch(new Request(origin+'/api/companion/action',{method:'POST',headers:{origin:site,'content-type':'application/json'},body:JSON.stringify(body)}));
  assert.equal((await call({action:'info'},'https://foreign.example')).status,403);
  const bodies=await Promise.all([call({action:'create',sessionId:id}),call({action:'create',sessionId:id})]);
  assert.equal(creates,1);for(const r of bodies)assert.equal((await r.json()).sessionId,id);
  const list=await (await call({action:'list'})).json();
  assert.equal(list.items.length,107);assert.equal(list.items.find(item=>item.sessionId===id).status,'ready');
  assert.equal(list.items.find(item=>item.sessionId===id).unread,true);
  assert.deepEqual(list.items.find(item=>item.sessionId===runningId).progress,{completed:1,total:2});
  const conversation=await (await call({action:'conversation',sessionId:id})).json();assert.equal(conversation.messages[0].text,'测试');
  assert.equal((await (await call({action:'list'})).json()).items[0].unread,false);
  assert.equal((await call({action:'prompt',sessionId:id,requestId:'one',content:[]})).status,400);
  assert.equal((await call({action:'prompt',sessionId:id,requestId:'one',content:[{type:'text',text:'你好'}]})).status,200);
  assert.equal(prompted.sessionId,id);assert.equal(prompted.mode,'queue');
  assert.equal((await call({action:'selectModel',sessionId:id,model:{sessionId:'session-attacker',provider:'p',model:'m'}})).status,200);assert.equal(selected.sessionId,id);
  assert.equal((await call({action:'selectModel',sessionId:id,model:null})).status,400);
  assert.equal((await call({action:'cancel',sessionId:id})).status,200);
  assert.equal((await (await call({action:'models'})).json()).groups[0].id,'p');
  assert.deepEqual(await (await call({action:'skills',sessionId:id})).json(),{skills:[{name:'review',description:'审阅'}]});
  assert.deepEqual(await (await call({action:'files',sessionId:id,query:'a'})).json(),{candidates:[{path:'/tmp/a.ts',name:'a.ts'}]});
  assert.equal((await call({action:'skills'})).status,400);
  assert.equal((await call({action:'files'})).status,400);
  const focus=await (await call({action:'focus',sessionId:id})).json();
  // The page-facing branch never receives the authenticated URL; it only learns
  // which session to reveal, because the index `303 ./` would drop a URL marker.
  assert.equal(focus.url,undefined);assert.equal(focus.sessionId,id);
  assert.equal((await (await call({action:'pending-focus'})).json()).sessionId,id);
  assert.deepEqual(await (await call({action:'pending-focus'})).json(),{});
  assert.equal((await (await call({action:'home'})).json()).url,origin);
  assert.equal((await (await call({action:'info'})).json()).speechAvailable,false);
  const audio=Buffer.from(encodeWave(new Float32Array(16000).fill(.2))).toString('base64');
  assert.equal((await call({action:'hear',audio})).status,400);
  recognizer={listProviders:()=>[{id:'test'}],resolve(input){assert.equal(input.audio.length,32044);assert.equal(input.language,'zh');return input;},async transcribe(){return {text:'语音测试'};}};
  assert.equal((await (await call({action:'hear',audio})).json()).text,'语音测试');
  assert.equal((await call({action:'hear',audio:Buffer.from('bad-data').toString('base64')})).status,400);
  assert.equal((await call(null)).status,400);
});
