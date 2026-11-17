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
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const { AutoStartManager, LAUNCH_AGENT_LABEL } = require('../runtime/autostart.cjs');
const { buildJumpPlan, jumpToSession } = require('../runtime/session-jump.cjs');
const { applyEvent, sessionRows } = require('../runtime/hook-state.cjs');
const { CodexSessionReader } = require('../runtime/codex-sessions.cjs');
const { AntigravitySessionReader } = require('../runtime/antigravity-sessions.cjs');

function execSqlite(dbPath, sql) {
  const res = spawnSync('/usr/bin/sqlite3', [dbPath, sql], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
}

test('独立运行 WebM 动画资产、Manager & Pet UI DOM/CSP 契约及无 ~/.dsh 独立安装/启动检查', async t => {
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

  for (const [htmlRel, jsRel, minIds] of [
    ['runtime/manager.html', 'runtime/manager.js', 8],
    ['runtime/app.html', 'runtime/ui.js', 18],
  ]) {
    const html = await readFile(join(ROOT_DIR, htmlRel), 'utf8');
    const js = await readFile(join(ROOT_DIR, jsRel), 'utf8');
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /unsafe-inline/);
    assert.doesNotMatch(html, /\son\w+=/i);
    assert.doesNotMatch(html, /\sstyle=/i);

    const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
    const referencedIds = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))];
    assert.ok(referencedIds.length >= minIds, `expected >= ${minIds} DOM refs in ${jsRel}, got ${referencedIds.length}`);
    for (const id of referencedIds) {
      assert.ok(htmlIds.has(id), `${jsRel} references missing DOM id in ${htmlRel}: ${id}`);
    }
  }

  // scripts/install.py standalone dry check in isolated temp HOME without ~/.dsh
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

  // scripts/start.cjs exits cleanly when no Electron runtime is present
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

