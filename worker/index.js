import { handleGames, advanceDueGames } from './handler.mjs';
import { createD1Store } from './store-d1.mjs';

// 控制端是可以被诱导点击的（UI redressing：把遥控器 iframe 嵌进陌生页面，
// 诱骗记分员在「关闭广告」的位置按下 +3）。frame-ancestors 'none' 一刀切掉——
// 这个应用没有任何被合法嵌入的场景，大屏/数据卡都是整页打开。
// nosniff 防静态资源被猜类型执行。API 与静态响应都带上。
const SECURITY = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
};
const withSecurity = (res) => {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      if (!env.DB) return withSecurity(Response.json({ error: 'database_unavailable' }, { status: 503 }));
      return withSecurity(await handleGames({ request, store: createD1Store(env.DB) }));
    }
    // 其余交给静态资源绑定（含 SPA 回退）
    return withSecurity(await env.ASSETS.fetch(request));
  },

  // cron 每分钟：把「时钟已归零但没人上报」的比赛推进一步。
  // 到点推进不能只依赖记分员的手机在线——锁屏、杀后台、被叫走、没电，
  // 任何一样都发生的时候，比赛不该卡在 00:00。
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil(advanceDueGames(createD1Store(env.DB)).catch(() => {}));
  },
};
