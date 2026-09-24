// 变异测试：把每处修复逐个还原，断言测试网必须变红、且红在该管它的断言上。
// 存活的变异体 = 该修复从未被测到。运行：node dev/mutate.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const R = (f) => fileURLToPath(new URL(f, import.meta.url));
const RULES = R('../worker/rules.mjs');
const HANDLER = R('../worker/handler.mjs');
const FAKESTORE = R('../dev/fake-store.mjs');

const mutants = [
  {
    name: 'M1 幂等键判定被移除',
    file: RULES,
    from: `if (nonce && Array.isArray(s.nonces) && s.nonces.includes(nonce)) return { state: s, duplicate: true };`,
    to: `/* MUTANT: 幂等判定删除 */`,
    suite: 'attack', mustRedOn: '同 nonce 重发只计一次分',
  },
  {
    name: 'M2 严格整数退回 Number 强制转换',
    file: RULES,
    from: `const strictInt = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : NaN);`,
    to: `const strictInt = (v) => Number(v);`,
    suite: 'attack', mustRedOn: 'team:null 应被拒',
  },
  {
    name: 'M3 得分的 mode 门禁被移除',
    file: RULES,
    from: `      if (s.clock.mode !== 'game') return { error: 'not_in_play' }; // 休息/暂停期间的加分会串到下一节，一律拒`,
    to: `      /* MUTANT: 得分门禁删除 */`,
    suite: 'attack', mustRedOn: '休息期按分被拒',
  },
  {
    name: 'M4 无变化写库短路被移除',
    file: HANDLER,
    from: `    if (JSON.stringify(result.state) === JSON.stringify(row.state)) {`,
    to: `    if (false) {`,
    suite: 'attack', mustRedOn: '重发不涨版本并标记 noop',
  },
  {
    name: 'M5 休息期跳节退回报错',
    file: RULES,
    from: `      if (s.clock.mode === 'break') {
        pushUndo(s);
        s.clock.mode = 'game'; s.clock.running = false; s.clock.since = null;
        s.clock.remainingMs = s.clock.gameRemainingMs;
        return { state: s };
      }`,
    to: `      if (s.clock.mode === 'break') return { error: 'already_break' };`,
    suite: 'attack', mustRedOn: '休息中按下一节 = 提前结束休息',
  },
  {
    name: 'M6 未开打可叫暂停',
    file: RULES,
    from: `      if (s.status !== 'live') return { error: 'game_not_started' }; // 未开打不得叫暂停（否则 setup 就能烧掉一次暂停）`,
    to: `      /* MUTANT: 未开打门禁删除 */`,
    suite: 'attack', mustRedOn: '未开打请求暂停应被拒',
  },
  {
    name: 'M7 reset 丢失球员得分字段',
    file: RULES,
    from: `      s.players.map((p) => ({ team: p.team, name: p.name, points: 0 })),`,
    to: `      s.players.map((p) => ({ team: p.team, name: p.name })),`,
    suite: 'attack', mustRedOn: 'reset 清空球员得分',
  },
  {
    name: 'M8 犯规的 mode 门禁被移除',
    file: RULES,
    from: `      if (s.clock.mode !== 'game') return { error: 'not_in_play' };
      activate(s, nowIso);
      pushUndo(s);
      s.teams[team].fouls += 1;`,
    to: `      activate(s, nowIso);
      pushUndo(s);
      s.teams[team].fouls += 1;`,
    suite: 'attack', mustRedOn: '休息期记犯规同样被拒',
  },
  {
    name: 'M9 归零不再要求时钟真的归零（可提前跳节）',
    file: RULES,
    from: `      const d = deriveClock(s, nowMs);
      if (!d.zero) return { state: s };`,
    to: `      /* MUTANT: 归零校验删除 */`,
    suite: 'attack', mustRedOn: '未归零时 clock_zero 不推进节次',
  },
  {
    name: 'M10 CAS 版本条件被忽略（并发丢分）',
    file: FAKESTORE,
    from: `if (!row || row.version !== expectedVersion) return { changed: false, version: expectedVersion + 1 };`,
    to: `if (!row) return { changed: false, version: expectedVersion + 1 };`,
    suite: 'attack', mustRedOn: '两笔都应落地（CAS 重放不丢分）',
  },
  {
    name: 'M11 单层撤销变成可重复撤销',
    file: RULES,
    from: `    s.undo = null;
    return { state: s };`,
    to: `    return { state: s };`,
    suite: 'attack', mustRedOn: '第二次撤销应报 nothing_to_undo',
  },
  {
    name: 'M12 结束后仍可改分',
    file: RULES,
    from: `  if (s.status === 'finished' && type !== 'reset') return { error: 'game_finished', status: 409 };`,
    to: `  /* MUTANT: 结束锁定删除 */`,
    suite: 'smoke', mustRedOn: '结束后拒绝改分',
  },
  {
    name: 'M13 新节不清零犯规',
    file: RULES,
    from: `  s.teams.forEach((t) => { t.fouls = 0; });`,
    to: `  /* MUTANT: 不清零 */`,
    suite: 'smoke', mustRedOn: '新一节犯规清零',
  },
  {
    name: 'M14 末节平局不进加时而直接结束',
    file: RULES,
    from: `  if (!inRegular && !tied) {`,
    to: `  if (false) {`,
    suite: 'attack', mustRedOn: '末节分出胜负必须结束比赛',
  },
  {
    name: 'M15 平局结束时误判主队获胜',
    file: RULES,
    from: `      s.winner = s.teams[0].score === s.teams[1].score ? null : (s.teams[0].score > s.teams[1].score ? 0 : 1);`,
    to: `      s.winner = 0;`,
    suite: 'attack', mustRedOn: '人为结束时平局 winner 为 null',
  },
];

const runSuite = (which) => {
  const r = spawnSync(process.execPath, [`dev/${which}.mjs`], { encoding: 'utf8', cwd: process.cwd() });
  return `${r.stdout || ''}${r.stderr || ''}`;
};

let killed = 0; let survived = 0; let misattributed = 0;
console.log(`注入 ${mutants.length} 个变异体，逐个断言测试网必须变红在指定断言上：\n`);

for (const m of mutants) {
  const original = readFileSync(m.file, 'utf8');
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    console.log(`SKIP  ${m.name} —— 锚点命中 ${hits} 次（脚手架问题，先修探针）`);
    misattributed += 1;
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  let out = '';
  try { out = runSuite(m.suite); } finally { writeFileSync(m.file, original); }
  const redRe = new RegExp(`(ATTACK|FAIL)\\s+.*${m.mustRedOn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const redOnTarget = redRe.test(out);
  const anyRed = /(ATTACK|FAIL)/.test(out);
  if (redOnTarget) { killed += 1; console.log(`killed     ${m.name}  →  红在「${m.mustRedOn}」`); }
  else if (anyRed) { misattributed += 1; console.log(`MISATTR    ${m.name}  →  变红了但没红在该断言上（断言问错了问题）`); }
  else { survived += 1; console.log(`SURVIVED   ${m.name}  →  测试网全绿，这个修复从未被测到`); }
}

console.log(`\n变异结果：击杀 ${killed} / 存活 ${survived} / 归属存疑 ${misattributed}`);
process.exit(survived || misattributed ? 1 : 0);
