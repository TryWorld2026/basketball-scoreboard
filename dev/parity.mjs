// 双端时钟镜像一致性测试。
// worker/rules.mjs 与 public/js/clock.js 各有一份 derive* 实现（服务端算状态、前端做显示），
// CONTRIBUTING 要求"改一处必须同步另一处"——以前只靠纪律，这里把纪律变成断言。
// 一旦两份实现漂移，大屏和记分员就会看到不同的时间，直接违背产品第一卖点。
// 运行：node dev/parity.mjs
import {
  deriveClock as serverDeriveClock,
  deriveShot as serverDeriveShot,
  deriveRemaining as serverDeriveRemaining,
  emptyState,
  applyAction,
  sanitizeConfig,
  sanitizeTeams,
} from '../worker/rules.mjs';
import {
  deriveClock as clientDeriveClock,
  deriveShot as clientDeriveShot,
  deriveRemaining as clientDeriveRemaining,
  formatClock,
  periodNextFinishes,
} from '../public/js/clock.js';

let pass = 0; let fail = 0;
const eq = (name, a, b) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (same) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}\n        服务端=${JSON.stringify(a)}\n        前端  =${JSON.stringify(b)}`); }
};

const cfg = sanitizeConfig({ periods: 4, periodMinutes: 10, shotClock: true, shotClockSeconds: 24 });
const teams = sanitizeTeams([{ name: 'A', color: '#1E4FD8' }, { name: 'B', color: '#E11D2E' }]);
const base = emptyState(cfg, teams, []);

const NOW = Date.parse('2026-09-27T10:00:00.000Z');
const at = (offsetMs) => NOW + offsetMs;

// ---------- deriveRemaining：各状态矩阵 ----------
console.log('— deriveRemaining 矩阵 —');
const clocks = [
  ['停表', { running: false, since: null, remainingMs: 452300 }],
  ['停表但残留 since', { running: false, since: '2026-09-27T09:58:00.000Z', remainingMs: 452300 }],
  ['走表未耗尽', { running: true, since: '2026-09-27T09:59:30.000Z', remainingMs: 600000 }],
  ['走表刚好归零', { running: true, since: '2026-09-27T09:50:00.000Z', remainingMs: 600000 }],
  ['走表已归零（负值夹紧）', { running: true, since: '2026-09-27T09:40:00.000Z', remainingMs: 600000 }],
  ['走表零剩余', { running: true, since: '2026-09-27T09:59:59.999Z', remainingMs: 0 }],
  ['since 非法', { running: true, since: 'not-a-date', remainingMs: 600000 }],
  ['since 为 null 但标记运行', { running: true, since: null, remainingMs: 600000 }],
];
for (const [label, c] of clocks) {
  eq(`deriveRemaining · ${label}`, serverDeriveRemaining(c, at(0)), clientDeriveRemaining(c, at(0)));
}

// ---------- deriveClock / deriveShot：整场状态 ----------
console.log('\n— deriveClock / deriveShot 矩阵 —');
const scenarios = [
  ['setup 初始', base, 0],
  ['比赛走表中', { ...base, status: 'live', clock: { ...base.clock, running: true, since: '2026-09-27T09:59:00.000Z' } }, 0],
  ['比赛走瓶中（<1 分钟）', { ...base, status: 'live', clock: { ...base.clock, running: true, since: '2026-09-27T09:59:20.000Z', remainingMs: 45000 } }, 0],
  ['比赛已归零', { ...base, status: 'live', clock: { ...base.clock, running: true, since: '2026-09-27T09:50:00.000Z' } }, 0],
  ['暂停中', { ...base, status: 'live', clock: { ...base.clock, mode: 'timeout', period: 2, running: true, since: '2026-09-27T09:59:30.000Z', remainingMs: 60000, timeoutTeam: 1 } }, 0],
  ['节间休息', { ...base, status: 'live', clock: { ...base.clock, mode: 'break', period: 3, running: true, since: '2026-09-27T09:59:40.000Z', remainingMs: 120000 } }, 0],
  ['已结束', { ...base, status: 'finished', clock: { ...base.clock, remainingMs: 0 } }, 0],
  ['24 秒走表', { ...base, status: 'live', shot: { running: true, since: '2026-09-27T09:59:50.000Z', remainingMs: 24000 } }, 0],
  ['24 秒停表', { ...base, status: 'live', shot: { running: false, since: null, remainingMs: 8000 } }, 0],
  ['24 秒归零', { ...base, status: 'live', shot: { running: true, since: '2026-09-27T09:59:30.000Z', remainingMs: 24000 } }, 0],
];
for (const [label, state, offset] of scenarios) {
  eq(`deriveClock · ${label}`, serverDeriveClock(state, at(offset)), clientDeriveClock(state, at(offset)));
  eq(`deriveShot · ${label}`, serverDeriveShot(state, at(offset)), clientDeriveShot(state, at(offset)));
}

// ---------- 同一状态在不同"现在"下也必须一致（时间推进不漂移） ----------
console.log('\n— 时间推进一致性 —');
const live = { ...base, status: 'live', clock: { ...base.clock, running: true, since: '2026-09-27T09:58:00.000Z' } };
for (const offset of [0, 1, 999, 60_000, 119_999, 120_000, 600_000]) {
  eq(`推进 ${offset}ms`, serverDeriveClock(live, at(offset)), clientDeriveClock(live, at(offset)));
}

// ---------- formatClock 属于前端展示，锁定关键格式 ----------
console.log('\n— formatClock 格式 —');
const fmts = [
  ['00:00', formatClock(0)],
  ['10:00', formatClock(600000)],
  ['09:59', formatClock(599900)],
  ['00:07.5（十分位）', formatClock(7500, true)],
  ['00:00.9（十分位）', formatClock(900, true)],
  ['00:00（负值夹紧）', formatClock(-5000)],
  ['00:00.0（十分位负值夹紧）', formatClock(-100, true)],
];
for (const [label, got] of fmts) {
  const want = label.split('（')[0];
  if (got === want) { pass += 1; console.log(`  ok  formatClock ${label} → ${got}`); }
  else { fail += 1; console.log(`FAIL  formatClock ${label}：期望 ${want} 实际 ${got}`); }
}

// ---------- 「下一节」二次确认门禁：前端判定必须与服务端真实落库结果一致 ----------
// 控制端靠 periodNextFinishes 决定要不要弹确认框。它如果说"不会终局"而服务端真的终局了，
// 记分员就连问一句的机会都没有；如果说"会终局"而服务端不会，就是白白多一道确认。
// 所以这里不手写期望值，直接用 applyAction 的落库结果反锁前端实现。
console.log('\n— periodNextFinishes 与服务端落库结果一致 —');
const gateCfg = sanitizeConfig({ periods: 2, periodMinutes: 5, shotClock: false });
const gateTeams = sanitizeTeams([{ name: 'A', color: '#1E4FD8' }, { name: 'B', color: '#E11D2E' }]);
const gateBase = emptyState(gateCfg, gateTeams, []);
const scored = (state, a, b) => ({
  ...state,
  teams: state.teams.map((t, i) => ({ ...t, score: i === 0 ? a : b })),
});
const gateScenarios = [
  ['第 1 节平分（还有常规节）', gateBase],
  ['第 1 节已分胜负（还有常规节）', scored(gateBase, 3, 0)],
  ['第 2 节平分（平局才加时）', scored({ ...gateBase, clock: { ...gateBase.clock, period: 2 } }, 3, 3)],
  ['第 2 节已分胜负（这一下会终局）', scored({ ...gateBase, clock: { ...gateBase.clock, period: 2 } }, 3, 0)],
  ['加时分胜负（同样会终局）', scored({ ...gateBase, clock: { ...gateBase.clock, period: 3 } }, 5, 3)],
  ['节间休息中（只是提前结束休息）', scored({ ...gateBase, clock: { ...gateBase.clock, period: 2, mode: 'break' } }, 3, 0)],
  ['已结束（按钮早已换成重开）', { ...scored(gateBase, 3, 0), status: 'finished' }],
];
for (const [label, state] of gateScenarios) {
  const clientSays = periodNextFinishes(state);
  const landed = applyAction(state, { type: 'period_next' }, new Date(NOW).toISOString(), NOW);
  // 服务端直接拒绝（如已结束）时没有新状态，等价于"这一下不会终局"
  const serverSays = landed.state ? landed.state.status === 'finished' : false;
  eq(`periodNextFinishes · ${label}`, clientSays, serverSays);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
