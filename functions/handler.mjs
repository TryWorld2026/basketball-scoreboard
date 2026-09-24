// 篮球计分板业务 Handler —— 浏览器经 /functions/v1/app 同源调用。
// 写路径：读 state → 纯函数应用意图 → 版本号 CAS 写回；冲突则重读重放（有界）。
import { applyAction, deriveClock, emptyState, newCode, sanitizeConfig, sanitizePlayers, sanitizeTeams } from './shared/rules.mjs';

const json = (body, status = 200, headers = {}) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store', ...headers },
});

const CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
const MAX_BODY = 12 * 1024;
const CAS_ATTEMPTS = 3;
const STALE_SETUP_MS = 24 * 60 * 60 * 1000;

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

async function loadGame(supabase, code) {
  const { data, error } = await supabase.from('games')
    .select('code,status,version,state,created_at').eq('code', code).maybeSingle();
  if (error) return { error: 'database_request_failed', status: 503 };
  if (!data) return { error: 'game_not_found', status: 404 };
  return { row: data };
}

async function casWrite(supabase, code, expectedVersion, state, status) {
  const now = new Date().toISOString();
  const { data, error } = await supabase.from('games')
    .update({ state, status, version: expectedVersion + 1, updated_at: now })
    .eq('code', code).eq('version', expectedVersion)
    .select('code,status,version').maybeSingle();
  if (error) return { error: 'database_request_failed', status: 503 };
  if (!data) return { error: 'conflict' };
  return { row: data };
}

async function handleGet(supabase, params) {
  const code = String(params.get('code') || '').toUpperCase();
  if (!CODE_RE.test(code)) return json({ error: 'invalid_code' }, 400);
  const loaded = await loadGame(supabase, code);
  if (loaded.error) return json({ error: loaded.error }, loaded.status);
  return json({
    code: loaded.row.code, status: loaded.row.state?.status || loaded.row.status, version: loaded.row.version,
    state: loaded.row.state, serverTime: new Date().toISOString(),
  });
}

async function handleCreate(supabase, request) {
  const body = await readBody(request);
  if (body.error) return json({ error: body.error }, 400);
  const teams = sanitizeTeams(body.data.teams);
  if (!teams) return json({ error: 'invalid_teams' }, 400);
  const config = sanitizeConfig(body.data.config);
  const players = config.trackPlayers ? sanitizePlayers(body.data.players, teams) : [];
  const state = emptyState(config, teams, players);

  // 顺带清理：筹建中但 24h 未开打的废弃房间（失败不影响创建）。
  try {
    await supabase.from('games').delete()
      .eq('status', 'setup').lt('created_at', new Date(Date.now() - STALE_SETUP_MS).toISOString());
  } catch { /* 清理是尽力而为 */ }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newCode();
    const now = new Date().toISOString();
    const { data, error } = await supabase.from('games')
      .insert({ code, status: 'setup', version: 0, state, created_at: now, updated_at: now })
      .select('code,status,version').maybeSingle();
    if (error) {
      if (String(error.code) === '23505') continue; // 唯一键竞争，换码重试
      return json({ error: 'database_request_failed' }, 503);
    }
    if (!data) return json({ error: 'database_request_failed' }, 503);
    return json({ code: data.code, status: data.status, version: data.version, state, serverTime: now });
  }
  return json({ error: 'code_exhausted' }, 503);
}

async function handleApply(supabase, request) {
  const body = await readBody(request);
  if (body.error) return json({ error: body.error }, 400);
  const code = String(body.data.code || '').toUpperCase();
  if (!CODE_RE.test(code)) return json({ error: 'invalid_code' }, 400);
  if (!Number.isInteger(Number(body.data.version)) || Number(body.data.version) < 0) return json({ error: 'invalid_version' }, 400);
  const action = body.data.action;
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') return json({ error: 'invalid_action' }, 400);

  // 以服务端最新状态为准应用意图；CAS 冲突则重读重放（有界）。
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const loaded = await loadGame(supabase, code);
    if (loaded.error) return json({ error: loaded.error }, loaded.status);
    const row = loaded.row;
    const nowMs = Date.now();
    const result = applyAction(row.state, action, new Date(nowMs).toISOString(), nowMs);
    if (result.error) return json({ error: result.error }, result.status || 400);
    // 幂等/无变化：不写库、不涨版本，避免多端同时上报归零造成无意义冲突
    if (JSON.stringify(result.state) === JSON.stringify(row.state)) {
      return json({
        code, status: row.state.status, version: row.version,
        state: row.state, serverTime: new Date().toISOString(), noop: true,
      });
    }
    const written = await casWrite(supabase, code, row.version, result.state, result.state.status);
    if (written.row) {
      return json({
        code, status: result.state.status, version: written.row.version,
        state: result.state, serverTime: new Date().toISOString(),
      });
    }
    if (written.error && written.error !== 'conflict') return json({ error: written.error }, written.status);
  }
  return json({ error: 'conflict' }, 409);
}

export async function handleGames({ request, supabase }) {
  const params = new URL(request.url).searchParams;
  const action = params.get('action');
  const method = request.method;
  try {
    if (action === 'get') {
      if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
      return await handleGet(supabase, params);
    }
    if (action === 'create' || action === 'apply') {
      if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
      return action === 'create' ? await handleCreate(supabase, request) : await handleApply(supabase, request);
    }
    return json({ error: 'not_found' }, 404);
  } catch {
    // 不回传原始 provider 错误
    return json({ error: 'service_error' }, 503);
  }
}
