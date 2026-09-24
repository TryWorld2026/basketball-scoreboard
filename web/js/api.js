// 同源 Function 调用助手。错误码 → 产品语言，不回传原始服务端错误。

const MESSAGES = {
  game_not_found: '房间不存在或已归档，请检查房间码',
  game_finished: '比赛已结束，比分已锁定',
  invalid_code: '房间码格式不正确',
  invalid_teams: '请填写两队队名并选择队色',
  invalid_action: '无效操作',
  invalid_points: '无效分值',
  invalid_player: '未找到该球员',
  no_timeouts_left: '该队暂停次数已用完',
  game_not_started: '比赛还没开始，先点「开始」计时',
  not_in_play: '只能在比赛计时中记录，暂停或休息时不可',
  timeout_only_in_play: '只能在比赛进行中请求暂停',
  wait_countdown_end: '请等待当前倒计时结束',
  already_running: '计时已在进行中',
  already_stopped: '计时已停止',
  already_break: '当前已是节间休息',
  shot_clock_off: '本场未开启进攻时限',
  nothing_to_undo: '没有可撤销的操作',
  conflict: '状态已被其他操作更新，已自动刷新',
  invalid_version: '操作已过期，请重试',
  invalid_body: '请求内容异常',
  not_found: '接口不存在',
  method_not_allowed: '请求方式不被允许',
  database_request_failed: '服务暂时不可用，请稍后重试',
  service_error: '服务异常，请稍后重试',
  code_exhausted: '创建失败，请重试',
  network: '网络连接失败',
};

export class ApiError extends Error {
  constructor(code, status) {
    super(MESSAGES[code] || '操作失败，请重试');
    this.code = code;
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('network', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok || !data || data.error) {
    throw new ApiError(data?.error || `http_${res.status}`, res.status);
  }
  return data;
}
