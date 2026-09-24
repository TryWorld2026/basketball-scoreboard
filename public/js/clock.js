// 时钟推算 —— functions/shared/rules.mjs 中同名函数的镜像实现（改服务端要同步这里）。

export function deriveRemaining(c, nowMs) {
  if (!c.running || !c.since) return Math.max(0, c.remainingMs);
  return Math.max(0, c.remainingMs - (nowMs - Date.parse(c.since)));
}

export function deriveClock(state, nowMs) {
  const c = state.clock;
  const remainingMs = deriveRemaining(c, nowMs);
  return { mode: c.mode, period: c.period, running: c.running, remainingMs, zero: c.running && remainingMs <= 0 };
}

export function deriveShot(state, nowMs) {
  if (!state.config.shotClock) return null;
  const remainingMs = deriveRemaining(state.shot, nowMs);
  return { running: state.shot.running, remainingMs, zero: state.shot.running && remainingMs <= 0 };
}

export function formatClock(ms, tenths = false) {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (!tenths) return base;
  return `${base}.${Math.floor((total % 1000) / 100)}`;
}