test('scripts/install.py builds self-contained branded .app when Electron.app bundle is provided', async t => {
  const { lstat, readlink } = await import('node:fs/promises');
  const tempRoot = await mkdtemp(join(tmpdir(), 'agent-pet-branded-app-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const fakeHome = join(tempRoot, 'home');
  const fakeData = join(tempRoot, 'pet-data');
  const srcBundle = join(tempRoot, 'FakeElectron.app');
  await mkdir(join(srcBundle, 'Contents/MacOS'), { recursive: true });
  await mkdir(join(srcBundle, 'Contents/Resources'), { recursive: true });
  await mkdir(join(srcBundle, 'Contents/Frameworks/Electron Helper.app/Contents/MacOS'), { recursive: true });
  await mkdir(join(srcBundle, 'Contents/Frameworks/Electron Framework.framework/Versions/A'), { recursive: true });
  await mkdir(fakeHome, { recursive: true });

  const srcExec = join(srcBundle, 'Contents/MacOS/Electron');
  await writeFile(srcExec, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(srcExec, 0o755);
  await writeFile(join(srcBundle, 'Contents/Resources/default_app.asar'), 'dummy', 'utf8');
  await writeFile(join(srcBundle, 'Contents/Resources/electron.icns'), 'dummy', 'utf8');
  const srcHelperExec = join(srcBundle, 'Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper');
  await writeFile(srcHelperExec, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(srcHelperExec, 0o755);
  await writeFile(join(srcBundle, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'), 'dummy', 'utf8');
  await symlink('A', join(srcBundle, 'Contents/Frameworks/Electron Framework.framework/Versions/Current'));

  const seedRes = spawnSync('python3', [
    '-c',
    `import plistlib, pathlib
b = pathlib.Path(${JSON.stringify(srcBundle)})
with (b / 'Contents/Info.plist').open('wb') as f:
    plistlib.dump({
        'CFBundleIdentifier': 'com.github.Electron',
        'CFBundleName': 'Electron',
        'CFBundleExecutable': 'Electron',
        'CFBundleIconFile': 'electron.icns',
        'ElectronAsarIntegrity': {'Resources/default_app.asar': {'algorithm': 'SHA256', 'hash': 'abc'}},
    }, f)
with (b / 'Contents/Frameworks/Electron Helper.app/Contents/Info.plist').open('wb') as f:
    plistlib.dump({
        'CFBundleIdentifier': 'com.github.Electron.helper',
        'CFBundleName': 'Electron Helper',
        'CFBundlePackageType': 'APPL',
        'LSUIElement': True,
    }, f)
`,
  ], { encoding: 'utf8' });
  assert.equal(seedRes.status, 0, seedRes.stderr);

  const installRes = spawnSync('python3', [join(ROOT_DIR, 'scripts/install.py')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOME: fakeHome,
      AGENT_PET_DATA: fakeData,
      AGENT_PET_ELECTRON: srcExec,
    },
    encoding: 'utf8',
  });
  assert.equal(installRes.status, 0, installRes.stderr);

  const installedApp = join(fakeHome, 'Applications/Agent Pet.app');
  const brandedExec = join(installedApp, 'Contents/MacOS/AgentPet');
  assert.equal(existsSync(brandedExec), true);
  assert.equal((await stat(brandedExec)).mode & 0o111, 0o111);
  assert.equal(existsSync(join(installedApp, 'Contents/MacOS/Electron')), false);
  assert.equal(existsSync(join(installedApp, 'Contents/Resources/default_app.asar')), false);
  assert.equal(existsSync(join(installedApp, 'Contents/Resources/electron.icns')), false);
  assert.equal(existsSync(join(installedApp, 'Contents/Resources/agent-pet.icns')), true);

  const appPkg = JSON.parse(await readFile(join(installedApp, 'Contents/Resources/app/package.json'), 'utf8'));
  assert.equal(appPkg.main, 'main.js');
  const appMain = await readFile(join(installedApp, 'Contents/Resources/app/main.js'), 'utf8');
  assert.match(appMain, /delete process\.env\.ELECTRON_RUN_AS_NODE;/);
  assert.ok(appMain.includes(join(ROOT_DIR, 'runtime/main.cjs')));

  assert.equal(existsSync(join(installedApp, 'Contents/Frameworks/Electron Helper.app')), false);
  assert.equal(existsSync(join(installedApp, 'Contents/Frameworks/Agent Pet Helper.app/Contents/MacOS/Agent Pet Helper')), true);
  const fwCurrent = join(installedApp, 'Contents/Frameworks/Electron Framework.framework/Versions/Current');
  assert.equal((await lstat(fwCurrent)).isSymbolicLink(), true);
  assert.equal(await readlink(fwCurrent), 'A');

  const inspectRes = spawnSync('python3', [
    '-c',
    `import json, plistlib, pathlib
app = pathlib.Path(${JSON.stringify(installedApp)})
src = pathlib.Path(${JSON.stringify(srcBundle)})
with (app / 'Contents/Info.plist').open('rb') as f: main_p = plistlib.load(f)
with (app / 'Contents/Frameworks/Agent Pet Helper.app/Contents/Info.plist').open('rb') as f: helper_p = plistlib.load(f)
with (src / 'Contents/Info.plist').open('rb') as f: src_p = plistlib.load(f)
print(json.dumps({'main': main_p, 'helper': helper_p, 'src': src_p}, default=str))
`,
  ], { encoding: 'utf8' });
  assert.equal(inspectRes.status, 0, inspectRes.stderr);
  const parsed = JSON.parse(inspectRes.stdout);
  assert.equal(parsed.main.CFBundleIdentifier, 'local.chenmingxin.agent-pet');
  assert.equal(parsed.main.CFBundleName, 'Agent Pet');
  assert.equal(parsed.main.CFBundleDisplayName, '小鑫');
  assert.equal(parsed.main.CFBundleExecutable, 'AgentPet');
  assert.equal(parsed.main.CFBundleIconFile, 'agent-pet.icns');
  assert.equal(parsed.main.LSUIElement, true);
  assert.equal('ElectronAsarIntegrity' in parsed.main, false);
  assert.equal(parsed.helper.CFBundleIdentifier, 'local.chenmingxin.agent-pet.helper');
  assert.equal(parsed.helper.CFBundleExecutable, 'Agent Pet Helper');
  assert.equal(parsed.src.CFBundleIdentifier, 'com.github.Electron');
  assert.equal(existsSync(srcExec), true);
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
  assert.deepEqual(mgr.resolveProgramArguments(), [process.execPath, join(fakeRoot, 'scripts', 'start.cjs')]);

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

  const bundledExec = join(fakeHome, 'Applications', 'Agent Pet.app', 'Contents', 'MacOS', 'AgentPet');
  await mkdir(dirname(bundledExec), { recursive: true });
  await writeFile(bundledExec, '#!/bin/sh\n', { mode: 0o755 });
  assert.deepEqual(mgr.resolveProgramArguments(), [bundledExec]);

  mgr.enable();
  const bundledXml = await readFile(mgr.plistPath(), 'utf8');
  assert.match(bundledXml, /home &amp; &apos;test&apos;\/Applications\/Agent Pet\.app\/Contents\/MacOS\/AgentPet/);

  const customMgr = new AutoStartManager({ homeDir: fakeHome, rootDir: fakeRoot, appExecPath: '/Custom/AgentPet' });
  assert.deepEqual(customMgr.resolveProgramArguments(), ['/Custom/AgentPet']);

  const disabledRes = mgr.setEnabled(false);
  assert.equal(disabledRes.enabled, false);
  assert.equal(mgr.isEnabled(), false);
  assert.equal(existsSync(mgr.plistPath()), false);
  assert.equal(mgr.disable(), false);
});

test('session-jump buildJumpPlan 与 jumpToSession 按应用类型精准路由并逐级回退', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-pet-jump-'));
  const workDir = join(dir, 'repo-a');
  await mkdir(workDir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 1. DSH
  assert.deepEqual(
    buildJumpPlan({ provider: 'dsh', sessionId: 'sess-123' }).steps,
    [{ kind: 'dsh', sessionId: 'sess-123' }],
  );

  // 2. WorkBuddy / WorkBuddy AI deep link + fallback to bundle + path
  const wbPlan = buildJumpPlan({ provider: 'workbuddy', sessionId: 'workbuddy:chat_42', workspacePath: workDir });
  assert.deepEqual(wbPlan.steps, [
    { kind: 'url', url: 'workbuddy://chat/chat_42' },
    { kind: 'bundle', bundleId: 'com.tencent.workbuddy.mac' },
    { kind: 'path', targetPath: workDir },
  ]);

  const seenCalls = [];
  const res1 = await jumpToSession(
    { provider: 'workbuddy-ai', sessionId: 'workbuddy-ai:wb-99', workspacePath: workDir },
    {
      openExternal: async url => { seenCalls.push(['url', url]); },
      openBundle: async (b, p) => { seenCalls.push(['bundle', b, p]); },
      openPath: async p => { seenCalls.push(['path', p]); },
    },
  );
  assert.deepEqual(res1, { opened: true, method: 'url', url: 'workbuddy-ai://chat/wb-99', provider: 'workbuddy-ai' });
  assert.deepEqual(seenCalls, [['url', 'workbuddy-ai://chat/wb-99']]);

  // Deep link failure falls back to bundle
  const res2 = await jumpToSession(
    { provider: 'workbuddy', sessionId: 'workbuddy:wb-1', workspacePath: workDir },
    {
      openExternal: async () => { throw new Error('no scheme'); },
      openBundle: async (b, p) => { seenCalls.push(['fallback-bundle', b, p]); },
      openPath: async p => { seenCalls.push(['fallback-path', p]); },
    },
  );
  assert.equal(res2.method, 'bundle');
  assert.deepEqual(seenCalls.slice(1), [['fallback-bundle', 'com.tencent.workbuddy.mac', undefined]]);

  // 3. IDE providers pass workspacePath directly as arg to open -b
  const curPlan = buildJumpPlan({ provider: 'antigravity', sessionId: 'antigravity:conv-1', workspacePath: workDir });
  assert.deepEqual(curPlan.steps, [
    { kind: 'bundle', bundleId: 'com.google.antigravity', targetPath: workDir },
    { kind: 'bundle', bundleId: 'com.google.antigravity' },
    { kind: 'path', targetPath: workDir },
  ]);

  const ideCalls = [];
  const res3 = await jumpToSession(
    { provider: 'cursor', sessionId: 'cursor:s1', workspacePath: workDir },
    {
      openBundle: async (bundleId, targetPath) => { ideCalls.push([bundleId, targetPath]); },
      openPath: async () => { throw new Error('should not hit path'); },
    },
  );
  assert.equal(res3.method, 'bundle+workspace');
  assert.deepEqual(ideCalls, [['com.todesktop.230313mzl4w4u92', workDir]]);

  // 4. Desktop chat apps (codex/claude) open bundle bare, then fallback to workspace path if bundle fails
  const codexPlan = buildJumpPlan({ provider: 'codex', sessionId: 'codex:t1', workspacePath: workDir });
  assert.deepEqual(codexPlan.steps, [
    { kind: 'bundle', bundleId: 'com.openai.codex' },
    { kind: 'path', targetPath: workDir },
  ]);

  const fallbackCalls = [];
  const res4 = await jumpToSession(
    { provider: 'claude', sessionId: 'claude:c1', workspacePath: workDir },
    {
      openBundle: async () => { throw new Error('app not installed'); },
      openPath: async p => { fallbackCalls.push(p); },
    },
  );
  assert.deepEqual(res4, { opened: true, method: 'path', targetPath: workDir, provider: 'claude' });
  assert.deepEqual(fallbackCalls, [workDir]);

  // 5. Non-existent workspacePath is filtered out & missing handlers throw descriptive error
  assert.deepEqual(buildJumpPlan({ provider: 'claude', sessionId: 'claude:c2', workspacePath: join(dir, 'missing') }).steps, [
    { kind: 'bundle', bundleId: 'com.anthropic.claudefordesktop' },
  ]);
  await assert.rejects(
    () => jumpToSession({ provider: 'claude', sessionId: 'claude:c2' }, {}),
    /无法打开/,
  );
});

test('hooks/emit.py、OpenCode 插件、Codex 与 Antigravity 读取器正确透传 sanitized workspacePath', async t => {
  const rawDir = await mkdtemp(join(tmpdir(), 'agent-pet-wspath-'));
  const dir = await realpath(rawDir);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const dataDir = join(dir, 'data');
  const workDir = join(dir, 'projects', 'demo repo');
  await mkdir(dataDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  // 1. connectors/hooks/emit.py -> hook-state.cjs sessionRows preserves workspacePath
  const emitRes = spawnSync(
    'python3',
    [join(ROOT_DIR, 'connectors/hooks/emit.py'), '--provider', 'claude', '--event', 'PreInvocation'],
    {
      env: { ...process.env, AGENT_PET_DATA: dataDir },
      input: JSON.stringify({
        session_id: 'claude-ws-1',
        workspace_roots: [workDir],
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(emitRes.status, 0, emitRes.stderr);
  const inboxFiles = await readdir(join(dataDir, 'claude/inbox'));
  assert.equal(inboxFiles.length, 1);
  const emitted = JSON.parse(await readFile(join(dataDir, 'claude/inbox', inboxFiles[0]), 'utf8'));
  assert.equal(emitted.workspace, 'demo repo');
  assert.equal(emitted.workspacePath, workDir);

  const store = {};
  assert.equal(applyEvent(store, emitted, 'claude'), true);
  const rows = sessionRows(store, 'claude');
  assert.equal(rows[0].workspacePath, workDir);

  // 2. connectors/opencode/agent-pet.js -> writes workspacePath into inbox
  const prevEnv = process.env.AGENT_PET_DATA;
  process.env.AGENT_PET_DATA = dataDir;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.AGENT_PET_DATA;
    else process.env.AGENT_PET_DATA = prevEnv;
  });
  const mod = await import(pathToFileURL(join(ROOT_DIR, 'connectors/opencode/agent-pet.js')).href);
  const plugin = await mod.AgentPetPlugin({ directory: workDir });
  await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'oc-1', status: { type: 'busy' } } } });
  const ocFiles = await readdir(join(dataDir, 'opencode/inbox'));
  assert.equal(ocFiles.length, 1);
  const ocEv = JSON.parse(await readFile(join(dataDir, 'opencode/inbox', ocFiles[0]), 'utf8'));
  assert.equal(ocEv.workspace, 'demo repo');
  assert.equal(ocEv.workspacePath, workDir);

  // 3. runtime/codex-sessions.cjs -> session_meta.cwd populates workspacePath
  const codexDir = join(dir, 'codex-sessions');
  const codexDayDir = join(codexDir, '2026/11/17');
  await mkdir(codexDayDir, { recursive: true });
  const nowIso = new Date().toISOString();
  await writeFile(
    join(codexDayDir, 'rollout-1.jsonl'),
    [
      JSON.stringify({ timestamp: nowIso, type: 'session_meta', payload: { id: 'codex-1', cwd: workDir } }),
      JSON.stringify({ timestamp: nowIso, type: 'event_msg', payload: { type: 'task_started' } }),
    ].join('\n') + '\n',
    'utf8',
  );
  const codexStore = {};
  const codexReader = new CodexSessionReader(codexDir);
  await codexReader.poll(codexStore);
  const codexRows = sessionRows(codexStore, 'codex');
  assert.equal(codexStore['codex-1'].workspace, 'demo repo');
  assert.match(codexRows[0].title, /demo repo/);
  assert.equal(codexRows[0].workspacePath, workDir);

  // 4. runtime/antigravity-sessions.cjs -> file URI percent-decoding populates workspacePath
  const dbPath = join(dir, 'antigravity.vscdb');
  const uri = pathToFileURL(workDir).href;
  execSqlite(dbPath, `
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
      ('ag-1', 'Jump Precision', '${JSON.stringify([uri]).replace(/'/g, "''")}', '${nowIso}', 'CASCADE_RUN_STATUS_RUNNING', '', 0, 0);
  `);
  const agStore = {};
  const agReader = new AntigravitySessionReader(dbPath);
  await agReader.poll(agStore);
  const agRows = sessionRows(agStore, 'antigravity');
  assert.equal(agStore['ag-1'].workspace, 'demo repo');
  assert.equal(agRows[0].workspacePath, workDir);
});
