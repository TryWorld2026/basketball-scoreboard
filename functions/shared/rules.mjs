// 服务端规则引擎 —— 比分/时钟/犯规/节次的唯一事实来源。
// 纯函数，无 I/O：applyAction(state, action, nowIso) 返回新 state 或 {error}。

export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const MODES = ['game', 'timeout', 'break'];

export function newCode(rand = Math.random) {
  let out = '';
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return out;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const iso = (nowIso) => nowIso || new Date().toISOString();
const minutesMs = (m) => m * 60000;
// 严格整数：Number(null)===0、Number('2')===2 会把脏输入静默变成合法值
const strictInt = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : NaN);

// ---------- 校验 ----------

const HEX = /^#[0-9a-fA-F]{6}$/;
const clampInt = (v, min, max, dft) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dft;
};

export function sanitizeConfig(raw) {
  const c = raw || {};
  return {
    periods: [2, 4].includes(Number(c.periods)) ? Number(c.periods) : 4,
    periodMinutes: [5, 10, 12, 15].includes(Number(c.periodMinutes)) ? Number(c.periodMinutes) : 10,
    overtimeMinutes: clampInt(c.overtimeMinutes, 1, 10, 5),
    foulLimit: clampInt(c.foulLimit, 1, 10, 5),
    timeouts: clampInt(c.timeouts, 0, 10, 3),
    timeoutSeconds: clampInt(c.timeoutSeconds, 10, 180, 60),
    breakSeconds: clampInt(c.breakSeconds, 10, 600, 120),
    shotClock: c.shotClock === true,
    shotClockSeconds: clampInt(c.shotClockSeconds, 5, 35, 24),
    trackPlayers: c.trackPlayers === true,
  };
}

export function sanitizeTeams(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const out = [];
  for (const t of raw) {
    const name = String(t?.name ?? '').trim().slice(0, 16);
    const color = HEX.test(String(t?.color ?? '')) ? String(t.color).toUpperCase() : null;
    if (!name || !color) return null;
    out.push({ name, color });
  }
  if (out[0].name === out[1].name) return null;
  return out;
}

export function sanitizePlayers(raw, teams) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    const team = Number(p?.team);
    const name = String(p?.name ?? '').trim().slice(0, 8);
    if (!name || (team !== 0 && team !== 1)) continue;
    if (out.filter((x) => x.team === team).length >= 15) continue;
    if (out.some((x) => x.team === team && x.name === name)) continue;
    out.push({ team, name, points: 0 });
  }
  return out;
}

export function emptyState(config, teams, players) {
  return {
    status: 'setup',
    config,
    teams: teams.map((t) => ({
      ...t, score: 0, fouls: 0, timeoutsLeft: config.timeouts,
      periodScores: new Array(config.periods).fill(0),
      stats: { pts3: 0, pts2: 0, pts1: 0 },
    })),
    players,
    clock: {
      mode: 'game', period: 1, running: false, since: null,
      remainingMs: minutesMs(config.periodMinutes),
      gameRemainingMs: minutesMs(config.periodMinutes),
      timeoutTeam: null,
    },
    shot: { running: false, since: null, remainingMs: config.shotClockSeconds * 1000 },
    possession: 0,
    undo: null,
    nonces: [],
    startedAt: null, finishedAt: null, winner: null,
  };
}

// ---------- 时钟推算（各端一致；前端有镜像实现，改这里要同步改 web/js/clock.js） ----------

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
  const s = state.shot;
  if (!state.config.shotClock) return null;
  const remainingMs = deriveRemaining(s, nowMs);
  return { running: s.running, remainingMs, zero: s.running && remainingMs <= 0 };
}

// ---------- 动作应用 ----------

const snapshot = (s) => clone({ teams: s.teams, players: s.players, clock: s.clock, shot: s.shot, possession: s.possession });

function pushUndo(s) { s.undo = snapshot(s); }

function activate(s, nowIso) {
  if (s.status === 'setup') { s.status = 'live'; s.startedAt = iso(nowIso); }
}

function ensurePeriodSlots(s) {
  const need = s.clock.period;
  while (s.teams[0].periodScores.length < need) s.teams.forEach((t) => t.periodScores.push(0));
}

