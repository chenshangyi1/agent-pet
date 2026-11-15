import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWave } from '../runtime/audio.js';

test('语音输出符合识别协议，裁剪音量并拒绝空白和过长录音', () => {
  const samples = new Float32Array(384000).fill(.2);
  samples[0] = -2; samples[1] = 2;
  const audio = Buffer.from(encodeWave(samples));
  assert.equal(audio.length, 768044);
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.readUInt32LE(4), audio.length - 8);
  assert.equal(audio.readUInt32LE(24), 16000);
  assert.equal(audio.readUInt16LE(22), 1);
  assert.equal(audio.readUInt16LE(34), 16);
  assert.equal(audio.readUInt32LE(40), audio.length - 44);
  assert.equal(audio.readInt16LE(44), -32768);
  assert.equal(audio.readInt16LE(46), 32767);
  for (const invalid of [new Float32Array(100), new Float32Array(384001), new Float32Array(16000), new Float32Array(16000).fill(NaN)])
    assert.throws(() => encodeWave(invalid));
});
