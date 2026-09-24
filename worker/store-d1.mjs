// Cloudflare D1 数据适配器 —— handler 只依赖这个接口，换库不用动业务逻辑。
// 并发正确性靠 SQLite 的 `UPDATE ... WHERE version = ?` 影响行数判定（CAS）。

const asInt = (v) => (typeof v === 'number' ? v : Number(v));

export function createD1Store(db) {
  return {
    async getGame(code) {
      const row = await db
        .prepare('SELECT code, status, version, state, created_at, updated_at FROM games WHERE code = ?')
        .bind(code)
        .first();
      if (!row) return null;
      try {
        return { ...row, version: asInt(row.version), state: JSON.parse(row.state) };
      } catch {
        return { error: 'db' }; // 行存在但 state 不是合法 JSON：当作后端异常
      }
    },

    async insertGame(game) {
      try {
        await db
          .prepare('INSERT INTO games (code, status, version, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(game.code, game.status, game.version, JSON.stringify(game.state), game.created_at, game.updated_at)
          .run();
      } catch (e) {
        const msg = `${e?.message || ''} ${e?.cause?.message || ''}`;
        if (/constraint|unique/i.test(msg)) return { error: 'duplicate' };
        return { error: 'db' };
      }
      return { ok: true };
    },

    async casUpdateGame(code, expectedVersion, patch) {
      let result;
      try {
        result = await db
          .prepare('UPDATE games SET status = ?, version = ?, state = ?, updated_at = ? WHERE code = ? AND version = ?')
          .bind(patch.status, expectedVersion + 1, JSON.stringify(patch.state), patch.updated_at, code, expectedVersion)
          .run();
      } catch {
        return { error: 'db' };
      }
      const changed = asInt(result?.meta?.changes ?? 0);
      if (changed > 1) return { error: 'db' }; // 主键唯一，>1 说明约束被改坏
      return { changed: changed === 1, version: expectedVersion + 1 };
    },

    async deleteStaleSetup(beforeIso) {
      await db.prepare('DELETE FROM games WHERE status = ? AND created_at < ?').bind('setup', beforeIso).run();
    },
  };
}