function startBreak(s, nextPeriod, mins, nowIso) {
  s.clock.period = nextPeriod;
  ensurePeriodSlots(s);
  s.teams.forEach((t) => { t.fouls = 0; });
  s.clock.mode = 'break';
  s.clock.running = true;
  s.clock.since = iso(nowIso);
  s.clock.remainingMs = s.config.breakSeconds * 1000;
  s.clock.gameRemainingMs = minutesMs(mins);
  s.shot = { running: false, since: null, remainingMs: s.config.shotClockSeconds * 1000 };
}

function endPeriod(s, nowIso) {
  const cfg = s.config;
  const tied = s.teams[0].score === s.teams[1].score;
  const inRegular = s.clock.period < cfg.periods;
  if (!inRegular && !tied) {
    s.status = 'finished';
    s.finishedAt = iso(nowIso);
    s.winner = s.teams[0].score > s.teams[1].score ? 0 : 1;
    s.clock.running = false; s.clock.since = null; s.clock.remainingMs = 0;
    s.shot.running = false; s.shot.since = null;
    return;
  }
  const next = s.clock.period + 1;
  const mins = next > cfg.periods ? cfg.overtimeMinutes : cfg.periodMinutes;
  startBreak(s, next, mins, nowIso);
}

function stopGameClock(s, nowMs) {
  if (s.clock.mode === 'game' && s.clock.running) {
    s.clock.remainingMs = deriveRemaining(s.clock, nowMs);
    s.clock.running = false; s.clock.since = null;
  }
}

/**
 * 对外入口：先做幂等判定（响应丢失后客户端会补发同一意图，户外信号差时必然发生），
 * 再交给纯规则函数；成功应用的 nonce 记入有界历史。
 */
export function applyAction(prev, action, nowIso, nowMs = Date.now()) {
  const nonce = typeof action?.nonce === 'string' && action.nonce.length >= 8 && action.nonce.length <= 64 ? action.nonce : null;
  const s = clone(prev);
  if (nonce && Array.isArray(s.nonces) && s.nonces.includes(nonce)) return { state: s, duplicate: true };
  const res = runAction(s, action, nowIso, nowMs);
  if (res.state && nonce) res.state.nonces = [...(res.state.nonces || []), nonce].slice(-30);
  return res;
}

