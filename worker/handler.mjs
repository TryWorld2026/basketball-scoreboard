// 篮球计分板 HTTP 业务层 —— 与具体数据库无关，只依赖注入的 store 接口：
//   getGame / insertGame / casUpdateGame / casUpdateGameWithReceipt / getLog
//   / deleteStaleSetup / deleteAbandoned
// 浏览器同源调用 /api/game?action=get|create|apply。
import { applyAction, deriveRemaining, emptyState, newCode, readNonce, sanitizeConfig, sanitizePlayers, sanitizeTeams } from './rules.mjs';
import { createRateLimiter, ipOf } from './ratelimit.mjs';

const json = (body, status = 200, headers = {}) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store', ...headers },
});

const CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
const MAX_BODY = 12 * 1024;
const CAS_ATTEMPTS = 3;
const STALE_SETUP_MS = 24 * 60 * 60 * 1000;
// 半途放弃的比赛（建赛后超过 7 天没有任何写入）也清理，避免库只增不减
const ABANDONED_MS = 7 * 24 * 60 * 60 * 1000;

const bytesToHex = (bytes) => [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function newControllerCredential() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToHex(bytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return { token, hash: bytesToHex(digest) };
}
async function hashCredential(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const bearer = (request) => /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '')?.[1] || null;

// 写路径持凭证：房间码只给读，控制凭证才给写。
// 凭证签发时只明文回一次，库里只存 SHA-256；老行没有 controller_hash 一律 fail closed
// （只读，finished 的数据卡链接不受影响）。
// 返回「操作者指纹」= 凭证哈希前 8 位，写进审计日志：足以区分是哪台设备按的，
// 又不会把凭证本身泄进日志（日志是公开可读的）。
async function authorizeActor(request, storedHash) {
  if (typeof storedHash !== 'string' || !storedHash) return null;
  const token = bearer(request);
  if (!token) return null;
  const presented = await hashCredential(token);
  if (!presented || !sameHash(presented, storedHash)) return null;
  return presented.slice(0, 8);
}

// 默认限流器：按 isolate 计数，只统计失败请求（房间不存在/非法参数/冲突/凭证不符）
const DEFAULT_LIMITERS = {
  fail: createRateLimiter({ limit: 60, windowMs: 60_000 }),      // 读/写失败：每分钟 60 次
  create: createRateLimiter({ limit: 20, windowMs: 60 * 60_000 }), // 建赛：每小时 20 场
};

// 失败响应过一遍限流器：超限则换成 429（正常使用不会被计次，不会被误伤）
const throttled = (limiters, request, res) => {
  const { allowed, retryAfterMs } = limiters.fail.hit(ipOf(request));
  if (allowed) return res;
  return json({ error: 'too_many_requests' }, 429, { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) });
};

async function readBody(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY) return { error: 'invalid_body' };
  let text = '';
  try {
    const reader = request.body?.getReader();
    if (!reader) return { error: 'invalid_body' };
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (text.length > MAX_BODY) { await reader.cancel(); return { error: 'invalid_body' }; }
    }
  } catch { return { error: 'invalid_body' }; }
  if (!text) return { error: 'invalid_body' };
  let data;
  try { data = JSON.parse(text); } catch { return { error: 'invalid_body' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'invalid_body' };
  return { data };
}

const dbError = () => json({ error: 'database_request_failed' }, 503);

/**
 * 服务端到点推进（cron 每分钟触发一次）：时钟归零不再依赖记分员的手机在线。
 * 之前控制端一关，节间休息/暂停倒计时就永远停在 00:00——现场记分员被叫走、
 * 手机锁屏、杀后台、没电，比赛就卡死在那儿。
 *
 * 实现要点：
 * - 不走独立的分支逻辑，直接调和服务端 applyAction 同一套规则（clock_zero），
 *   和记分员自己上报的行为逐字一致；「无变化不写库」就是幂等闸门。
 * - 和记分员的上报撞车时，CAS 保证只有一个生效，另一个按冲突跳过——
 *   不会重复进节。
 * - 审计 actor 记 'cron'，动作带 by:'server-cron'，和人工操作可分。
 */
