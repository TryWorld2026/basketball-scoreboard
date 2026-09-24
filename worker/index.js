import { handleGames } from './handler.mjs';
import { createD1Store } from './store-d1.mjs';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      if (!env.DB) return Response.json({ error: 'database_unavailable' }, { status: 503 });
      return handleGames({ request, store: createD1Store(env.DB) });
    }
    // 其余交给静态资源绑定（含 SPA 回退）
    return env.ASSETS.fetch(request);
  },
};
