// 主流程冒烟测试：直接驱动 handler + 内存假库，验证规则引擎与写路径。
// 运行：node dev/smoke.mjs
import { handleGames } from '../functions/handler.mjs';
import { createFakeSupabase } from './fake-supabase.mjs';

const supabase = createFakeSupabase();
let pass = 0; let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name} ${extra}`); }
};

async function call(method, qs, body) {
  const req = new Request(`http://site/functions/v1/app?${qs}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handleGames({ request: req, supabase });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}
const apply = (code, version, action) => call('POST', 'action=apply', { code, version, action });

const base = {
  teams: [{ name: '计算机1班', color: '#1E4FD8' }, { name: '软件工程2班', color: '#E11D2E' }],
  config: { periods: 2, periodMinutes: 10, foulLimit: 5, timeouts: 3, trackPlayers: true },
  players: [{ team: 0, name: '张伟' }, { team: 1, name: '李强' }],
};

console.log('— 创建与读取 —');
const created = await call('POST', 'action=create', base);
check('create 返回 200', created.status === 200, JSON.stringify(created.json));
const code = created.json?.code || '';
check('房间码 4 位合法', /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(code), code);
check('初始比分 0:0', created.json?.state?.teams?.[0]?.score === 0);
let version = created.json?.version ?? 0;

const got = await call('GET', `action=get&code=${code}`);
check('get 返回同房间', got.status === 200 && got.json?.code === code);
const bad = await call('GET', 'action=get&code=ZZZZ');
check('不存在房间 404', bad.status === 404 && bad.json?.error === 'game_not_found');
check('非法房间码 400', (await call('GET', 'action=get&code=0O1I')).status === 400);

console.log('— 比分与撤销 —');
let r = await apply(code, version, { type: 'score', team: 0, points: 2, playerId: '张伟' });
version = r.json.version;
check('+2 生效', r.json.state.teams[0].score === 2 && r.json.state.players[0].points === 2, JSON.stringify(r.json?.state?.teams?.[0]));
check('得分后状态 live', r.json.status === 'live');
check('首节流水 +2', r.json.state.teams[0].periodScores[0] === 2);
r = await apply(code, version, { type: 'undo' });
version = r.json.version;
check('撤销回退比分', r.json.state.teams[0].score === 0);
check('无可撤销时报错', (await apply(code, version, { type: 'undo' })).json?.error === 'nothing_to_undo');

console.log('— 犯规与 BONUS —');
for (let i = 0; i < 5; i += 1) { r = await apply(code, version, { type: 'foul', team: 1 }); version = r.json.version; }
check('客队犯规累计 5', r.json.state.teams[1].fouls === 5);

console.log('— 时钟 —');
r = await apply(code, version, { type: 'clock_start' }); version = r.json.version;
check('开始计时 running', r.json.state.clock.running === true);
r = await apply(code, version, { type: 'clock_stop' }); version = r.json.version;
check('停止计时', r.json.state.clock.running === false);

console.log('— 归零自动进节（直接改库模拟时钟耗尽）—');
const row = supabase._store.get(code);
row.state.clock.running = true;
row.state.clock.since = new Date().toISOString();
row.state.clock.remainingMs = -10;
r = await apply(code, row.version, { type: 'clock_zero' }); version = r.json.version;
check('归零后进入节间', r.json.state.clock.mode === 'break' && r.json.state.clock.period === 2, JSON.stringify(r.json?.state?.clock));
check('新一节犯规清零', r.json.state.teams[1].fouls === 0);
// 节间归零 → 回比赛模式
const row2 = supabase._store.get(code);
row2.state.clock.remainingMs = -10;
r = await apply(code, row2.version, { type: 'clock_zero' }); version = r.json.version;
check('节间结束回比赛计时', r.json.state.clock.mode === 'game' && r.json.state.clock.running === false);

console.log('— 末节平局自动加时 —');
const row3 = supabase._store.get(code);
row3.state.teams[0].score = 30; row3.state.teams[1].score = 30;
row3.state.clock.period = 2; row3.state.clock.mode = 'game'; row3.state.clock.running = true;
row3.state.clock.since = new Date().toISOString(); row3.state.clock.remainingMs = -10;
r = await apply(code, row3.version, { type: 'clock_zero' }); version = r.json.version;
check('平局进加时', r.json.state.clock.period === 3 && r.json.status === 'live', JSON.stringify(r.json?.state?.clock));

console.log('— 暂停 —');
const row4 = supabase._store.get(code);
row4.state.clock.mode = 'game'; row4.state.clock.running = false;
r = await apply(code, row4.version, { type: 'timeout', team: 0 }); version = r.json.version;
check('暂停倒计时启动', r.json.state.clock.mode === 'timeout' && r.json.state.teams[0].timeoutsLeft === 2);

console.log('— 结束与锁定 —');
r = await apply(code, version, { type: 'finish' }); version = r.json.version;
check('结束状态 finished', r.json.status === 'finished');
const locked = await apply(code, version, { type: 'score', team: 0, points: 3 });
check('结束后拒绝改分', locked.status === 409 && locked.json?.error === 'game_finished');
r = await apply(code, version, { type: 'reset' }); version = r.json.version;
check('重开回到 setup 且清零', r.json.status === 'setup' && r.json.state.teams[0].score === 0);

console.log('— 参数校验 —');
check('缺队名 400', (await call('POST', 'action=create', { ...base, teams: [{ name: '', color: '#1E4FD8' }, { name: 'B', color: '#E11D2E' }] })).status === 400);
check('未知动作 400', (await apply(code, version, { type: 'teleport' })).json?.error === 'invalid_action');
check('非法分值 400', (await apply(code, version, { type: 'score', team: 0, points: 4 })).json?.error === 'invalid_points');
check('未知路由 404', (await call('GET', 'action=nope')).status === 404);
check('GET 走写接口 405', (await call('GET', 'action=create')).status === 405);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
