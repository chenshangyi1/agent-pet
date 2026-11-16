'use strict';
const { spawn } = require('node:child_process');
const { existsSync, statSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');

function isFile(filePath) {
  try {
    return Boolean(filePath) && existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findOnPath(bin, pathEnv) {
  for (const dir of String(pathEnv || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function resolveElectron(env) {
  const rootDir = path.resolve(__dirname, '..');
  const override = String(env.AGENT_PET_ELECTRON || '').trim();
  if (override) {
    if (isFile(override)) return override;
    if (!override.includes(path.sep)) {
      const hit = findOnPath(override, env.PATH);
      if (hit) return hit;
    }
  }
  const candidates = [
    path.join(rootDir, 'node_modules/.bin/electron'),
    path.join(rootDir, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    '/Applications/Electron.app/Contents/MacOS/Electron',
    findOnPath('electron', env.PATH),
    path.join(homedir(), '.dsh/electron/Electron.app/Contents/MacOS/Electron'),
  ];
  return candidates.find(isFile) || null;
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronPath = resolveElectron(env);
if (!electronPath) {
  console.error('无法找到 Electron 运行时，请设置 AGENT_PET_ELECTRON 或安装 Electron 后重试');
  process.exitCode = 1;
} else {
  const child = spawn(electronPath, [path.join(__dirname, '../runtime/main.cjs')], {
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {
    console.error('无法启动，请检查本机 Electron 安装');
    process.exitCode = 1;
  });
  child.unref();
}
