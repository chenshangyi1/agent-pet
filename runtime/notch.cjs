'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

// AppKit owns the physical-notch window; Electron clamps windows below the menu bar.
function createNotch({ getState, command }) {
  let child, expanded = false, disposed = false, retryTimer, retries = 0;
  function write(value) {
    if (child?.stdin.writable) child.stdin.write(JSON.stringify(value) + '\n');
  }
  function send() { write({ type: 'state', state: getState() }); }
  function start() {
    let pending = '';
    child = spawn(path.join(__dirname, '../bin/notch-panel'), [], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'status') { expanded = Boolean(event.expanded); send(); }
        else if (event.type === 'action' && ['show', 'hide', 'source', 'open', 'manage', 'reset'].includes(event.action)) {
          Promise.resolve().then(() => command(event.action, event.value)).then(send)
            .catch(() => write({ type: 'error' }));
        }
      }
    });
    child.on('spawn', send);
    child.on('error', () => process.stderr.write('[companion] 原生刘海组件未启动，请运行 npm run build:notch\n'));
    child.on('exit', () => {
      expanded = false;
      if (!disposed && retries < 3) { retries++; retryTimer = setTimeout(start, 1000 * retries); }
    });
  }
  start();
  return { send, expand: value => write({ type: 'expand', value: Boolean(value) }), isExpanded: () => expanded,
    destroy() { disposed = true; clearTimeout(retryTimer); child?.stdin.end(); child?.kill('SIGTERM'); } };
}
module.exports = { createNotch };