function runAction(s, action, nowIso, nowMs) {
  const type = action?.type;
  if (!type || typeof type !== 'string') return { error: 'invalid_action' };

  if (type === 'undo') {
    if (!s.undo) return { error: 'nothing_to_undo' };
    const u = s.undo;
    s.teams = u.teams; s.players = u.players; s.clock = u.clock; s.shot = u.shot; s.possession = u.possession;
    s.undo = null;
    return { state: s };
  }

  if (s.status === 'finished' && type !== 'reset') return { error: 'game_finished', status: 409 };

  if (type === 'reset') {
    const fresh = emptyState(
      s.config,
      s.teams.map((t) => ({ name: t.name, color: t.color })),
      s.players.map((p) => ({ team: p.team, name: p.name, points: 0 })),
    );
    fresh.nonces = s.nonces || []; // 旧意图不得在重开后被补发二次生效
    return { state: fresh };
  }

  switch (type) {
    case 'score': {
      const team = strictInt(action.team), points = strictInt(action.points);
      if (team !== 0 && team !== 1) return { error: 'invalid_team' };
      if (![1, 2, 3].includes(points)) return { error: 'invalid_points' };
      if (s.clock.mode !== 'game') return { error: 'not_in_play' }; // 休息/暂停期间的加分会串到下一节，一律拒
      activate(s, nowIso);
      pushUndo(s);
      const t = s.teams[team];
      t.score += points;
      const idx = Math.min(t.periodScores.length, s.clock.period) - 1;
      t.periodScores[idx] += points;
      t.stats[`pts${points}`] += 1;
      if (action.playerId != null) {
        const p = s.players.find((x) => x.team === team && x.name === String(action.playerId));
        if (!p) return { error: 'invalid_player' };
        p.points += points;
      }
      if (s.config.shotClock) s.shot = { running: false, since: null, remainingMs: s.config.shotClockSeconds * 1000 };
      s.possession = 1 - team;
      return { state: s };
    }
    case 'foul': {
      const team = strictInt(action.team);
      if (team !== 0 && team !== 1) return { error: 'invalid_team' };
      if (s.clock.mode !== 'game') return { error: 'not_in_play' };
      activate(s, nowIso);
      pushUndo(s);
      s.teams[team].fouls += 1;
      return { state: s };
    }
    case 'timeout': {
      const team = strictInt(action.team);
      if (team !== 0 && team !== 1) return { error: 'invalid_team' };
      if (s.status !== 'live') return { error: 'game_not_started' }; // 未开打不得叫暂停（否则 setup 就能烧掉一次暂停）
      if (s.clock.mode !== 'game') return { error: 'timeout_only_in_play' };
      const t = s.teams[team];
      if (t.timeoutsLeft <= 0) return { error: 'no_timeouts_left' };
      pushUndo(s);
      stopGameClock(s, nowMs);
      t.timeoutsLeft -= 1;
      s.clock.gameRemainingMs = s.clock.remainingMs;
      s.clock.mode = 'timeout';
      s.clock.running = true;
      s.clock.since = iso(nowIso);
      s.clock.remainingMs = s.config.timeoutSeconds * 1000;
      s.clock.timeoutTeam = team;
      if (s.config.shotClock) s.shot = { running: false, since: null, remainingMs: s.config.shotClockSeconds * 1000 };
      return { state: s };
    }
    case 'clock_start': {
      if (s.clock.mode === 'timeout' || s.clock.mode === 'break') return { error: 'wait_countdown_end' };
      if (s.clock.running) return { error: 'already_running' };
      activate(s, nowIso);
      pushUndo(s);
      s.clock.running = true;
      s.clock.since = iso(nowIso);
      if (s.config.shotClock && s.shot.remainingMs > 0) { s.shot.running = true; s.shot.since = iso(nowIso); }
      return { state: s };
    }
    case 'clock_stop': {
      if (s.clock.mode !== 'game') return { error: 'not_in_play' };
      if (!s.clock.running) return { error: 'already_stopped' };
      pushUndo(s);
      stopGameClock(s, nowMs);
      if (s.config.shotClock && s.shot.running) {
        s.shot.remainingMs = deriveRemaining(s.shot, nowMs);
        s.shot.running = false; s.shot.since = null;
      }
      return { state: s };
    }
    case 'shot_reset': {
      if (!s.config.shotClock) return { error: 'shot_clock_off' };
      pushUndo(s);
      s.shot = { running: s.clock.running && s.clock.mode === 'game', since: s.clock.running ? iso(nowIso) : null, remainingMs: s.config.shotClockSeconds * 1000 };
      return { state: s };
    }
    case 'possession': {
      const team = strictInt(action.team);
      if (team !== 0 && team !== 1) return { error: 'invalid_team' };
      pushUndo(s);
      s.possession = team;
      return { state: s };
    }
    case 'clock_zero': {
      // 仅当时钟确实归零时生效（幂等，防提前跳节）
      const d = deriveClock(s, nowMs);
      if (!d.zero) return { state: s };
      if (s.clock.mode === 'game') { pushUndo(s); endPeriod(s, nowIso); }
      else if (s.clock.mode === 'timeout') { s.clock.mode = 'game'; s.clock.running = false; s.clock.since = null; s.clock.remainingMs = s.clock.gameRemainingMs; s.clock.timeoutTeam = null; }
      else if (s.clock.mode === 'break') { s.clock.mode = 'game'; s.clock.running = false; s.clock.since = null; s.clock.remainingMs = s.clock.gameRemainingMs; }
      return { state: s };
    }
    case 'period_next': {
      // 手动跳节（记分员权限）：休息中则提前结束休息，暂停中先收回暂停再跳节
      if (s.clock.mode === 'break') {
        pushUndo(s);
        s.clock.mode = 'game'; s.clock.running = false; s.clock.since = null;
        s.clock.remainingMs = s.clock.gameRemainingMs;
        return { state: s };
      }
      pushUndo(s);
      if (s.clock.mode === 'timeout') {
        s.clock.mode = 'game'; s.clock.timeoutTeam = null;
        s.clock.remainingMs = s.clock.gameRemainingMs;
      }
      endPeriod(s, nowIso);
      return { state: s };
    }
    case 'finish': {
      pushUndo(s);
      s.status = 'finished';
      s.finishedAt = iso(nowIso);
      s.winner = s.teams[0].score === s.teams[1].score ? null : (s.teams[0].score > s.teams[1].score ? 0 : 1);
      s.clock.running = false; s.clock.since = null;
      s.shot.running = false; s.shot.since = null;
      return { state: s };
    }
    default:
      return { error: 'invalid_action' };
  }
}