export async function advanceDueGames(store, nowMs = Date.now()) {
  const list = await store.listLiveGames();
  if (list.error) return { error: 'db' };
  let advanced = 0;
  for (const game of list.games) {
    const nowIso = new Date(nowMs).toISOString();
    const action = { type: 'clock_zero', by: 'server-cron' };
    const result = applyAction(game.state, action, nowIso, nowMs);
    if (result.error) continue;
    if (JSON.stringify(result.state) === JSON.stringify(game.state)) continue; // 没到点
    const patch = { state: result.state, status: result.state.status, updated_at: nowIso };
    const score = (st) => `${st.teams[0].score}:${st.teams[1].score}`;
    const logEntry = {
      actor: 'cron',
      action: JSON.stringify(action),
      before_score: score(game.state),
      after_score: score(result.state),
      clock_ms: Math.round(deriveRemaining(result.state.clock, nowMs)),
      at: nowIso,
    };
    const written = await store.casUpdateGame(game.code, game.version, patch, logEntry);
    if (written?.changed) advanced += 1; // 版本被记分员抢先推过：跳过，下一次 cron 自然续上
  }
  return { advanced };
}

async function handleGet(store, limiters, request, params) {
  const code = String(params.get('code') || '').toUpperCase();
  if (!CODE_RE.test(code)) return throttled(limiters, request, json({ error: 'invalid_code' }, 400));
  const row = await store.getGame(code);
  if (row === null) return throttled(limiters, request, json({ error: 'game_not_found' }, 404));
  if (!row || row.error) return dbError();
  return json({
    code: row.code, status: row.state?.status || row.status, version: row.version,
    state: row.state, serverTime: new Date().toISOString(),
  });
}

// 操作审计读取：房间码即读能力（和 get 同级）。赛后吵架时，
// 房间里任何人都能拉出「谁在什么时候把比分从多少改成多少」——公开才有人信。
async function handleLog(store, limiters, request, params) {
  const code = String(params.get('code') || '').toUpperCase();
  if (!CODE_RE.test(code)) return throttled(limiters, request, json({ error: 'invalid_code' }, 400));
  const row = await store.getGame(code);
  if (row === null) return throttled(limiters, request, json({ error: 'game_not_found' }, 404));
  if (!row || row.error) return dbError();
  const log = await store.getLog(code);
  if (log.error) return dbError();
  return json({ code, version: row.version, entries: log.entries, serverTime: new Date().toISOString() });
}

async function handleCreate(store, limiters, request) {
  const gate = limiters.create.hit(ipOf(request));
  if (!gate.allowed) {
    return json({ error: 'too_many_requests' }, 429, { 'retry-after': String(Math.ceil(gate.retryAfterMs / 1000)) });
  }
  const body = await readBody(request);
  if (body.error) return json({ error: body.error }, 400);
  const teams = sanitizeTeams(body.data.teams);
  if (!teams) return json({ error: 'invalid_teams' }, 400);
  const config = sanitizeConfig(body.data.config);
  const players = config.trackPlayers ? sanitizePlayers(body.data.players, teams) : [];
  const state = emptyState(config, teams, players);
  const credential = await newControllerCredential();

  // 顺带清理：筹建中但 24h 未开打的废弃房间，以及超过 7 天没有任何写入的半途放弃局
  // （尽力而为，失败不阻塞创建）
  const staleBefore = new Date(Date.now() - STALE_SETUP_MS).toISOString();
  try { await store.deleteStaleSetup(staleBefore); } catch { /* ignore */ }
  try { await store.deleteAbandoned(new Date(Date.now() - ABANDONED_MS).toISOString()); } catch { /* ignore */ }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newCode();
    const now = new Date().toISOString();
    const inserted = await store.insertGame({ code, status: 'setup', version: 0, state, created_at: now, updated_at: now, controller_hash: credential.hash });
    if (inserted.error === 'duplicate') continue; // 房间码竞争，换码重试
    if (inserted.error) return dbError();
    return json({ code, status: 'setup', version: 0, state, serverTime: now, controlToken: credential.token });
  }
  return json({ error: 'code_exhausted' }, 503);
}

