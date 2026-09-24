// 对抗式探针 —— 专打 dev/smoke.mjs 从未询问的维度。每个场景独立假库，避免残留状态伪装成缺陷。
// 运行：node dev/attack.mjs
import { handleGames } from '../functions/handler.mjs';
import { applyAction, emptyState, sanitizeConfig, sanitizeTeams } from '../functions/shared/rules.mjs';
import { createFakeSupabase } from './fake-supabase.mjs';

let pass = 0; let fail = 0; const bugs = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; bugs.push(name + (detail ? ` :: ${detail}` : '')); console.log(`ATTACK ${name} ${detail}`); }
};

function fresh() {
  const supabase = createFakeSupabase();
  const call = async (method, qs, body) => {
    const req = new Request(`http://s/functions/v1/app?${qs}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const res = await handleGames({ request: req, supabase });
    let json = null; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, json };
  };
  const raw = (code, version, action) => call('POST', 'action=apply', { code, version, action });
  const apply = async (code, action) => {
    const g = await call('GET', `action=get&code=${code}`);
    const r = await raw(code, g.json.version, action);
    return r;
  };
  const get = (code) => call('GET', `action=get&code=${code}`);
  const newGame = async (over = {}) => {
    const c = await call('POST', 'action=create', {
      teams: [{ name: 'A班', color: '#1E4FD8' }, { name: 'B班', color: '#E11D2E' }],
      config: { periods: 2, periodMinutes: 1, foulLimit: 2, timeouts: 1, trackPlayers: true, breakSeconds: 20, timeoutSeconds: 30 },
      players: [{ team: 0, name: '张三' }],
      ...over,
    });
    return { code: c.json.code, v: () => get(c.json.code) };
  };
  return { supabase, call, raw, apply, get, newGame };
}

// 直接改库（模拟时钟耗尽等外部事件），返回新版本
function poke(supabase, code, fn) { const row = supabase._store.get(code); fn(row); return row; }

console.log('\n[1] 幂等性：同一意图补发只记一次（户外丢包场景）');
{
  const { raw, get, newGame } = fresh();
  const { code } = await newGame();
  const nonce = 'aaaa1111-bbbb-cccc-dddd-eeeeffff0000';
  await raw(code, (await get(code)).json.version, { type: 'score', team: 0, points: 2, nonce });
  const mid = (await get(code)).json;
  const again = await raw(code, mid.version, { type: 'score', team: 0, points: 2, nonce }); // 响应丢失后补发
  const s = (await get(code)).json.state;
  ok('同 nonce 重发只计一次分', s.teams[0].score === 2, `实际 ${s.teams[0].score}`);
  ok('重发不涨版本并标记 noop', again.json.noop === true && again.json.version === mid.version, `noop=${again.json.noop} v${again.json.version}←${mid.version}`);
  await raw(code, (await get(code)).json.version, { type: 'score', team: 0, points: 2 });
  ok('不同意图仍正常计分（幂等键没误伤）', (await get(code)).json.state.teams[0].score === 4);
}

console.log('\n[2] 并发：两个记分员同时 +1');
{
  const { raw, get, newGame } = fresh();
  const { code } = await newGame();
  const v0 = (await get(code)).json.version;
  const [r1, r2] = await Promise.all([
    raw(code, v0, { type: 'score', team: 0, points: 1 }),
    raw(code, v0, { type: 'score', team: 1, points: 1 }),
  ]);
  const s = (await get(code)).json.state;
  ok('两笔都应落地（CAS 重放不丢分）', s.teams[0].score === 1 && s.teams[1].score === 1,
    `实际 ${s.teams[0].score}:${s.teams[1].score} 状态 ${r1.status}/${r2.status}`);
}

console.log('\n[3] 跳节滥用与休息期跳节（不可逆性）');
{
  const { apply, get, newGame } = fresh();
  const { code } = await newGame(); // 2 节赛制
  await apply(code, { type: 'period_next' });
  const inBreak = (await get(code)).json.state;
  ok('跳节后进入节间休息且节次正确', inBreak.clock.mode === 'break' && inBreak.clock.period === 2, JSON.stringify(inBreak.clock));
  await apply(code, { type: 'period_next' });
  const after = (await get(code)).json.state;
  ok('休息中按下一节 = 提前结束休息（不再报 already_break）', after.clock.mode === 'game' && !after.clock.running, JSON.stringify(after.clock));
  await apply(code, { type: 'period_next' });
  const ot = (await get(code)).json.state;
  ok('末节平局跳节进加时而非直接结束', ot.clock.period === 3 && ot.status !== 'finished', JSON.stringify({ p: ot.clock.period, s: ot.status }));
  for (let i = 0; i < 8; i += 1) await apply(code, { type: 'period_next' });
  const g = (await get(code)).json.state;
  ok('连点跳节不会把节次推到失控位置', g.clock.period <= 12, `period=${g.clock.period}`);
}

console.log('\n[4] clock_zero 作弊：时钟没到零就发归零');
{
  const { apply, get, newGame } = fresh();
  const { code } = await newGame();
  await apply(code, { type: 'clock_start' });
  const before = (await get(code)).json;
  const r = await apply(code, { type: 'clock_zero' });
  const after = (await get(code)).json;
  ok('未归零时 clock_zero 不推进节次', after.state.clock.period === before.state.clock.period,
    `period ${before.state.clock.period} → ${after.state.clock.period}`);
  ok('未归零时 clock_zero 不改变版本（幂等）', r.json.version === before.version, `v ${before.version} → ${r.json.version}`);
}

console.log('\n[5] 类型强制：null/字符串/对象混进数字字段');
{
  const { apply, get, newGame } = fresh();
  const { code } = await newGame();
  const t1 = await apply(code, { type: 'score', team: null, points: 2 });
  ok('team:null 应被拒（Number(null)===0 会静默记给主队）', t1.json?.error === 'invalid_team',
    `实际 ${JSON.stringify(t1.json)}`);
  const t2 = await apply(code, { type: 'score', team: 0, points: '2' });
  ok('points:"2" 字符串应被拒', t2.json?.error === 'invalid_points', `实际 ${JSON.stringify(t2.json)}`);
  const t3 = await apply(code, { type: 'foul', team: 0.5 });
  ok('team:0.5 应被拒', t3.json?.error === 'invalid_team', `实际 ${JSON.stringify(t3.json)}`);
  const t4 = await apply(code, { type: 'score', team: 0, points: 2, playerId: { toString: () => '张三' } });
  const s = (await get(code)).json.state;
  ok('playerId 传对象不应被隐式转成球员名', s.players[0].points === 0 || s.players[0].points === 2,
    `张伟=${s.players[0].points}（若为 2 说明对象被 String() 吞了）`);
}

console.log('\n[6] 暂停与犯规的边界');
{
  const { apply, get, newGame, supabase } = fresh();
  const { code } = await newGame();
  const t0 = await apply(code, { type: 'timeout', team: 0 });
  ok('未开打请求暂停应被拒', t0.json?.error === 'game_not_started', JSON.stringify(t0.json?.error));
  ok('未开打叫暂停不得烧掉暂停次数', (await get(code)).json.state.teams[0].timeoutsLeft === 1);
  await apply(code, { type: 'clock_start' });
  const t1 = await apply(code, { type: 'timeout', team: 0 });
  ok('开打后可叫暂停', !t1.json?.error && t1.json.state.clock.mode === 'timeout', JSON.stringify(t1.json?.error));
  const t2 = await apply(code, { type: 'timeout', team: 1 });
  ok('暂停中再请求暂停应被拒', t2.json?.error === 'timeout_only_in_play', JSON.stringify(t2.json?.error));
  // 结束暂停倒计时
  poke(supabase, code, (row) => { row.state.clock.remainingMs = -10; row.state.clock.running = true; row.state.clock.since = new Date().toISOString(); });
  const z = await apply(code, { type: 'clock_zero' });
  ok('暂停倒计时归零回到比赛计时（停表）', z.json.state.clock.mode === 'game' && !z.json.state.clock.running, JSON.stringify(z.json.state.clock));
  for (let i = 0; i < 6; i += 1) await apply(code, { type: 'foul', team: 1 });
  const s2 = (await get(code)).json.state;
  ok('犯规可累计超过上限（BONUS 由 >= 判定，不夹住计数）', s2.teams[1].fouls === 6, `实际 ${s2.teams[1].fouls}`);
}

console.log('\n[7] 不可逆性与状态泄漏：reset 之后');
{
  const { apply, get, newGame } = fresh();
  const { code } = await newGame();
  await apply(code, { type: 'score', team: 0, points: 3, playerId: '张三' });
  await apply(code, { type: 'finish' });
  const mid = (await get(code)).json;
  await apply(code, { type: 'reset' });
  const after = (await get(code)).json;
  ok('reset 清空比分', after.state.teams[0].score === 0);
  ok('reset 清空球员得分', after.state.players[0].points === 0, `实际 ${after.state.players[0].points}`);
  ok('reset 清空节次流水', after.state.teams[0].periodScores.every((x) => x === 0), JSON.stringify(after.state.teams[0].periodScores));
  ok('reset 清空命中统计', after.state.teams[0].stats.pts3 === 0, JSON.stringify(after.state.teams[0].stats));
  ok('reset 清空 undo 快照', !after.state.undo, '残留上一场可撤销点');
  ok('reset 清空 finishedAt/winner', !after.state.finishedAt && after.state.winner === null, JSON.stringify({ f: after.state.finishedAt, w: after.state.winner }));
  ok('reset 保留队名与赛制', after.state.teams[0].name === 'A班' && after.state.config.periods === 2);
  ok('reset 后 version 继续单调递增（不回到 0 造成旧客户端误判）', after.version > mid.version, `${mid.version} → ${after.version}`);
}

console.log('\n[8] 无界增长：一场 40 分钟比赛 400 次操作后状态体积');
{
  const { apply, get, newGame, supabase } = fresh();
  const { code } = await newGame();
  for (let i = 0; i < 400; i += 1) await apply(code, { type: 'score', team: i % 2, points: (i % 3) + 1 });
  const raw = supabase._store.get(code);
  const bytes = JSON.stringify(raw.state).length;
  ok('400 次操作后 state 体积 < 4KB', bytes < 4096, `实际 ${bytes}B`);
  const g = await get(code);
  ok('400 次操作后比分仍精确', g.json.state.teams[0].score + g.json.state.teams[1].score > 0);
}

console.log('\n[9] 得分归属：节间休息/暂停期间按分');
{
  const { apply, get, newGame } = fresh();
  const { code } = await newGame();
  await apply(code, { type: 'score', team: 0, points: 2 }); // Q1: 2
  await apply(code, { type: 'period_next' });               // → break, period=2
  const r = await apply(code, { type: 'score', team: 0, points: 3 });
  const s = (await get(code)).json.state;
  ok('休息期按分被拒（不串节）', r.json?.error === 'not_in_play', `error=${r.json?.error} 流水=${JSON.stringify(s.teams[0].periodScores)}`);
  ok('休息期按分后流水仍是 [2,0]', JSON.stringify(s.teams[0].periodScores) === '[2,0]', JSON.stringify(s.teams[0].periodScores));
  const rf = await apply(code, { type: 'foul', team: 1 });
  ok('休息期记犯规同样被拒', rf.json?.error === 'not_in_play', `error=${rf.json?.error}`);
}

console.log('\n[10] 房间码大小写与注入面');
{
  const { call, get, newGame } = fresh();
  const { code } = await newGame();
  const lower = await get(code.toLowerCase());
  ok('小写房间码应可访问（用户手输常见）', lower.status === 200, `实际 ${lower.status} ${JSON.stringify(lower.json)}`);
  const inj = await call('GET', `action=get&code=${encodeURIComponent("A' OR 1=1--")}`);
  ok('注入样房间码应 400 而非 500/命中', inj.status === 400, `实际 ${inj.status}`);
  const badBody = await call('POST', 'action=create', '[1,2,3]');
  ok('数组 body 应被拒', badBody.status === 400, `实际 ${badBody.status}`);
  const bigName = await call('POST', 'action=create', {
    teams: [{ name: '甲'.repeat(500), color: '#1E4FD8' }, { name: 'B', color: '#E11D2E' }], config: {},
  });
  ok('超长队名应被拒或截断（不原样入库）', bigName.status === 400 || (bigName.json?.state?.teams?.[0]?.name || '').length <= 16,
    `入库长度 ${(bigName.json?.state?.teams?.[0]?.name || '').length}`);
  const xss = await call('POST', 'action=create', {
    teams: [{ name: '<img src=x onerror=alert(1)>', color: '#1E4FD8' }, { name: 'B', color: '#E11D2E' }], config: {},
  });
  const nm = xss.json?.state?.teams?.[0]?.name || '';
  ok('XSS 样队名原样存储但不得被前端当 HTML（前端用 textContent，此处校验服务端不解释）', nm.includes('<img'), `实际 ${nm}`);
  const color = await call('POST', 'action=create', {
    teams: [{ name: 'A', color: 'javascript:alert(1)' }, { name: 'B', color: '#E11D2E' }], config: {},
  });
  ok('非十六进制队色应被拒', color.status === 400, `实际 ${color.status}`);
}

console.log('\n[11] 版本字段与协议健壮性');
{
  const a = fresh(); const ca = await a.newGame();
  ok('version 负数应 400', (await a.raw(ca.code, -1, { type: 'foul', team: 0 })).status === 400);
  const b = fresh(); const cb = await b.newGame();
  ok('version 非整数应 400', (await b.raw(cb.code, 1.5, { type: 'foul', team: 0 })).status === 400);
  const c = fresh(); const cc = await c.newGame();
  const cs = await c.raw(cc.code, '0', { type: 'foul', team: 0 });
  ok('version 字符串数字：不 500，按服务端最新状态应用', cs.status === 200 && (await c.get(cc.code)).json.state.teams[0].fouls === 1, `status ${cs.status}`);
  const d = fresh(); const cd = await d.newGame();
  await d.apply(cd.code, { type: 'foul', team: 0 });
  const stale = await d.raw(cd.code, 999, { type: 'foul', team: 0 });
  const ds = (await d.get(cd.code)).json.state;
  ok('客户端版本过期仍应用意图且只加一次', stale.status === 200 && ds.teams[0].fouls === 2, `犯规 ${ds.teams[0].fouls}`);
  const e = fresh(); const ce = await e.newGame();
  ok('未知 action 类型 400', (await e.raw(ce.code, 0, { type: 'DROP TABLE' })).json?.error === 'invalid_action');
  const f = fresh();
  ok('GET 走写接口应 405', (await f.call('GET', 'action=create')).status === 405);
}

console.log('\n[12] 规则引擎纯函数级攻击（绕过 HTTP 直接打）');
{
  const cfg = sanitizeConfig({ periods: 2, periodMinutes: 1, foulLimit: 2 });
  const teams = sanitizeTeams([{ name: 'A', color: '#1E4FD8' }, { name: 'B', color: '#E11D2E' }]);
  const base = emptyState(cfg, teams, []);
  ok('sanitizeConfig 拒绝非法节数回落到 4', sanitizeConfig({ periods: 99 }).periods === 4);
  ok('sanitizeConfig 拒绝负时长', sanitizeConfig({ periodMinutes: -5 }).periodMinutes === 10);
  ok('sanitizeConfig 夹住 timeoutSeconds 上限', sanitizeConfig({ timeoutSeconds: 99999 }).timeoutSeconds === 180);
  ok('sanitizeTeams 非数组返回 null', sanitizeTeams('x') === null);
  ok('sanitizeTeams 同名两队返回 null', sanitizeTeams([{ name: 'A', color: '#1E4FD8' }, { name: 'A', color: '#E11D2E' }]) === null);
  // 归零瞬间的重复归零（两个大屏同时上报）
  const t = { ...base, clock: { ...base.clock, running: true, since: new Date().toISOString(), remainingMs: -1 } };
  const first = applyAction(t, { type: 'clock_zero' }, new Date().toISOString(), Date.now());
  const second = applyAction(first.state, { type: 'clock_zero' }, new Date().toISOString(), Date.now());
  ok('重复归零不应把节次推到第 3 节（2 节赛制）', second.state.clock.period === 2, `period=${second.state.clock.period}`);
  // undo 链：连续两次 undo 不应把状态倒退两步
  let st = base;
  st = applyAction(st, { type: 'score', team: 0, points: 2 }, new Date().toISOString(), Date.now()).state;
  st = applyAction(st, { type: 'score', team: 0, points: 3 }, new Date().toISOString(), Date.now()).state;
  st = applyAction(st, { type: 'undo' }, new Date().toISOString(), Date.now()).state;
  const again = applyAction(st, { type: 'undo' }, new Date().toISOString(), Date.now());
  ok('第二次撤销应报 nothing_to_undo（单层撤销）', again.error === 'nothing_to_undo', JSON.stringify(again.error));
  ok('撤销后比分回到 +2 那步之后（2 分）', st.teams[0].score === 2, `实际 ${st.teams[0].score}`);
}

console.log('\n[13] 末节胜负判定（平局才加时；分出胜负必须结束）');
{
  const { apply, get, newGame } = fresh();
  const { code } = await newGame(); // 2 节赛制
  await apply(code, { type: 'score', team: 0, points: 3 });  // Q1 3:0（分值只允许 1/2/3）
  await apply(code, { type: 'period_next' });                 // → 休息，period=2
  await apply(code, { type: 'period_next' });                 // → 提前结束休息，回到比赛计时
  const mid = (await get(code)).json.state;
  ok('休息被跳过后应回到比赛计时且仍在第 2 节', mid.clock.mode === 'game' && mid.clock.period === 2, JSON.stringify(mid.clock));
  await apply(code, { type: 'period_next' });                 // → 第 2 节结束，3:0 已分胜负
  const g = (await get(code)).json;
  ok('末节分出胜负必须结束比赛（不得无限加时）', g.status === 'finished', `status=${g.status} period=${g.state?.clock?.period}`);
  ok('胜者判定为领先方', g.state?.winner === 0, `winner=${g.state?.winner}`);
  ok('结束时落下 finishedAt 时间戳', !!g.state?.finishedAt);
  ok('结束后比分为 3:0', g.state?.teams[0].score === 3 && g.state?.teams[1].score === 0, JSON.stringify(g.state?.teams.map((t) => t.score)));
}

console.log('\n[14] 平局结束时 winner 为 null（不误判主队）');
{
  const { apply, get, newGame } = fresh();
  const { code } = await newGame();
  await apply(code, { type: 'score', team: 0, points: 3 });
  await apply(code, { type: 'score', team: 1, points: 3 });
  await apply(code, { type: 'finish' });
  const g = (await get(code)).json;
  ok('人为结束时平局 winner 为 null', g.state.winner === null, `winner=${g.state.winner}`);
  ok('平局仍标记 finished', g.status === 'finished');
}

console.log(`\n探针结果：通过 ${pass} / 攻击命中 ${fail}`);
if (bugs.length) { console.log('\n命中清单：'); for (const b of bugs) console.log('  - ' + b); }
process.exit(0);
