// 前端仓库层测试：GameStore 的断网队列、按序补发、乱序响应丢弃、冲突自动刷新。
// store.js 只依赖 fetch / document / localStorage / crypto，全部打桩即可在 Node 里跑，
// 不需要 jsdom。运行：node dev/store.mjs
import { GameStore } from '../public/js/store.js';

// ---------- 最小浏览器桩 ----------
const docListeners = new Map();
globalThis.document = {
  hidden: false,
  addEventListener: (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, new Set());
    docListeners.get(type).add(fn);
  },
  removeEventListener: (type, fn) => docListeners.get(type)?.delete(fn),
};
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name} ${detail}`); }
};

// ---------- 可控假服务器 ----------
function fakeServer() {
  const calls = [];
  let state = {
    status: 'setup', version: 0,
    clock: { running: false }, teams: [{ score: 0 }, { score: 0 }],
  };
  let failNext = 0;      // 接下来 N 次 fetch 直接网络错误
  let failApplyOnce = 0; // 接下来 N 次 apply 返回 409 冲突
  let clock = 0;

  const respond = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

  globalThis.fetch = async (path, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path, body, headers: opts.headers });
    if (failNext > 0) { failNext -= 1; throw new TypeError('fetch failed'); }
    const url = new URL(path, 'http://x');
    clock += 5; // 每次请求推进 5ms，模拟服务器时钟
    const serverTime = new Date(Date.parse('2026-09-27T10:00:00.000Z') + clock).toISOString();
    if (url.searchParams.get('action') === 'get') {
      return respond({ code: 'AB23', status: state.status, version: state.version, state, serverTime });
    }
    if (failApplyOnce > 0) { failApplyOnce -= 1; return respond({ error: 'conflict' }, 409); }
    state.version += 1;
    const a = body?.action;
    if (a?.type === 'score') state.teams[a.team].score += a.points;
    if (a?.type === 'foul') state.teams[a.team].fouls = (state.teams[a.team].fouls || 0) + 1;
    return respond({ code: 'AB23', status: state.status, version: state.version, state, serverTime });
  };

  return {
    calls,
    get state() { return state; },
    networkDown(n) { failNext = n; },
    conflictOnce() { failApplyOnce = 1; },
    setVersion(v) { state.version = v; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// _tick() 里的补发是后台进行的（不能被轮询阻塞），测试要等它真正跑完再断言
const waitIdle = async (store, timeoutMs = 1000) => {
  const start = Date.now();
  while (store._draining && Date.now() - start < timeoutMs) await sleep(5);
  await sleep(5);
};

// ---------- 1. 正常路径与 nonce ----------
console.log('— 正常 apply 与幂等 nonce —');
{
  mem.clear();
  const server = fakeServer();
  const store = new GameStore('AB23');
  const res = await store.apply({ type: 'score', team: 0, points: 2 });
  ok('在线 apply 成功', res.ok === true && store.state.teams[0].score === 2, JSON.stringify(res));
  ok('请求自动带上 nonce（服务端幂等键）', typeof server.calls[0].body.action.nonce === 'string' && server.calls[0].body.action.nonce.length >= 8);
  ok('apply 后快照与版本同步', store.version === server.state.version && store.online === true);
}

// ---------- 2. 断网排队 + 恢复后按序补发 ----------
console.log('\n— 断网排队与按序补发 —');
{
  mem.clear();
  const server = fakeServer();
  const store = new GameStore('AB23');
  store.online = false; // 模拟现场没信号
  const r1 = await store.apply({ type: 'score', team: 0, points: 1 });
  const r2 = await store.apply({ type: 'score', team: 1, points: 2 });
  const r3 = await store.apply({ type: 'foul', team: 0 });
  ok('断网时动作进队列并提示', r1.queued === true && r2.queued === true && r3.queued === true && store.queue.length === 3,
    JSON.stringify({ r1, r2, r3, q: store.queue.length }));
  ok('队列持久化到 localStorage（关浏览器不丢）', !!mem.get('bsq:AB23'), mem.get('bsq:AB23'));
  ok('队列里的动作保持提交顺序',
    store.queue[0].type === 'score' && store.queue[0].team === 0
    && store.queue[1].type === 'score' && store.queue[1].team === 1
    && store.queue[2].type === 'foul',
    JSON.stringify(store.queue));
  await store._tick(); // 轮询成功 → 后台自动 drain
  await waitIdle(store);
  ok('恢复后按序补发完毕', store.queue.length === 0 && server.state.teams[0].score === 1 && server.state.teams[1].score === 2 && server.state.teams[0].fouls === 1,
    JSON.stringify(server.state.teams));
  ok('补发后本地队列清空', JSON.parse(mem.get('bsq:AB23') || '[]').length === 0, mem.get('bsq:AB23'));
  ok('补发全部成功（3 条都在其中）', server.calls.filter((c) => c.path.includes('apply')).length === 3);
}

// ---------- 3. 网络抖动：响应丢失后补发同一意图（nonce 由调用方保留） ----------
console.log('\n— 网络抖动重试 —');
{
  mem.clear();
  const server = fakeServer();
  const store = new GameStore('AB23');
  server.networkDown(1);
  const intent = { type: 'score', team: 0, points: 2, nonce: 'fixed-nonce-0001' };
  const r = await store.apply(intent);
  ok('网络失败时入队并标记离线', r.queued === true && store.online === false);
  await store._tick();
  await waitIdle(store);
  ok('恢复后补发同一条意图（nonce 不变，服务端据此去重）',
    server.calls.some((c) => c.body?.action?.nonce === 'fixed-nonce-0001') && store.queue.length === 0);
}

// ---------- 4. 乱序响应：旧 GET 不得覆盖新 apply ----------
console.log('\n— 乱序响应保护 —');
{
  mem.clear();
  const server = fakeServer();
  const store = new GameStore('AB23');
  await store.apply({ type: 'score', team: 0, points: 3 });
  const v = store.version;
  store._accept({ code: 'AB23', status: 'live', version: v - 1, state: { stale: true }, serverTime: new Date(Date.now() - 5000).toISOString() });
  ok('旧版本响应被丢弃（快照不回退）', store.version === v && store.state.teams[0].score === 3, `version=${store.version}`);
  store._accept({ code: 'AB23', status: 'live', version: v + 1, state: { teams: [{ score: 9 }, { score: 0 }] }, serverTime: new Date().toISOString() });
  ok('新版本响应正常接受', store.version === v + 1 && store.state.teams[0].score === 9);
}

// ---------- 5. 冲突：409 后自动重新拉取 ----------
console.log('\n— 冲突自动刷新 —');
{
  mem.clear();
  const server = fakeServer();
  const store = new GameStore('AB23');
  await store._tick();
  server.conflictOnce();
  const before = store.version;
  const res = await store.apply({ type: 'foul', team: 1 });
  ok('409 被识别为冲突并触发刷新', res.conflict === true, JSON.stringify(res));
  await sleep(10);
  ok('冲突后已重新拉取服务端状态', store.version === before, `version=${store.version}`);
}

// ---------- 6. 补发中的业务错误：丢弃并记录（控制端会 toast） ----------
console.log('\n— 补发遇到业务错误 —');
{
  mem.clear();
  const server = fakeServer();
  const store = new GameStore('AB23');
  store.online = false;
  await store.apply({ type: 'score', team: 0, points: 2 }); // 直接入队
  // 让服务端对该动作返回业务错误
  globalThis.fetch = async (path, opts = {}) => {
    if (String(path).includes('apply')) return new Response(JSON.stringify({ error: 'game_finished' }), { status: 409, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ code: 'AB23', status: 'finished', version: 1, state: server.state, serverTime: new Date().toISOString() }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await store._tick();
  await waitIdle(store);
  ok('业务错误动作被丢弃（不无限重试）', store.queue.length === 0);
  ok('业务错误被记录下来供 UI 提示', store.lastBusinessError?.code === 'game_finished', JSON.stringify(store.lastBusinessError));
}

// ---------- 7. 队列上限与脏数据过滤 ----------
console.log('\n— 队列持久化的健壮性 —');
{
  mem.clear();
  fakeServer();
  mem.set('bsq:CD45', JSON.stringify([{ type: 'score', team: 0, points: 2 }, { garbage: true }, null, 'x']));
  const store = new GameStore('CD45');
  ok('脏队列项被过滤', store.queue.length === 1 && store.queue[0].type === 'score', JSON.stringify(store.queue));
  mem.set('bsq:EF67', 'not-json');
  const s2 = new GameStore('EF67');
  ok('队列 JSON 损坏时安全降级为空', s2.queue.length === 0);
}

// ---------- 8. stale 判定 ----------
console.log('\n— 信号弱判定 —');
{
  mem.clear();
  fakeServer();
  const store = new GameStore('GH89');
  ok('从未成功过不算 stale', store.stale() === false);
  await store._tick();
  ok('刚同步过不算 stale', store.stale() === false);
  store.lastOkAt = store.now() - 4000;
  ok('超过 3 秒无响应判定为信号弱', store.stale() === true);
}

// ---------- 9. 控制凭证：只挂写请求，永不挂 GET ----------
console.log('\n— 控制凭证只上写路径 —');
{
  mem.clear();
  const server = fakeServer();
  globalThis.location = { hash: '', pathname: '/room/AB23/control', search: '' };
  globalThis.history = { replaceState: () => {} };
  const tok = 'a'.repeat(64);
  mem.set('bs-token:AB23', tok);
  const store = new GameStore('AB23');
  ok('从 localStorage 读到控制凭证', store.token === tok);
  await store.apply({ type: 'score', team: 0, points: 2 });
  const post = server.calls.find((c) => c.path.includes('apply'));
  ok('apply 请求带 Authorization: Bearer', post?.headers?.authorization === `Bearer ${tok}`, JSON.stringify(post?.headers));
  await store._tick();
  const get = server.calls.filter((c) => c.path.includes('action=get')).pop();
  ok('GET 轮询不带凭证（大屏/数据卡永不被授权）', !get?.headers?.authorization, JSON.stringify(get?.headers));
}

// ---------- 10. fragment 分享的控制端链接：收编凭证后立即抹掉 ----------
console.log('\n— fragment 凭证交接 —');
{
  mem.clear();
  fakeServer();
  const tok = 'b'.repeat(64);
  globalThis.location = { hash: `#t=${tok}`, pathname: '/room/CD45/control', search: '' };
  let replaced = null;
  globalThis.history = { replaceState: (_s, _t, url) => { replaced = url; } };
  const store = new GameStore('CD45');
  ok('fragment 里的凭证被收编并持久化', store.token === tok && mem.get('bs-token:CD45') === tok);
  ok('fragment 被从地址栏抹掉（凭证不留在历史记录里）', replaced === '/room/CD45/control', String(replaced));
}