async function handleApply(store, limiters, request) {
  const body = await readBody(request);
  if (body.error) return json({ error: body.error }, 400);
  const code = String(body.data.code || '').toUpperCase();
  if (!CODE_RE.test(code)) return throttled(limiters, request, json({ error: 'invalid_code' }, 400));
  if (!Number.isInteger(Number(body.data.version)) || Number(body.data.version) < 0) return json({ error: 'invalid_version' }, 400);
  const action = body.data.action;
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') return json({ error: 'invalid_action' }, 400);
  const nonce = readNonce(action);

  // 以服务端最新状态为准应用意图；CAS 冲突则重读重放（有界）
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const row = await store.getGame(code);
    if (row === null) return throttled(limiters, request, json({ error: 'game_not_found' }, 404));
    if (!row || row.error) return dbError();
    const actor = await authorizeActor(request, row.controller_hash);
    if (!actor) {
      return throttled(limiters, request, json({ error: 'controller_required' }, 403));
    }
    const nowMs = Date.now();
    const result = applyAction(row.state, action, new Date(nowMs).toISOString(), nowMs);
    if (result.error) return json({ error: result.error }, result.status || 400);
    // 无变化：不写库、不涨版本（重复上报归零、时钟没归零就发 clock_zero）——也不写审计
    if (JSON.stringify(result.state) === JSON.stringify(row.state)) {
      return json({
        code, status: row.state.status, version: row.version,
        state: row.state, serverTime: new Date().toISOString(), noop: true,
      });
    }
    const patch = { state: result.state, status: result.state.status, updated_at: new Date().toISOString() };
    // 审计：每一次落地记一条（谁/何时/什么动作/比分从多少变成多少/当时时钟）。
    // 和状态更新走同一个批处理——CAS 输了就不记，不存在「状态变了审计没记」。
    const score = (st) => `${st.teams[0].score}:${st.teams[1].score}`;
    const logEntry = {
      actor,
      action: JSON.stringify(action),
      before_score: score(row.state),
      after_score: score(result.state),
      clock_ms: Math.round(deriveRemaining(result.state.clock, nowMs)),
      at: patch.updated_at,
    };
    // 带 nonce 的意图走「回执 + CAS」同一个批处理：回执已在 = 这个意图落地过
    // （响应丢失后的补发），按 noop 回当前状态，不二次生效、不涨版本。
    // 回执与比赛行级联删除，去重窗口不限于最近 N 条。
    const written = nonce
      ? await store.casUpdateGameWithReceipt(code, row.version, patch, nonce, logEntry)
      : await store.casUpdateGame(code, row.version, patch, logEntry);
    if (written.error) return dbError();
    if (written.duplicate) {
      return json({
        code, status: row.state.status, version: row.version,
        state: row.state, serverTime: new Date().toISOString(), noop: true,
      });
    }
    if (written.changed) {
      return json({
        code, status: result.state.status, version: written.version,
        state: result.state, serverTime: new Date().toISOString(),
      });
    }
  }
  return json({ error: 'conflict' }, 409);
}

export async function handleGames({ request, store, limiters = DEFAULT_LIMITERS }) {
  const params = new URL(request.url).searchParams;
  const action = params.get('action');
  const method = request.method;
  try {
    if (action === 'get' || action === 'log') {
      if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
      return action === 'get'
        ? await handleGet(store, limiters, request, params)
        : await handleLog(store, limiters, request, params);
    }
    if (action === 'create' || action === 'apply') {
      if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
      return action === 'create' ? await handleCreate(store, limiters, request) : await handleApply(store, limiters, request);
    }
    return json({ error: 'not_found' }, 404);
  } catch {
    // 不回传原始后端错误、SQL 或凭据
    return json({ error: 'service_error' }, 503);
  }
}
