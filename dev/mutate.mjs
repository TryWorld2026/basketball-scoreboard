// 变异测试：把每处修复逐个还原，断言测试网必须变红、且红在该管它的断言上。
// 存活的变异体 = 该修复从未被测到。运行：node dev/mutate.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const R = (f) => fileURLToPath(new URL(f, import.meta.url));
const RULES = R('../worker/rules.mjs');
const HANDLER = R('../worker/handler.mjs');
const FAKESTORE = R('../dev/fake-store.mjs');
const STOREJS = R('../public/js/store.js');
const CLOCKJS = R('../public/js/clock.js');
const CSSFILE = R('../public/styles.css');
const CARDJS = R('../public/js/views/card.js');

const mutants = [
  {
    name: 'M1 写路径绕过 durable receipts（幂等退回无去重）',
    file: HANDLER,
    from: `    const written = nonce
      ? await store.casUpdateGameWithReceipt(code, row.version, patch, nonce)
      : await store.casUpdateGame(code, row.version, patch);`,
    to: `    const written = await store.casUpdateGame(code, row.version, patch);`,
    suite: 'attack', mustRedOn: '补发窗口超过 30 次后续写入后仍只计一次',
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
    suite: 'attack', mustRedOn: '时钟没归零时带 nonce 的 clock_zero 不改状态不涨版本',
  },
  {
    name: 'M5 休息期跳节退回报错',
    file: RULES,
    from: `      if (s.clock.mode === 'break') {
        pushUndo(s, nowMs);
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
      pushUndo(s, nowMs);
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
    name: 'M29 写路径凭证校验被移除（房间码又能直接改比分）',
    file: HANDLER,
    from: `async function authorize(request, storedHash) {
  if (typeof storedHash !== 'string' || !storedHash) return false;
  const token = bearer(request);
  if (!token) return false;
  const presented = await hashCredential(token);
  return presented ? sameHash(presented, storedHash) : false;
}`,
    to: `async function authorize() { return true; /* MUTANT: 凭证校验删除 */ }`,
    suite: 'attack', mustRedOn: '房间码只读不能直接写入',
  },
  {
    name: 'M30 reset 门禁被移除（进行中也能擦库重开）',
    file: RULES,
    from: `    if (s.status !== 'finished') return { error: 'reset_not_allowed', status: 409 };`,
    to: `    /* MUTANT: reset 门禁删除 */`,
    suite: 'attack', mustRedOn: '进行中 reset 被拒（409 reset_not_allowed）',
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
  {
    name: 'M16 进球后 24 秒不再恢复运行（冻在记分台上）',
    file: RULES,
    from: `      if (s.config.shotClock) {
        s.shot = {
          running: s.clock.running, since: s.clock.running ? iso(nowIso) : null,
          remainingMs: s.config.shotClockSeconds * 1000,
        };
      }`,
    to: `      if (s.config.shotClock) { s.shot = { running: false, since: null, remainingMs: s.config.shotClockSeconds * 1000 }; }`,
    suite: 'attack', mustRedOn: '进球后 24 秒归满且继续走（不冻结）',
  },
  {
    name: 'M17 撤销快照不再冻结时钟（撤销吞掉停表时间）',
    file: RULES,
    from: `const frozen = (c, nowMs) => (c.running && c.since
  ? { ...c, running: false, since: null, remainingMs: deriveRemaining(c, nowMs) }
  : { ...c });`,
    to: `const frozen = (c) => ({ ...c });`,
    suite: 'attack', mustRedOn: '撤销停表后时钟冻结在停表那一刻（停表时间不被消耗）',
  },
  {
    name: 'M18 playerId 退回 String() 强转（对象被吞成球员名）',
    file: RULES,
    from: `        if (typeof action.playerId !== 'string') return { error: 'invalid_player' }; // 数组/数字会被 String() 静默吞成球员名
        const p = s.players.find((x) => x.team === team && x.name === action.playerId);`,
    to: `        const p = s.players.find((x) => x.team === team && x.name === String(action.playerId));`,
    suite: 'attack', mustRedOn: 'playerId 传数组应被拒（不被 String() 静默吞成球员名）',
  },
  {
    name: 'M19 失败限流被移除（房间码可无限枚举）',
    file: HANDLER,
    from: `  if (allowed) return res;`,
    to: `  if (true) return res;`,
    suite: 'attack', mustRedOn: '第 4 次未命中被限流 429',
  },
  {
    name: 'M20 半途放弃局不再清理（库只增不减）',
    file: HANDLER,
    from: `  try { await store.deleteAbandoned(new Date(Date.now() - ABANDONED_MS).toISOString()); } catch { /* ignore */ }`,
    to: `  /* MUTANT: 放弃局清理删除 */`,
    suite: 'attack', mustRedOn: '8 天没写入的 live 房间被清',
  },
  {
    name: 'M21 乱序响应保护删除（旧 GET 覆盖新 apply）',
    file: STOREJS,
    from: `    if (this.snapshot && Number.isInteger(snap?.version) && snap.version < this.version) return;`,
    to: `    /* MUTANT: 乱序响应保护删除 */`,
    suite: 'store', mustRedOn: '旧版本响应被丢弃（快照不回退）',
  },
  {
    name: 'M22 前端时钟镜像漂移（大屏与记分员看到不同时间）',
    file: CLOCKJS,
    from: `  if (!c.running || !c.since) return Math.max(0, c.remainingMs);`,
    to: `  if (false) return Math.max(0, c.remainingMs);`,
    suite: 'parity', mustRedOn: 'deriveRemaining · 停表但残留 since',
  },
  {
    name: 'M23 末节跳节的终局判定漏掉常规末节（点了不问就终局）',
    file: CLOCKJS,
    from: `    && s.clock.period >= s.config.periods`,
    to: `    && s.clock.period > s.config.periods`,
    suite: 'parity', mustRedOn: '第 2 节已分胜负',
  },
  {
    name: 'M24 终局判定不看平分（平局也弹终局确认）',
    file: CLOCKJS,
    from: `    && s.teams[0].score !== s.teams[1].score;`,
    to: `    ;`,
    suite: 'parity', mustRedOn: '第 2 节平分（平局才加时）',
  },
  {
    name: 'M25 全场累计犯规不再累计（赛后数据卡的犯规数只剩末节）',
    file: RULES,
    from: `      s.teams[team].fouls += 1;
      s.teams[team].foulsTotal += 1; // fouls 每节清零，foulsTotal 全场累计，赛后数据卡用它`,
    to: `      s.teams[team].fouls += 1;`,
    suite: 'smoke', mustRedOn: 'foulsTotal 全场累计，不随节清零',
  },
  // ---------- 移动端：这些问题是自动化跑不出来的（CI 里没有 iPhone），
  // 只有把「修好的样子」写成断言 + 变异体，才不会在下次改版里悄悄退回去。
  {
    name: 'M26 球员得分按钮 .chip 退回行内尺寸（手机上 35px 命中区，全场最高频的操作）',
    file: CSSFILE,
    from: `min-height: 44px; padding: .5rem .85rem; border-radius: 999px;`,
    to: `padding: .5rem .85rem; border-radius: 999px;`,
    suite: 'mobile', mustRedOn: '球员得分按钮 .chip 命中区不小于 44px',
  },
  {
    name: 'M27 iOS 保存图片不再走分享面板（iPhone 退化成长按存图，且被注释骗过断言）',
    file: CARDJS,
    from: `navigator.share({
            files: [shareFile],`,
    to: `void({
            files: [shareFile],`,
    suite: 'mobile', mustRedOn: '保存走 navigator.share',
  },
  {
    name: 'M28 .d-overlay 的 color-mix 兜底被删（老 iOS 弹层整块变透明，不是退化而是消失）',
    file: CSSFILE,
    from: `  background: rgba(6, 9, 18, .96);`,
    to: `  /* MUTANT: 遮罩兜底删除 */`,
    suite: 'mobile', mustRedOn: 'color-mix 一律要有无 color-mix 的兜底声明',
  },
];