// ---------- 11. 离线队列边界：延迟不安全的动作不排队，队列有硬上限 ----------
console.log('\n— 离线队列边界 —');
{
  mem.clear();
  fakeServer();
  globalThis.location = { hash: '', pathname: '/room/AB23/control', search: '' };
  globalThis.history = { replaceState: () => {} };
  const store = new GameStore('AB23');
  store.online = false;
  const undoRes = await store.apply({ type: 'undo' });
  ok('断网时撤销拒绝入队（迟到的撤销会吃掉队友后来的操作）', undoRes.error?.code === 'needs_online' && store.queue.length === 0, JSON.stringify(undoRes));
  const finishRes = await store.apply({ type: 'finish' });
  ok('断网时结束比赛拒绝入队（终局时刻错不得）', finishRes.error?.code === 'needs_online' && store.queue.length === 0, JSON.stringify(finishRes));
  const startRes = await store.apply({ type: 'clock_start' });
  ok('断网时 clock 迁移拒绝入队', startRes.error?.code === 'needs_online' && store.queue.length === 0, JSON.stringify(startRes));
  const scoreRes = await store.apply({ type: 'score', team: 0, points: 2 });
  ok('断网时得分照常排队（已发生的事实）', scoreRes.queued === true && store.queue.length === 1, JSON.stringify(scoreRes));
}

