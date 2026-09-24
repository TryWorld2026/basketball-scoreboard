// WebAudio 合成提示音 —— 不加载任何音频文件。

let ctx = null;
const audioCtx = () => {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
};

function tone({ freq, type = 'square', startAt, dur, gain = 0.18, sweepTo }) {
  const ac = audioCtx();
  const t0 = ac.currentTime + startAt;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2400;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweepTo) osc.frequency.linearRampToValueAtTime(sweepTo, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
  g.gain.setValueAtTime(gain, t0 + dur - 0.04);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  osc.connect(filter).connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// 解锁：浏览器要求用户手势后才能出声
export function primeAudio() {
  try { audioCtx(); } catch { /* 不支持则静默 */ }
}

export const sounds = {
  // 节末长鸣（真实记分牌蜂鸣器：粗糙的双方波）
  buzzer: () => { tone({ freq: 660, startAt: 0, dur: 0.9, gain: 0.22 }); tone({ freq: 330, type: 'sawtooth', startAt: 0, dur: 0.9, gain: 0.12 }); },
  // 进节双响
  period: () => { tone({ freq: 880, startAt: 0, dur: 0.12 }); tone({ freq: 880, startAt: 0.18, dur: 0.16 }); },
  // 暂停短促
  timeout: () => { tone({ freq: 520, startAt: 0, dur: 0.14, sweepTo: 390 }); },
  // 得分确认（轻）
  score: () => { tone({ freq: 1245, type: 'triangle', startAt: 0, dur: 0.06, gain: 0.08 }); },
};
