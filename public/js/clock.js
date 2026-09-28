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

// 「下一节」这一次点击会不会直接终局：非休息状态下跳到 endPeriod，
// 而末节（含加时）已分胜负时服务端会落 finished——比分当场锁定。
// 控制端据此弹二次确认（与「结束比赛」同一级别），休息中按下一节只是提前结束休息，无需问。
// 判定必须与服务端 applyAction 的真实结果一致，dev/parity.mjs 用落库结果反锁这份实现。
export function periodNextFinishes(s) {
  return s.status !== 'finished'
    && s.clock.mode !== 'break'
    && s.clock.period >= s.config.periods
    && s.teams[0].score !== s.teams[1].score;
}

// 大屏该渲染哪个画面。纯判定（不碰 DOM），display.js 只负责照着画——
// 房间不存在时不能停在「等待开赛」，那会让一个打错的房间码假装比赛还没开始。
// dev/display.mjs 逐场景钉这份判定。
export function displayPhase(store) {
  if (store.fatal) return 'error';
  if (!store.state) return store.loading ? 'loading' : 'reconnecting';
  if (store.status === 'setup') return 'setup';
  if (store.status === 'finished') return 'finished';
  return store.stale() ? 'stale' : 'live';
}

export function formatClock(ms, tenths = false) {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (!tenths) return base;
  return `${base}.${Math.floor((total % 1000) / 100)}`;
}
