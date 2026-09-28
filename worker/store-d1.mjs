// Cloudflare D1 数据适配器 —— handler 只依赖这个接口，换库不用动业务逻辑。
// 并发正确性靠 SQLite 的 `UPDATE ... WHERE version = ?` 影响行数判定（CAS）。

const asInt = (v) => (typeof v === 'number' ? v : Number(v));
const newReceiptId = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`);

// 审计插入：只有本轮 UPDATE 真的把版本推到 seq 才落——CAS 输了就不记。
// 和状态更新同一个批处理，不存在「状态变了但审计没记」的中间态。
const logInsert = (db, code, seq, e) => db
  .prepare('INSERT INTO action_log (code, seq, actor, action, before_score, after_score, clock_ms, at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM games WHERE code = ? AND version = ?)')
  .bind(code, seq, e.actor, e.action, e.before_score, e.after_score, e.clock_ms, e.at, code, seq);

export function createD1Store(db) {
  return {
    async getGame(code) {
      const row = await db
          .prepare('SELECT code, status, version, state, created_at, updated_at, controller_hash, recovery_hash FROM games WHERE code = ?')
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
          .prepare('INSERT INTO games (code, status, version, state, created_at, updated_at, controller_hash, recovery_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(game.code, game.status, game.version, JSON.stringify(game.state), game.created_at, game.updated_at, game.controller_hash, game.recovery_hash ?? null)
          .run();
      } catch (e) {
        const msg = `${e?.message || ''} ${e?.cause?.message || ''}`;
        if (/constraint|unique/i.test(msg)) return { error: 'duplicate' };
        return { error: 'db' };
      }
      return { ok: true };
    },

    async casUpdateGame(code, expectedVersion, patch, logEntry = null) {
      let results;
      try {
        const stmts = [
          db.prepare('UPDATE games SET status = ?, version = ?, state = ?, updated_at = ? WHERE code = ? AND version = ?')
            .bind(patch.status, expectedVersion + 1, JSON.stringify(patch.state), patch.updated_at, code, expectedVersion),
        ];
        if (logEntry) stmts.push(logInsert(db, code, expectedVersion + 1, logEntry));
        results = await db.batch(stmts);
      } catch {
        return { error: 'db' };
      }
      const changed = asInt(results?.[0]?.meta?.changes ?? 0);
      if (changed > 1) return { error: 'db' }; // 主键唯一，>1 说明约束被改坏
      return { changed: changed === 1, version: expectedVersion + 1 };
    },

    async hasReceipt(code, nonce) {
      const row = await db.prepare('SELECT 1 AS found FROM action_receipts WHERE code = ? AND nonce = ?')
        .bind(code, nonce).first();
      return !!row;
    },

    async recordReceipt(code, expectedVersion, nonce, createdAt) {
      let result;
      const receiptId = newReceiptId();
      try {
        result = await db.prepare('INSERT OR IGNORE INTO action_receipts (code, nonce, created_at, receipt_id) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM games WHERE code = ? AND version = ?)')
          .bind(code, nonce, createdAt, receiptId, code, expectedVersion).run();
      } catch { return { error: 'db' }; }
      const changed = asInt(result?.meta?.changes ?? 0);
      if (changed === 1) return { changed: true };
      return { changed: false, duplicate: await this.hasReceipt(code, nonce) };
    },

    async casUpdateGameWithReceipt(code, expectedVersion, patch, nonce, logEntry = null) {
      let results;
      const receiptId = newReceiptId();
      try {
        const stmts = [
          db.prepare('INSERT OR IGNORE INTO action_receipts (code, nonce, created_at, receipt_id) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM games WHERE code = ? AND version = ?)')
            .bind(code, nonce, patch.updated_at, receiptId, code, expectedVersion),
          db.prepare('UPDATE games SET status = ?, version = ?, state = ?, updated_at = ? WHERE code = ? AND version = ? AND EXISTS (SELECT 1 FROM action_receipts WHERE code = ? AND nonce = ? AND receipt_id = ?)')
            .bind(patch.status, expectedVersion + 1, JSON.stringify(patch.state), patch.updated_at, code, expectedVersion, code, nonce, receiptId),
        ];
        // 审计放在 UPDATE 之后：版本没被推到 expectedVersion+1 就记不进去
        if (logEntry) stmts.push(logInsert(db, code, expectedVersion + 1, logEntry));
        results = await db.batch(stmts);
      } catch {
        return { error: 'db' };
      }
      const receiptChanges = asInt(results?.[0]?.meta?.changes ?? 0);
      const gameChanges = asInt(results?.[1]?.meta?.changes ?? 0);
      if (gameChanges > 1 || receiptChanges > 1) return { error: 'db' };
      return { changed: gameChanges === 1, duplicate: receiptChanges === 0 && await this.hasReceipt(code, nonce), version: expectedVersion + 1 };
    },

    // 操作审计读取：只回该房间的，按落地顺序倒序（最新的在前）。
    // 和 get 一样是公开读——房间里任何人都能核对记录，这正是它防吵架的方式。
    async getLog(code, limit = 200) {
      let result;
      try {
        result = await db
          .prepare('SELECT seq, actor, action, before_score, after_score, clock_ms, at FROM action_log WHERE code = ? ORDER BY seq DESC LIMIT ?')
          .bind(code, limit)
          .all();
      } catch {
        return { error: 'db' };
      }
      return { entries: (result?.results || []).map((r) => ({ ...r, seq: asInt(r.seq), clock_ms: asInt(r.clock_ms) })) };
    },

    // 控制权补发：换 controller_hash + 轮换 recovery_hash，版本 +1（补发本身是一次写入，
    // 审计要能落；状态不变，各端看到的比分/时钟毫无变化）。CAS 防并发补发互相覆盖。
    async reissueController(code, expectedVersion, patch, logEntry = null) {
      let results;
      try {
        const stmts = [
          db.prepare('UPDATE games SET controller_hash = ?, recovery_hash = ?, version = ?, updated_at = ? WHERE code = ? AND version = ?')
            .bind(patch.controller_hash, patch.recovery_hash, expectedVersion + 1, patch.updated_at, code, expectedVersion),
        ];
        if (logEntry) stmts.push(logInsert(db, code, expectedVersion + 1, logEntry));
        results = await db.batch(stmts);
      } catch {
        return { error: 'db' };
      }
      const changed = asInt(results?.[0]?.meta?.changes ?? 0);
      if (changed > 1) return { error: 'db' };
      return { changed: changed === 1, version: expectedVersion + 1 };
    },

    // 到点推进用：只捞状态列是 live 的行——运行中的时钟必然 live
    // （clock_start 会把 setup 激活成 live），所以不需要全表扫。
    async listLiveGames() {
      let result;
      try {
        result = await db.prepare("SELECT code, version, state FROM games WHERE status = 'live'").all();
      } catch {
        return { error: 'db' };
      }
      const games = [];
      for (const r of result?.results || []) {
        try { games.push({ code: r.code, version: asInt(r.version), state: JSON.parse(r.state) }); }
        catch { return { error: 'db' }; }
      }
      return { games };
    },

    async deleteStaleSetup(beforeIso) {
      await db.prepare('DELETE FROM games WHERE status = ? AND created_at < ?').bind('setup', beforeIso).run();
    },

    // 半途放弃的局：建过赛、打过几下，但超过 N 天没有任何写入（updated_at 不动）。
    // 已 finished 的永久保留（数据卡链接要能长期打开），setup 归 deleteStaleSetup 管。
    async deleteAbandoned(beforeIso) {
      await db.prepare(
        "DELETE FROM games WHERE status IN ('live', 'break', 'timeout') AND updated_at < ?",
      ).bind(beforeIso).run();
    },
  };
}
