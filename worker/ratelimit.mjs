// 进程内滑动窗口限流 —— 只挡“枚举/滥用”，不挡正常使用。
// 设计取舍：Workers 无跨请求共享内存，Map 按 isolate 独立计数，
// 因此这是“提高枚举成本”的尽力而为防线，不是硬保证（见 README 已知边界）。
// 只统计失败请求（房间不存在/非法参数/冲突），正常 1 秒轮询不计入。

export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map(); // ip -> { count, resetAt }
  const MAX_KEYS = 10000;

  const prune = (nowMs) => {
    if (hits.size < MAX_KEYS) return;
    for (const [ip, e] of hits) if (nowMs >= e.resetAt) hits.delete(ip);
    // 仍然过大（极端情况）：直接清空，限流退化但不漏内存
    if (hits.size >= MAX_KEYS) hits.clear();
  };

  return {
    /** 记一次失败并判定是否放行。返回 { allowed, retryAfterMs } */
    hit(ip, nowMs = Date.now()) {
      prune(nowMs);
      const e = hits.get(ip);
      if (!e || nowMs >= e.resetAt) {
        hits.set(ip, { count: 1, resetAt: nowMs + windowMs });
        return { allowed: true, retryAfterMs: 0 };
      }
      if (e.count >= limit) return { allowed: false, retryAfterMs: e.resetAt - nowMs };
      e.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
    /** 只看不记（测试与探测用） */
    peek(ip, nowMs = Date.now()) {
      const e = hits.get(ip);
      if (!e || nowMs >= e.resetAt) return { allowed: true, retryAfterMs: 0 };
      return { allowed: e.count < limit, retryAfterMs: e.resetAt - nowMs };
    },
  };
}

// Cloudflare 会把客户端 IP 放在这个头里；本地 wrangler dev 用 x-forwarded-for 兜底
export const ipOf = (request) => {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const fwd = request.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || 'anon';
};
