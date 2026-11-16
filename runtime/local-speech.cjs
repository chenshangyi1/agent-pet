'use strict';

const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function validateWaveBase64(audio) {
  if (typeof audio !== 'string' || audio.length > 1_050_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) {
    throw new Error('语音格式无效或录音过长');
  }
  const buf = Buffer.from(audio, 'base64');
  if (
    buf.length < 44 ||
    buf.length > 768_044 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE' ||
    buf.readUInt16LE(20) !== 1 ||
    buf.readUInt16LE(22) !== 1 ||
    buf.readUInt32LE(24) !== 16000 ||
    buf.readUInt16LE(34) !== 16 ||
    buf.toString('ascii', 36, 40) !== 'data' ||
    buf.readUInt32LE(40) !== buf.length - 44
  ) {
    throw new Error('语音需要 16kHz 单声道 WAV 格式，最长 24 秒');
  }
  return buf;
}

function sanitizeSpeechText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' 代码已略过 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#>|~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

class LocalSpeech {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.resolve(__dirname, '..');
    this.customHelper = Boolean(options.helperPath);
    this.helperPath = options.helperPath || path.join(this.rootDir, 'bin', 'speech-helper');
    this.appBundlePath = options.appBundlePath || path.join(this.rootDir, 'bin', 'AgentPetSpeech.app');
    this.sayPath = options.sayPath || '/usr/bin/say';
    this.activeSay = null;
  }

  hasRecognizer() {
    return process.platform === 'darwin' && (fs.existsSync(this.appBundlePath) || fs.existsSync(this.helperPath));
  }

  hasSpeaker() {
    return process.platform === 'darwin' && fs.existsSync(this.sayPath);
  }

  transcribeWave(audioBase64, locale = 'zh-CN') {
    const wav = validateWaveBase64(audioBase64);
    if (!this.hasRecognizer()) {
      return Promise.reject(new Error('本机语音识别组件尚未编译，请运行 npm run build:notch'));
    }
    const id = randomUUID();
    const tmpFile = path.join(os.tmpdir(), `agent-pet-speech-${id}.wav`);
    const outFile = path.join(os.tmpdir(), `agent-pet-speech-${id}.json`);
    fs.writeFileSync(tmpFile, wav, { mode: 0o600 });
    const useBundle = !this.customHelper && fs.existsSync(this.appBundlePath);
    const cmd = useBundle ? '/usr/bin/open' : this.helperPath;
    const args = useBundle
      ? ['-g', '-n', '-W', '-a', this.appBundlePath, '--args', tmpFile, locale, outFile]
      : [tmpFile, locale];
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 22_000 }, (error, stdout) => {
        let raw = '';
        if (useBundle && fs.existsSync(outFile)) {
          try { raw = fs.readFileSync(outFile, 'utf8'); } catch {}
        }
        try { fs.rmSync(tmpFile, { force: true }); } catch {}
        try { fs.rmSync(outFile, { force: true }); } catch {}
        let parsed = {};
        try { parsed = JSON.parse(String(raw || stdout || '').trim() || '{}'); } catch {}
        if (typeof parsed.text === 'string' && parsed.text.trim()) {
          resolve({ text: parsed.text.trim() });
          return;
        }
        reject(new Error(parsed.error || (error ? '系统语音识别失败，请检查系统语音识别权限后重试' : '没有识别到清晰语音，请重试')));
      });
    });
  }

  stopSpeaking() {
    if (this.activeSay && !this.activeSay.killed) {
      try { this.activeSay.kill('SIGTERM'); } catch {}
    }
    this.activeSay = null;
  }

  speak(text) {
    const clean = sanitizeSpeechText(text);
    if (!clean) return Promise.resolve({ spoken: false });
    if (!this.hasSpeaker()) return Promise.reject(new Error('当前系统不支持本地语音播报'));
    this.stopSpeaking();
    return new Promise((resolve, reject) => {
      const child = spawn(this.sayPath, ['-r', '200', clean], { stdio: 'ignore' });
      this.activeSay = child;
      let stopped = false;
      child.on('error', err => {
        if (this.activeSay === child) this.activeSay = null;
        reject(err);
      });
      child.on('close', (code, signal) => {
        if (this.activeSay === child) this.activeSay = null;
        if (signal === 'SIGTERM' || signal === 'SIGKILL') stopped = true;
        if (code === 0 || stopped) resolve({ spoken: !stopped, stopped });
        else reject(new Error('系统语音播报失败'));
      });
    });
  }
}

module.exports = { LocalSpeech, validateWaveBase64, sanitizeSpeechText };
