'use strict';
const { spawn } = require('node:child_process');
const { homedir } = require('node:os');
const path = require('node:path');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(env.AGENT_PET_ELECTRON || path.join(homedir(), '.dsh/electron/Electron.app/Contents/MacOS/Electron'), [path.join(__dirname, '../runtime/main.cjs')], { env, detached: true, stdio: 'ignore' });
child.on('error', () => { console.error('无法启动，请检查本机 Electron 安装'); process.exitCode = 1; });
child.unref();