const runSuite = (which) => {
  const r = spawnSync(process.execPath, [`dev/${which}.mjs`], { encoding: 'utf8', cwd: process.cwd() });
  return `${r.stdout || ''}${r.stderr || ''}`;
};

// ---------- 基线必须全绿 ----------
// 否则「红在指定断言上」可能只是基线本来就红，整张变异表的结论全部失真。
// 这不是理论担忧：曾把 CAS_ATTEMPTS 改成 1 实测过，攻击网会红但 exit 仍是 0，
// 变异体被判定为 killed，而它其实只是撞上了一堵本来就红着的墙。
let currentFile = null;
let currentOriginal = null;
const restore = () => {
  if (currentFile) {
    try { writeFileSync(currentFile, currentOriginal); } catch { /* ignore */ }
    currentFile = null; currentOriginal = null;
  }
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { restore(); console.log(`\n收到 ${sig}，已还原被注入的文件后退出`); process.exit(130); });
}

const suites = [...new Set(mutants.map((m) => m.suite))];
console.log(`基线检查：未注入变异体时 ${suites.join(' / ')} 必须全绿`);
let baselineBad = false;
for (const s of suites) {
  const out = runSuite(s);
  if (/(ATTACK|FAIL)/.test(out)) {
    baselineBad = true;
    console.log(`ABORT  基线就是红的（${s}），先修测试再跑变异——否则每个变异体都会被误判成 killed：\n${out}`);
  }
}
if (baselineBad) process.exit(1);
console.log('基线全绿，开始注入。\n');

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
  currentFile = m.file; currentOriginal = original;
  writeFileSync(m.file, original.replace(m.from, m.to));
  let out = '';
  try { out = runSuite(m.suite); } finally { restore(); }
  if (readFileSync(m.file, 'utf8') !== original) {
    console.log(`ABORT  ${m.name} —— 还原失败，请执行 git checkout -- ${m.file}`);
    process.exit(1);
  }
  const redRe = new RegExp(`(ATTACK|FAIL)\\s+.*${m.mustRedOn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const redOnTarget = redRe.test(out);
  const anyRed = /(ATTACK|FAIL)/.test(out);
  if (redOnTarget) { killed += 1; console.log(`killed     ${m.name}  →  红在「${m.mustRedOn}」`); }
  else if (anyRed) { misattributed += 1; console.log(`MISATTR    ${m.name}  →  变红了但没红在该断言上（断言问错了问题）`); }
  else { survived += 1; console.log(`SURVIVED   ${m.name}  →  测试网全绿，这个修复从未被测到`); }
}

console.log(`\n变异结果：击杀 ${killed} / 存活 ${survived} / 归属存疑 ${misattributed}`);
process.exit(survived || misattributed ? 1 : 0);