// ---------- 12. 队列硬上限：拒绝新动作并明说，不静默截断 ----------
console.log('\n— 队列硬上限 —');
{
  mem.clear();
  fakeServer();
  globalThis.location = { hash: '', pathname: '/room/AB23/control', search: '' };
  globalThis.history = { replaceState: () => {} };
  const store = new GameStore('AB23');
  store.online = false;
  for (let i = 0; i < 50; i += 1) await store.apply({ type: 'score', team: 0, points: 1 });
  ok('队列上限 50 满额', store.queue.length === 50, `实际 ${store.queue.length}`);
  const overflow = await store.apply({ type: 'score', team: 0, points: 3 });
  ok('满额后拒绝新动作并提示（不静默丢弃）', overflow.error?.code === 'queue_full' && store.queue.length === 50, JSON.stringify(overflow));
  ok('持久化的队列与内存一致（没有第二套截断）', JSON.parse(mem.get('bsq:AB23') || '[]').length === 50, mem.get('bsq:AB23')?.length);
}

// ---------- 13. 旧版本脏队列：延迟不安全的动作加载时即被滤掉 ----------
console.log('\n— 旧版本队列过滤 —');
{
  mem.clear();
  fakeServer();
  globalThis.location = { hash: '', pathname: '/room/AB23/control', search: '' };
  globalThis.history = { replaceState: () => {} };
  mem.set('bsq:CD45', JSON.stringify([
    { type: 'score', team: 0, points: 2, nonce: 'n1' },
    { type: 'undo', nonce: 'n2' },
    { type: 'finish', nonce: 'n3' },
    { type: 'foul', team: 1, nonce: 'n4' },
  ]));
  const store = new GameStore('CD45');
  ok('历史队列里的撤销/终局被滤掉（补发时刻已错）', store.queue.length === 2 && store.queue.every((a) => a.type === 'score' || a.type === 'foul'), JSON.stringify(store.queue.map((a) => a.type)));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
