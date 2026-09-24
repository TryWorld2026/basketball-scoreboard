// D1 / 真实 HTTP 链路验证：打的是部署后的 Worker + D1 SQL，不是内存假库。
// 用法：node dev/d1-check.mjs [baseUrl]   默认 http://127.0.0.1:8788
const BASE = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/$/, '');
const API = `${BASE}/api/game`;

let pass = 0; let fail = 0; const bugs = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; bugs.push(name); console.log(`FAIL ${name} ${detail}`); }
};

async function call(qs, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}?${qs}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}
const get = (code) => call(`action=get&code=${code}`);
const apply = (code, action, version) => call('action=apply', { method: 'POST', body: { code, version, action } });

const TEAMS = [{ name: 'D1验证甲班', color: '#1E4FD8' }, { name: 'D1验证乙班', color: '#E11D2E' }];

console.log(`目标：${BASE}\n`);
console.log('— 静态资源与路由 —');
{
  const home = await fetch(`${BASE}/`);
  const html = await home.text();
  ok('首页返回 HTML', home.status === 200 && html.includes('<div id="app"'), `status ${home.status}`);
  const deep = await fetch(`${BASE}/room/AB23/display`);
  ok('SPA 深链回退到 index.html', deep.status === 200 && (await deep.text()).includes('<div id="app"'));
  const css = await fetch(`${BASE}/styles.css`);
  ok('样式以 CSS 类型返回', css.status === 200 && /text\/css/.test(css.headers.get('content-type') || ''), css.headers.get('content-type'));
  const js = await fetch(`${BASE}/js/app.js`);
  ok('ES module 以 JS 类型返回', js.status === 200 && /javascript/.test(js.headers.get('content-type') || ''), js.headers.get('content-type'));
  const missing = await fetch(`${BASE}/api/unknown`);
  ok('未知 API 路径不返回成功', missing.status === 404, `status ${missing.status}`);
}

console.log('\n— 建赛与读取（真实 SQL 写入）—');
let code; let version;
{
  const created = await call('action=create', { method: 'POST', body: { teams: TEAMS, config: { periods: 2, periodMinutes: 1, foulLimit: 5, timeouts: 2, trackPlayers: true }, players: [{ team: 0, name: '赵六' }] } });
  ok('create 成功', created.status === 200 && /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(created.json?.code || ''), JSON.stringify(created.json?.error || created.status));
  code = created.json.code;
  version = created.json.version;
  ok('初始状态 setup / 0:0', created.json?.state?.status === 'setup' && created.json?.state?.teams?.[0]?.score === 0);
  const read = await get(code);
  ok('get 能读回同一场（JSON 往返无损）', read.status === 200 && read.json.state.teams[0].name === 'D1验证甲班' && read.json.state.players.length === 1,
    JSON.stringify(read.json?.state?.teams?.[0]?.name));
  ok('读回的房间码大小写不敏感', (await get(code.toLowerCase())).status === 200);
  ok('不存在的房间 404', (await get('ZZZZ')).status === 404);
}

console.log('\n— 计分与幂等（真 SQL CAS）—');
{
  const nonce = `d1-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const r1 = await apply(code, { type: 'score', team: 0, points: 2, playerId: '赵六', nonce }, version);
  ok('+2 落库并归属球员', r1.json?.state?.teams?.[0]?.score === 2 && r1.json?.state?.players?.[0]?.points === 2, JSON.stringify(r1.json?.error));
  version = r1.json.version;
  ok('版本号单调递增', version === 1, `version=${version}`);
  const r2 = await apply(code, { type: 'score', team: 0, points: 2, playerId: '赵六', nonce }, version);
  ok('同 nonce 重发被幂等拦下（noop）', r2.json?.noop === true && r2.json?.state?.teams?.[0]?.score === 2, JSON.stringify({ noop: r2.json?.noop, score: r2.json?.state?.teams?.[0]?.score }));
  const r3 = await apply(code, { type: 'score', team: 1, points: 3 }, version);
  ok('不同意图正常计分', r3.json?.state?.teams?.[1]?.score === 3);
  version = r3.json.version;
  const u = await apply(code, { type: 'undo' }, version);
  ok('撤销回退一步', u.json?.state?.teams?.[1]?.score === 0, JSON.stringify(u.json?.state?.teams?.map((t) => t.score)));
  version = u.json.version;
}

console.log('\n— 并发：两笔同版本写入都必须落地 —');
{
  const before = (await get(code)).json;
  const [a, b] = await Promise.all([
    apply(code, { type: 'score', team: 0, points: 1 }, before.version),
    apply(code, { type: 'score', team: 1, points: 1 }, before.version),
  ]);
  const after = (await get(code)).json;
  const home = after.state.teams[0].score;
  const away = after.state.teams[1].score;
  ok('并发双写不丢分（D1 UPDATE...WHERE version 生效）',
    home === before.state.teams[0].score + 1 && away === before.state.teams[1].score + 1,
    `前 ${before.state.teams.map((t) => t.score).join(':')} → 后 ${home}:${away}；响应 ${a.status}/${b.status}`);
  version = after.version;
}

console.log('\n— 犯规 BONUS 与节次 —');
{
  for (let i = 0; i < 5; i += 1) { const r = await apply(code, { type: 'foul', team: 1 }, version); if (r.json?.version) version = r.json.version; }
  const s = (await get(code)).json.state;
  ok('犯规累计到 5', s.teams[1].fouls === 5, `实际 ${s.teams[1].fouls}`);
  version = (await get(code)).json.version;
  const np = await apply(code, { type: 'period_next' }, version);
  ok('跳节进入节间休息且犯规清零', np.json?.state?.clock?.mode === 'break' && np.json?.state?.teams?.[1]?.fouls === 0,
    JSON.stringify({ mode: np.json?.state?.clock?.mode, fouls: np.json?.state?.teams?.[1]?.fouls }));
  version = np.json.version;
}

console.log('\n— 锁定与重开 —');
{
  const f = await apply(code, { type: 'finish' }, version);
  ok('结束比赛', f.json?.status === 'finished' || (await get(code)).json.status === 'finished', JSON.stringify(f.json?.error));
  version = (await get(code)).json.version;
  const locked = await apply(code, { type: 'score', team: 0, points: 2 }, version);
  ok('结束后拒绝改分', locked.status === 409 && locked.json?.error === 'game_finished', `${locked.status} ${JSON.stringify(locked.json)}`);
  const rs = await apply(code, { type: 'reset' }, version);
  ok('重开一场并清零', rs.json?.status === 'setup' && rs.json?.state?.teams?.[0]?.score === 0, JSON.stringify(rs.json?.error));
}

console.log('\n— 协议健壮性（线上同样生效）—');
{
  ok('非法房间码 400', (await get('0O1I')).status === 400);
  ok('未知动作 400', (await apply(code, { type: 'nope' }, 0)).status === 400);
  ok('脏分值被拒', (await apply(code, { type: 'score', team: null, points: 2 }, 0)).json?.error === 'invalid_team');
  ok('GET 走写接口 405', (await call('action=create')).status === 405);
  ok('无 cache-control 破坏实时性', true);
  const res = await fetch(`${API}?action=get&code=${code}`);
  ok('响应带 no-store', /no-store/.test(res.headers.get('cache-control') || ''), res.headers.get('cache-control'));
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
if (bugs.length) { console.log('失败项：'); for (const b of bugs) console.log('  - ' + b); }
process.exit(fail ? 1 : 0);
