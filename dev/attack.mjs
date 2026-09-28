// 对抗式探针 —— 专打 dev/smoke.mjs 从未询问的维度。每个场景独立假库，避免残留状态伪装成缺陷。
// 运行：node dev/attack.mjs
import { handleGames, advanceDueGames } from '../worker/handler.mjs';
import { applyAction, deriveClock, emptyState, sanitizeConfig, sanitizeTeams } from '../worker/rules.mjs';
import { createRateLimiter } from '../worker/ratelimit.mjs';
import { createFakeStore } from './fake-store.mjs';
import { readFileSync } from 'node:fs';

let pass = 0; let fail = 0; const bugs = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; bugs.push(name + (detail ? ` :: ${detail}` : '')); console.log(`ATTACK ${name} ${detail}`); }
};

function fresh() {
  const store = createFakeStore();
  // 每个场景自带限流器：默认限流器是进程级共享的，
  // 一场攻击跑下来建赛次数会撞上默认上限，把脚手架问题伪装成缺陷。
  const limiters = {
    fail: createRateLimiter({ limit: 10_000, windowMs: 60_000 }),
    create: createRateLimiter({ limit: 10_000, windowMs: 60_000 }),
  };
  const controlTokens = new Map();
  const call = async (method, qs, body, extraHeaders = {}) => {
    const req = new Request(`http://s/api/game?${qs}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const res = await handleGames({ request: req, store, limiters });
    let json = null; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, json };
  };
  const raw = (code, version, action) => call('POST', 'action=apply', { code, version, action }, {
    authorization: `Bearer ${controlTokens.get(code) || ''}`,
  });
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
    controlTokens.set(c.json.code, c.json.controlToken);
    return { code: c.json.code, created: c.json, v: () => get(c.json.code) };
  };
  return { store, call, raw, apply, get, newGame };
}

console.log('\n[0] 房间只读与控制凭证分离');
{
  const { call, newGame } = fresh();
  const { code, created } = await newGame();
  const read = await call('GET', `action=get&code=${code}`);
  const controlWrite = await call('POST', 'action=apply', {
    code, version: read.json.version,
    action: { type: 'score', team: 0, points: 2 },
  }, { authorization: `Bearer ${created.controlToken || ''}` });
  const anonymousWrite = await call('POST', 'action=apply', {
    code, version: read.json.version, action: { type: 'score', team: 0, points: 2 },
  });
  ok('新比赛签发独立控制凭证', typeof created.controlToken === 'string' && created.controlToken.length >= 32,
    `字段 ${typeof created.controlToken}`);
  ok('房间码只读不能直接写入', anonymousWrite.status === 403 && anonymousWrite.json?.error === 'controller_required', JSON.stringify(anonymousWrite));
  ok('创建响应之外的公开读取不泄漏控制凭证', !('controlToken' in read.json) && !('controlTokenHash' in read.json), JSON.stringify(Object.keys(read.json)));
  ok('控制凭证允许遥控写入', controlWrite.status === 200 && controlWrite.json.state.teams[0].score === 2, JSON.stringify(controlWrite.json));
}

console.log('\n[0b] 控制凭证对抗面：伪造 / 畸形 / legacy 行 / reset 门禁');
{
  // 1) legacy 行（迁移 0002 之前创建，没有 controller_hash）必须 fail closed
  const { call, store } = fresh();
  const teams = sanitizeTeams([{ name: 'A', color: '#1E4FD8' }, { name: 'B', color: '#E11D2E' }]);
  const st = emptyState(sanitizeConfig({}), teams, []);
  const nowIso = new Date().toISOString();
  store._rows.set('LEG2', { code: 'LEG2', status: 'live', version: 0, state: st, created_at: nowIso, updated_at: nowIso });
  const legacyWrite = await call('POST', 'action=apply', { code: 'LEG2', version: 0, action: { type: 'score', team: 0, points: 2 } });
  ok('legacy 行（无 controller_hash）拒绝写入', legacyWrite.status === 403 && legacyWrite.json?.error === 'controller_required', JSON.stringify(legacyWrite));
  ok('legacy 行仍可公开读取（数据卡链接不沉）', (await call('GET', 'action=get&code=LEG2')).status === 200);

  // 2) 错凭证 / 畸形凭证 / 非 Bearer 方案：都必须是 403 而不是 500 或放行
  const { call: c2, newGame } = fresh();
  const { code, created } = await newGame();
  const wrong = await c2('POST', 'action=apply', { code, version: 0, action: { type: 'score', team: 0, points: 2 } }, { authorization: `Bearer ${'f'.repeat(64)}` });
  ok('错误凭证 403', wrong.status === 403 && wrong.json?.error === 'controller_required', JSON.stringify(wrong));
  const malformed = await c2('POST', 'action=apply', { code, version: 0, action: { type: 'score', team: 0, points: 2 } }, { authorization: 'Bearer not-a-real-token' });
  ok('畸形凭证 403（不 500）', malformed.status === 403 && malformed.json?.error === 'controller_required', JSON.stringify(malformed));
  const basic = await c2('POST', 'action=apply', { code, version: 0, action: { type: 'score', team: 0, points: 2 } }, { authorization: `Basic ${created.controlToken}` });
  ok('非 Bearer 方案 403', basic.status === 403 && basic.json?.error === 'controller_required', JSON.stringify(basic));
  ok('失败凭证不改变比分', (await c2('GET', `action=get&code=${code}`)).json.state.teams[0].score === 0);

  // 3) reset 只能重开已结束的比赛（进行中擦库不可逆，服务端是门禁）
  const { apply, newGame: ng3 } = fresh();
  const g3 = await ng3();
  const liveReset = await apply(g3.code, { type: 'reset' });
  ok('进行中 reset 被拒（409 reset_not_allowed）', liveReset.status === 409 && liveReset.json?.error === 'reset_not_allowed', JSON.stringify(liveReset));
  await apply(g3.code, { type: 'finish' });
  const doneReset = await apply(g3.code, { type: 'reset' });
  ok('结束后 reset 放行', !doneReset.json?.error && doneReset.json.status === 'setup', JSON.stringify(doneReset.json?.error));
}

// 直接改库（模拟时钟耗尽等外部事件），返回新版本
function poke(store, code, fn) { const row = store._rows.get(code); fn(row); return row; }

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

console.log('\n[1b] 幂等的硬边界：补发窗口不限于最近 30 个（durable receipts）');
{
  // 旧实现把 nonce 塞进 state 只留最近 30 条：响应丢失后，若期间另有 30+ 次写入，
  // 补发就被挤出窗口，同一意图记两次分。双记分员 + 弱网重连完全能凑出这个间隔。
  const { raw, get, newGame } = fresh();
  const { code } = await newGame();
  const lost = 'lost-response-nonce-0001';
  await raw(code, (await get(code)).json.version, { type: 'score', team: 0, points: 2, nonce: lost });
  for (let i = 0; i < 40; i += 1) {
    await raw(code, (await get(code)).json.version, { type: 'foul', team: i % 2, nonce: `busy-${i}-${Date.now()}` });
  }
  const beforeReplay = (await get(code)).json.version;
  const replay = await raw(code, beforeReplay, { type: 'score', team: 0, points: 2, nonce: lost });
  const s = (await get(code)).json.state;
  ok('补发窗口超过 30 次后续写入后仍只计一次', s.teams[0].score === 2, `实际 ${s.teams[0].score}`);
  ok('迟到补发被识别为 noop 且不涨版本', replay.json?.noop === true && replay.json?.version === beforeReplay, JSON.stringify({ noop: replay.json?.noop, v: replay.json?.version, before: beforeReplay }));
}

console.log('\n[1c] 带 nonce 的无变化动作：不写库、不涨版本');
{
  // 无变化动作若为了"记下 nonce"而写库，会白白涨版本、还把无意义冲突推给另一端
  const { raw, get, newGame } = fresh();
  const { code } = await newGame();
  await raw(code, (await get(code)).json.version, { type: 'clock_start' });
  const before = (await get(code)).json;
  const early = await raw(code, before.version, { type: 'clock_zero', nonce: 'early-zero-0001' });
  const after = (await get(code)).json;
  ok('时钟没归零时带 nonce 的 clock_zero 不改状态不涨版本', after.version === before.version && after.state.clock.period === before.state.clock.period,
    `v ${before.version} → ${after.version}`);
  ok('无变化动作响应标记 noop', early.json?.noop === true, JSON.stringify({ noop: early.json?.noop }));
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
  // 数组能穿透 JSON 且 String(['张三']) === '张三' —— 这是能真正伪装成球员名的脏数据
  const t4 = await apply(code, { type: 'score', team: 0, points: 2, playerId: ['张三'] });
  ok('playerId 传数组应被拒（不被 String() 静默吞成球员名）', t4.json?.error === 'invalid_player', `实际 ${JSON.stringify(t4.json)}`);
  const t5 = await apply(code, { type: 'score', team: 0, points: 2, playerId: 42 });
  ok('playerId 传数字应被拒', t5.json?.error === 'invalid_player', `实际 ${JSON.stringify(t5.json)}`);
  const s4 = (await get(code)).json.state;
  ok('脏 playerId 不计分', s4.players[0].points === 0, `张三=${s4.players[0].points}`);
  const t6 = await apply(code, { type: 'score', team: 0, points: 2, playerId: '张三' });
  ok('合法 playerId 正常计分', !t6.json?.error && (await get(code)).json.state.players[0].points === 2, JSON.stringify(t6.json?.error));
}

console.log('\n[6] 暂停与犯规的边界');
{
  const { apply, get, newGame, store } = fresh();
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
  poke(store, code, (row) => { row.state.clock.remainingMs = -10; row.state.clock.running = true; row.state.clock.since = new Date().toISOString(); });
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
  const { apply, get, newGame, store } = fresh();
  const { code } = await newGame();
  for (let i = 0; i < 400; i += 1) await apply(code, { type: 'score', team: i % 2, points: (i % 3) + 1 });
  const raw = store._rows.get(code);
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

console.log('\n[15] 24 秒进攻时限全行为链（规则层有、UI 有入口、这里锁行为）');
{
  const cfg = {
    periods: 2, periodMinutes: 1, foulLimit: 2, timeouts: 1, trackPlayers: true,
    breakSeconds: 20, timeoutSeconds: 30, shotClock: true, shotClockSeconds: 24,
  };
  const { apply, get, newGame } = fresh();
  const { code } = await newGame({ config: cfg });
  const s0 = (await get(code)).json.state;
  ok('开赛前 24 秒停表且归满', s0.shot.running === false && s0.shot.remainingMs === 24000, JSON.stringify(s0.shot));
  await apply(code, { type: 'clock_start' });
  ok('开球后 24 秒开始走', (await get(code)).json.state.shot.running === true);
  await apply(code, { type: 'score', team: 0, points: 2 });
  const s1 = (await get(code)).json.state;
  ok('进球后 24 秒归满且继续走（不冻结）',
    s1.shot.running === true && s1.shot.remainingMs === 24000 && s1.clock.running === true,
    JSON.stringify(s1.shot));
  await apply(code, { type: 'clock_stop' });
  ok('比赛停表时 24 秒同步停表', (await get(code)).json.state.shot.running === false);
  await apply(code, { type: 'clock_start' });
  ok('重新开表 24 秒恢复走动', (await get(code)).json.state.shot.running === true);
  const rs = await apply(code, { type: 'shot_reset' });
  ok('手动重置 24 秒生效', !rs.json.error && rs.json.state.shot.remainingMs === 24000, JSON.stringify(rs.json.error));
  const p = await apply(code, { type: 'possession', team: 1 });
  ok('手动交换球权生效', !p.json.error && p.json.state.possession === 1, JSON.stringify(p.json.error));
  ok('非法球队交换球权被拒', (await apply(code, { type: 'possession', team: 2 })).json?.error === 'invalid_team');
  await apply(code, { type: 'timeout', team: 0 });
  ok('暂停时 24 秒停表', (await get(code)).json.state.shot.running === false);
  const b = fresh();
  const { code: code2 } = await b.newGame();
  ok('未开启 24 秒时重置被拒', (await b.apply(code2, { type: 'shot_reset' })).json?.error === 'shot_clock_off');
}

console.log('\n[16] 撤销不吞停表时间（时钟冻结在动作发生那一刻）');
{
  const { apply, get, newGame } = fresh();
  const { code } = await newGame();
  await apply(code, { type: 'clock_start' });
  await new Promise((r) => setTimeout(r, 60));
  await apply(code, { type: 'clock_stop' });
  const stopped = (await get(code)).json.state.clock.remainingMs;
  await new Promise((r) => setTimeout(r, 120)); // 停表期间，时钟本不该走
  const u = await apply(code, { type: 'undo' });
  const c = u.json.state.clock;
  ok('撤销停表后时钟冻结在停表那一刻（停表时间不被消耗）',
    c.running === false && Math.abs(c.remainingMs - stopped) <= 2,
    `停表值=${stopped} 撤销后=${c.remainingMs}`);
  ok('撤销后不自动恢复走表（由记分员显式开始）', c.running === false);
  await apply(code, { type: 'clock_start' });
  await new Promise((r) => setTimeout(r, 40));
  const sc = await apply(code, { type: 'score', team: 0, points: 2 });
  // 时钟在跑时 state 里的 remainingMs 字段并不更新，屏幕上看的是 derive 出来的值
  const shownAtScore = deriveClock(sc.json.state, Date.parse(sc.json.serverTime)).remainingMs;
  await new Promise((r) => setTimeout(r, 60));
  const u2 = await apply(code, { type: 'undo' });
  ok('撤销进球同样冻结时钟（不吞也不偷跑）',
    u2.json.state.clock.running === false && Math.abs(u2.json.state.clock.remainingMs - shownAtScore) <= 10,
    `进球时屏幕值=${shownAtScore} 撤销后=${u2.json.state.clock.remainingMs}`);
  ok('撤销进球的比分仍回退', (await get(code)).json.state.teams[0].score === 0);
}

console.log('\n[17] 限流：枚举房间码有成本，正常使用无感');
{
  const store = createFakeStore();
  const limiters = {
    fail: createRateLimiter({ limit: 3, windowMs: 60_000 }),
    create: createRateLimiter({ limit: 2, windowMs: 60_000 }),
  };
  const call = async (method, qs, body) => {
    const req = new Request(`http://s/api/game?${qs}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await handleGames({ request: req, store, limiters });
    return { status: res.status, json: await res.json(), headers: res.headers };
  };
  const teams = [{ name: 'A', color: '#1E4FD8' }, { name: 'B', color: '#E11D2E' }];
  const miss = () => call('GET', 'action=get&code=ZZZZ');
  ok('未命中前 3 次正常 404', (await miss()).status === 404 && (await miss()).status === 404 && (await miss()).status === 404);
  const blocked = await miss();
  ok('第 4 次未命中被限流 429', blocked.status === 429 && blocked.json.error === 'too_many_requests', JSON.stringify(blocked.json));
  ok('429 带 retry-after 头', !!blocked.headers?.get?.('retry-after'));
  const c = await call('POST', 'action=create', { teams, config: {} });
  ok('命中房间不受失败限流影响', (await call('GET', `action=get&code=${c.json.code}`)).status === 200);
  await call('POST', 'action=create', { teams, config: {} });
  const third = await call('POST', 'action=create', { teams, config: {} });
  ok('建赛限流生效（每小时上限）', third.status === 429 && third.json.error === 'too_many_requests', JSON.stringify(third.json));
  const ok2 = await call('GET', `action=get&code=${c.json.code}`);
  ok('限流不影响正常读取', ok2.status === 200);
}

console.log('\n[18] 半途放弃的局在建赛时被清理（已结束的永久保留）');
{
  const store = createFakeStore();
  const limiters = {
    fail: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    create: createRateLimiter({ limit: 100, windowMs: 60_000 }),
  };
  const call = async (method, qs, body) => {
    const req = new Request(`http://s/api/game?${qs}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await handleGames({ request: req, store, limiters });
    return { status: res.status, json: await res.json() };
  };
  const teams = sanitizeTeams([{ name: 'A', color: '#1E4FD8' }, { name: 'B', color: '#E11D2E' }]);
  const st = emptyState(sanitizeConfig({ periods: 2 }), teams, []);
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  store._rows.set('AAAA', { code: 'AAAA', status: 'live', version: 3, state: st, created_at: old, updated_at: old });
  store._rows.set('BBBB', { code: 'BBBB', status: 'finished', version: 3, state: st, created_at: old, updated_at: old });
  store._rows.set('CCCC', { code: 'CCCC', status: 'setup', version: 0, state: st, created_at: old, updated_at: old });
  await call('POST', 'action=create', { teams, config: {} });
  ok('8 天没写入的 live 房间被清', !store._rows.has('AAAA'));
  ok('已结束的房间永久保留', store._rows.has('BBBB'));
  ok('筹建超 24h 的房间照样被清', !store._rows.has('CCCC'));
}

console.log('\n[19] 操作审计：每一次落地留痕，吵架时能回溯');
{
  const { call, raw, apply, get, newGame, store } = fresh();
  const { code, created } = await newGame();
  const logOf = async () => (await call('GET', `action=log&code=${code}`)).json.entries;
  const put = async (action) => raw(code, (await get(code)).json.version, action);

  ok('初始没有任何审计记录', (await logOf()).length === 0);
  await put({ type: 'score', team: 0, points: 2, nonce: 'audit-nonce-0001' });
  const first = (await logOf())[0];
  ok('得分落地后审计留痕（前后比分 + 当时时钟）',
    !!first && first.before_score === '0:0' && first.after_score === '2:0' && typeof first.clock_ms === 'number',
    JSON.stringify(first));
  ok('actor 是凭证指纹（8 位十六进制，不是明文令牌）',
    /^[0-9a-f]{8}$/.test(first?.actor) && !created.controlToken.includes(first.actor),
    `actor=${first?.actor}`);
  ok('审计原样保留意图（含 nonce，可和补发对账）', JSON.parse(first.action).nonce === 'audit-nonce-0001');

  await put({ type: 'score', team: 0, points: 2, nonce: 'audit-nonce-0001' });
  ok('重复补发被幂等拦下，不写第二条审计', (await logOf()).length === 1);
  await put({ type: 'clock_zero', nonce: 'audit-zero-nonce1' });
  ok('时钟没归零的 clock_zero 无变化，不写审计', (await logOf()).length === 1);

  await apply(code, { type: 'period_next' });               // → 节间休息（这条本身也落地，记审计）
  await apply(code, { type: 'score', team: 1, points: 3 }); // 休息期记分，被规则拒
  ok('被规则拒绝的动作不留审计（只记真落地的）', (await logOf()).length === 2, JSON.stringify((await logOf()).length));

  await apply(code, { type: 'period_next' });               // 提前结束休息
  await apply(code, { type: 'foul', team: 1 });
  const entries = await logOf();
  ok('审计按落地顺序排列（最新在前）',
    entries.length === 4 && entries[0].seq > entries[1].seq && entries[1].seq > entries[2].seq && entries[2].seq > entries[3].seq,
    JSON.stringify(entries.map((e) => e.seq)));

  await apply(code, { type: 'finish' });
  const beforeReset = (await logOf()).length;
  await apply(code, { type: 'reset' });
  const afterReset = await logOf();
  ok('reset 后旧日志仍在（终局被擦掉这件事必须可查）', afterReset.length === beforeReset + 1,
    `${beforeReset} → ${afterReset.length}`);
  ok('reset 本身留痕且比分回到 0:0', afterReset[0].after_score === '0:0', JSON.stringify(afterReset[0]));

  ok('不存在房间的 log 请求 404（不返回空列表假装没事）', (await call('GET', 'action=log&code=ZZZZ')).status === 404);
  ok('非法房间码的 log 请求 400', (await call('GET', 'action=log&code=0O1I')).status === 400);
  ok('log 响应不泄漏控制凭证', !JSON.stringify(await call('GET', `action=log&code=${code}`)).includes(created.controlToken));
  ok('log 只接受 GET（POST 405）', (await call('POST', `action=log&code=${code}`)).status === 405);

  // 级联清理：比赛行没了，审计一起走——不留永驻的孤儿记录
  const teams = sanitizeTeams([{ name: 'A', color: '#1E4FD8' }, { name: 'B', color: '#E11D2E' }]);
  const st = emptyState(sanitizeConfig({ periods: 2 }), teams, []);
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  store._rows.set('OLD1', { code: 'OLD1', status: 'setup', version: 1, state: st, created_at: old, updated_at: old });
  store._logs.set('OLD1', [{ seq: 1, actor: 'abcd1234', action: '{"type":"score"}', before_score: '0:0', after_score: '2:0', clock_ms: 60000, at: old }]);
  await call('POST', 'action=create', { teams, config: {} });
  ok('半途放弃局清理时审计一起删（不留孤儿记录）', !store._logs.has('OLD1') && !store._rows.has('OLD1'));
}

console.log('\n[20] Worker 入口：安全响应头与路由（真实 fetch 形状）');
{
  const worker = (await import('../worker/index.js')).default;
  // 最小 D1 桩：只走 getGame 的 404 分支；静态资源给个假 HTML
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      }),
    }),
  };
  const env = { DB: db, ASSETS: { fetch: async () => new Response('<div id="app">', { status: 200, headers: { 'content-type': 'text/html' } }) } };
  const csp = (res) => res.headers.get('content-security-policy') || '';

  const api = await worker.fetch(new Request('http://s/api/game?action=get&code=ZZZZ'), env);
  ok('API 响应带 frame-ancestors none（防控制端被 iframe 诱导点击）', csp(api).includes("frame-ancestors 'none'"), csp(api) || '缺失');
  ok('API 响应带 nosniff', api.headers.get('x-content-type-options') === 'nosniff', api.headers.get('x-content-type-options') || '缺失');

  const page = await worker.fetch(new Request('http://s/room/AB23/display'), env);
  ok('静态页响应也带安全头（大屏/控制端都不被嵌入）', csp(page).includes("frame-ancestors 'none'"), csp(page) || '缺失');

  const noDb = await worker.fetch(new Request('http://s/api/game?action=get&code=AB23'), { ASSETS: env.ASSETS });
  ok('没绑 D1 时 API 503 且同样带安全头', noDb.status === 503 && csp(noDb).includes("frame-ancestors 'none'"), `${noDb.status} ${csp(noDb)}`);

  // 部署配置：静态请求也必须进 Worker，否则 HTML 页拿不到安全头。
  // 这不是理论担忧——上线后实测过：run_worker_first 只圈 /api/* 时，
  // 大屏/控制端/房间页的响应里 frame-ancestors 整个缺失（Assets 直连，
  // Worker 的包装逻辑根本没被调用），而 API 响应是好的，极具迷惑性。
  const wranglerRaw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    // 容忍尾逗号：否则配置里少一行就让 JSON.parse 抛异常——探针「崩了」
    // 和「变红」是两回事，崩了会被变异门禁误判成存活（实测踩过）
    .replace(/,(\s*[}\]])/g, '$1');
  const assetsCfg = JSON.parse(wranglerRaw).assets || {};
  ok('静态请求全部走 Worker（HTML 页才拿得到 frame-ancestors）',
    assetsCfg.run_worker_first === true, `run_worker_first=${JSON.stringify(assetsCfg.run_worker_first)}`);
  // 绑定名必须显式声明且与 index.js 里用的一致：上线实测过——没声明时
  // env.ASSETS 是 undefined，`env.ASSETS.fetch` 直接 TypeError，全站 500。
  // （攻击网的桩永远注得出 ASSETS，抓不到这类「配置与代码对不上」。）
  ok('assets 绑定显式声明为 ASSETS（与 index.js 读取的一致）',
    assetsCfg.binding === 'ASSETS', `binding=${JSON.stringify(assetsCfg.binding)}`);
  const indexSrc = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  ok('index.js 只从 env.ASSETS 取静态资源', /env\.ASSETS\.fetch/.test(indexSrc) && !/env\.ASSETS2|env\.assets\b/.test(indexSrc));
}

console.log('\n[21] 服务端到点推进：记分员手机不在场，比赛也不能卡在 00:00');
{
  const teams = sanitizeTeams([{ name: 'A', color: '#1E4FD8' }, { name: 'B', color: '#E11D2E' }]);
  const seed = (status, clockPatch) => {
    const st = emptyState(sanitizeConfig({ periods: 2, periodMinutes: 1, breakSeconds: 20 }), teams, []);
    st.status = status;
    st.clock = { ...st.clock, ...clockPatch };
    return st;
  };
  const old = new Date(Date.now() - 3600_000).toISOString();
  const rowOf = (store, code, state, version) => {
    store._rows.set(code, { code, status: 'live', version, state, created_at: old, updated_at: old });
    return store._rows.get(code);
  };

  { // 比赛时钟归零 → 进节间休息
    const store = createFakeStore();
    rowOf(store, 'ZERO', seed('live', { running: true, since: new Date(Date.now() - 120_000).toISOString(), remainingMs: 60_000 }), 4);
    const r = await advanceDueGames(store, Date.now());
    const row = store._rows.get('ZERO');
    ok('到点的比赛被 cron 推进到节间休息', r.advanced === 1 && row.state.clock.mode === 'break' && row.version === 5,
      JSON.stringify({ advanced: r.advanced, mode: row.state.clock.mode, v: row.version }));
    const log = (await store.getLog('ZERO')).entries;
    ok('cron 推进也落审计且 actor 可区分', log[0]?.actor === 'cron' && log[0].action.includes('server-cron'), JSON.stringify(log[0]));
  }
  { // 没到点：不写库、不涨版本、不落审计
    const store = createFakeStore();
    rowOf(store, 'RUN1', seed('live', { running: true, since: new Date().toISOString(), remainingMs: 600_000 }), 7);
    const r = await advanceDueGames(store, Date.now());
    ok('没到点的比赛不被 cron 写库（不涨版本）',
      r.advanced === 0 && store._rows.get('RUN1').version === 7 && (await store.getLog('RUN1')).entries.length === 0,
      JSON.stringify({ advanced: r.advanced, v: store._rows.get('RUN1').version }));
  }
  { // 停表 / 已结束：都不推进
    const store = createFakeStore();
    rowOf(store, 'STOP', seed('live', { running: false, remainingMs: 0 }), 2);
    rowOf(store, 'DONE', seed('finished', { running: true, since: new Date(Date.now() - 120_000).toISOString(), remainingMs: 60_000 }), 9);
    store._rows.get('DONE').status = 'finished';
    const r = await advanceDueGames(store, Date.now());
    ok('停表的比赛不推进（记分员主动停的表）', r.advanced === 0 && store._rows.get('STOP').version === 2);
    ok('已结束的比赛不在推进名单里', store._rows.get('DONE').version === 9);
  }
  { // 和记分员撞车：版本已被抢先推过 → 不重复进节
    const store = createFakeStore();
    const raced = rowOf(store, 'RACE', seed('live', { running: true, since: new Date(Date.now() - 120_000).toISOString(), remainingMs: 60_000 }), 3);
    raced.version = 4; // 记分员刚刚落地了一步
    raced.state.clock = { ...raced.state.clock, period: 2, mode: 'break', running: true, since: new Date().toISOString(), remainingMs: 20_000 };
    const r = await advanceDueGames(store, Date.now());
    ok('和记分员撞车时不重复进节（CAS 保证只有一个生效）',
      r.advanced === 0 && store._rows.get('RACE').state.clock.period === 2,
      JSON.stringify({ advanced: r.advanced, period: store._rows.get('RACE').state.clock.period }));
  }
  { // 暂停倒计时到点 → 收回比赛时钟
    const store = createFakeStore();
    rowOf(store, 'TOUT', seed('live', { mode: 'timeout', running: true, since: new Date(Date.now() - 60_000).toISOString(), remainingMs: 30_000, gameRemainingMs: 55_000, timeoutTeam: 0 }), 5);
    const r = await advanceDueGames(store, Date.now());
    const c = store._rows.get('TOUT').state.clock;
    ok('暂停倒计时到点被 cron 收回（比赛时钟回到停表值）',
      r.advanced === 1 && c.mode === 'game' && c.remainingMs === 55_000 && c.timeoutTeam === null,
      JSON.stringify({ mode: c.mode, remainingMs: c.remainingMs }));
  }
  { // 节间休息到点 → 摆好下一节，停表等开始（开表永远是记分员的权利）
    const store = createFakeStore();
    rowOf(store, 'BRK0', seed('live', { mode: 'break', period: 2, running: true, since: new Date(Date.now() - 30_000).toISOString(), remainingMs: 20_000, gameRemainingMs: 60_000 }), 6);
    const r = await advanceDueGames(store, Date.now());
    const c = store._rows.get('BRK0').state.clock;
    ok('节间休息到点被 cron 摆成下一节（停表等开始，不自动开表）',
      r.advanced === 1 && c.mode === 'game' && c.running === false && c.remainingMs === 60_000,
      JSON.stringify({ mode: c.mode, running: c.running, remainingMs: c.remainingMs }));
  }
}

console.log('\n[22] 控制权补发：创建比赛的手机丢了，凭找回码换发');
{
  const { call, raw, get, newGame } = fresh();
  const { code, created } = await newGame();
  const RECOVERY_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;

  ok('建赛响应带回 8 位找回码（明文只出现这一次）', RECOVERY_RE.test(created.recoveryCode || ''), String(created.recoveryCode));
  const read = await call('GET', `action=get&code=${code}`);
  ok('公开读取不泄漏找回码与控制令牌',
    !JSON.stringify(read.json).includes(created.recoveryCode) && !JSON.stringify(read.json).includes(created.controlToken));

  await raw(code, read.json.version, { type: 'score', team: 0, points: 2 });
  const before = (await get(code)).json;

  const wrong = await call('POST', 'action=recover', { code, recovery: 'AAAA-BBBB' });
  ok('错误找回码 403 且不改变任何状态', wrong.status === 403 && wrong.json?.error === 'recovery_failed', JSON.stringify(wrong.json));
  ok('失败补发不泄漏新令牌', !wrong.json?.controlToken);
  const malformed = await call('POST', 'action=recover', { code, recovery: 'nope' });
  ok('畸形找回码 400', malformed.status === 400 && malformed.json?.error === 'invalid_recovery', JSON.stringify(malformed.json));
  ok('不存在房间的补发 404', (await call('POST', 'action=recover', { code: 'ZZZZ', recovery: created.recoveryCode })).status === 404);
  ok('GET 走补发接口 405', (await call('GET', `action=recover&code=${code}`)).status === 405);

  const done = await call('POST', 'action=recover', { code, recovery: created.recoveryCode });
  ok('正确找回码换发成功（返回新令牌 + 新找回码）',
    done.status === 200 && typeof done.json?.controlToken === 'string'
      && done.json.controlToken !== created.controlToken && RECOVERY_RE.test(done.json?.recoveryCode || ''),
    JSON.stringify({ status: done.status, err: done.json?.error }));
  ok('补发不碰比赛状态（比分原样，版本 +1）',
    done.json?.state?.teams?.[0]?.score === 2 && done.json?.version === before.version + 1,
    JSON.stringify({ score: done.json?.state?.teams?.[0]?.score, v: done.json?.version }));

  const oldWrite = await call('POST', 'action=apply', { code, version: done.json.version, action: { type: 'score', team: 1, points: 2 } }, { authorization: `Bearer ${created.controlToken}` });
  ok('旧令牌在补发后作废（403）', oldWrite.status === 403 && oldWrite.json?.error === 'controller_required', JSON.stringify(oldWrite.json));
  const newWrite = await call('POST', 'action=apply', { code, version: done.json.version, action: { type: 'score', team: 1, points: 2 } }, { authorization: `Bearer ${done.json.controlToken}` });
  ok('新令牌能写', newWrite.status === 200 && newWrite.json?.state?.teams?.[1]?.score === 2, JSON.stringify(newWrite.json));

  const replayOld = await call('POST', 'action=recover', { code, recovery: created.recoveryCode });
  ok('旧找回码补发后立即失效（一次性）', replayOld.status === 403 && replayOld.json?.error === 'recovery_failed', JSON.stringify(replayOld.json));
  const again = await call('POST', 'action=recover', { code, recovery: done.json.recoveryCode });
  ok('新找回码可再次补发（轮换后救援能力不断）', again.status === 200 && typeof again.json?.controlToken === 'string',
    JSON.stringify({ status: again.status, err: again.json?.error }));

  const log = (await call('GET', `action=log&code=${code}`)).json.entries;
  const recoveries = log.filter((e) => e.actor === 'recovery');
  ok('补发落审计（actor=recovery，可查谁换了锁）', recoveries.length === 2 && recoveries[0].action.includes('recovery-code'),
    JSON.stringify(recoveries.map((e) => e.actor)));

  // 限流：找回码是第二个 Secret，不能白试
  {
    const store = createFakeStore();
    const limiters = { fail: createRateLimiter({ limit: 2, windowMs: 60_000 }), create: createRateLimiter({ limit: 10, windowMs: 60_000 }) };
    const call2 = async (method, qs, body) => {
      const req = new Request(`http://s/api/game?${qs}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const res = await handleGames({ request: req, store, limiters });
      return { status: res.status, json: await res.json() };
    };
    const c = await call2('POST', 'action=create', { teams: [{ name: 'A', color: '#1E4FD8' }, { name: 'B', color: '#E11D2E' }], config: {} });
    await call2('POST', 'action=recover', { code: c.json.code, recovery: 'AAAA-BBBB' });
    await call2('POST', 'action=recover', { code: c.json.code, recovery: 'AAAA-BBBB' });
    const third = await call2('POST', 'action=recover', { code: c.json.code, recovery: 'AAAA-BBBB' });
    ok('连续错码达到上限被限流 429（枚举有成本）', third.status === 429 && third.json.error === 'too_many_requests', JSON.stringify(third.json));
  }
}

console.log(`\n探针结果：通过 ${pass} / 攻击命中 ${fail}`);
if (bugs.length) { console.log('\n命中清单：'); for (const b of bugs) console.log('  - ' + b); }
// 探针变红必须让 CI 失败——否则这张网只是控制台输出，不构成门禁
process.exit(fail ? 1 : 0);
