'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LAUNCH_AGENT_LABEL = 'local.chenmingxin.agent-pet';

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildPlistXml({ label, programArguments }) {
  const argsXml = programArguments
    .map(arg => `      <string>${escapeXml(arg)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '  <dict>',
    '    <key>Label</key>',
    `    <string>${escapeXml(label)}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    argsXml,
    '    </array>',
    '    <key>RunAtLoad</key>',
    '    <true/>',
    '    <key>KeepAlive</key>',
    '    <false/>',
    '    <key>ProcessType</key>',
    '    <string>Interactive</string>',
    '  </dict>',
    '</plist>',
    '',
  ].join('\n');
}

class AutoStartManager {
  constructor({ homeDir = os.homedir(), rootDir = path.resolve(__dirname, '..'), appExecPath } = {}) {
    this.homeDir = homeDir;
    this.rootDir = rootDir;
    this.appExecPath = appExecPath;
  }

  plistPath() {
    return path.join(this.homeDir, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
  }

  resolveProgramArguments() {
    if (this.appExecPath) {
      return [this.appExecPath];
    }
    const bundledExec = path.join(this.homeDir, 'Applications', 'Agent Pet.app', 'Contents', 'MacOS', 'AgentPet');
    if (fs.existsSync(bundledExec)) {
      return [bundledExec];
    }
    return [process.execPath, path.join(this.rootDir, 'scripts', 'start.cjs')];
  }

  isEnabled() {
    return fs.existsSync(this.plistPath());
  }

  #isRealUserHome() {
    return process.platform === 'darwin' && path.resolve(this.homeDir) === path.resolve(os.homedir());
  }

  #runLaunchctl(args) {
    try {
      execFileSync('launchctl', args, { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  enable() {
    const target = this.plistPath();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    const xml = buildPlistXml({
      label: LAUNCH_AGENT_LABEL,
      programArguments: this.resolveProgramArguments(),
    });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, xml, { encoding: 'utf8', mode: 0o644 });
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, target);

    if (this.#isRealUserHome()) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : '';
      const bootstrapped = uid !== '' && this.#runLaunchctl(['bootstrap', `gui/${uid}`, target]);
      if (!bootstrapped) {
        this.#runLaunchctl(['load', '-w', target]);
      }
    }
    return this.isEnabled();
  }

  disable() {
    const target = this.plistPath();
    if (this.#isRealUserHome() && fs.existsSync(target)) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : '';
      const bootedOut = uid !== '' && this.#runLaunchctl(['bootout', `gui/${uid}`, target]);
      if (!bootedOut) {
        this.#runLaunchctl(['unload', '-w', target]);
      }
    }
    fs.rmSync(target, { force: true });
    return false;
  }

  setEnabled(flag) {
    if (flag) {
      this.enable();
    } else {
      this.disable();
    }
    return {
      enabled: this.isEnabled(),
      plistPath: this.plistPath(),
    };
  }
}

module.exports = { AutoStartManager, LAUNCH_AGENT_LABEL, buildPlistXml };
