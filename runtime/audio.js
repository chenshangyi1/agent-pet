/** The DSH recognizer contract is 16 kHz mono PCM16 WAV, at most 24 seconds. */
export function encodeWave(samples) {
  if (samples.length < 4800) throw new Error('录音太短，请至少说一句话');
  if (samples.length > 384000) throw new Error('录音最长 24 秒');
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const text = (at, value) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let peak = 0;
  samples.forEach((sample, i) => {
    if (!Number.isFinite(sample)) throw new Error('录音数据无效');
    peak = Math.max(peak, Math.abs(sample));
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  });
  if (peak < 0.002) throw new Error('没有录到声音，请检查麦克风');
  return new Uint8Array(buffer);
}

export async function recordingToWave(blob) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const count = Math.min(384000, Math.ceil(decoded.duration * 16000));
    const offline = new OfflineAudioContext(1, count, 16000);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    const rendered = await offline.startRendering();
    const bytes = encodeWave(rendered.getChannelData(0));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  } finally { await context.close(); }
}
