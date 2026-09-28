// Cloudflare D1 数据适配器 —— handler 只依赖这个接口，换库不用动业务逻辑。
// 并发正确性靠 SQLite 的 `UPDATE ... WHERE version = ?` 影响行数判定（CAS）。

const asInt = (v) => (typeof v === 'number' ? v : Number(v));
const newReceiptId = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`);

export function createD1Store(db) {
  return {
    async getGame(code) {
      const row = await db
          .prepare('SELECT code, status, version, state, created_at, updated_at, controller_hash FROM games WHERE code = ?')
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
          .prepare('INSERT INTO games (code, status, version, state, created_at, updated_at, controller_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(game.code, game.status, game.version, JSON.stringify(game.state), game.created_at, game.updated_at, game.controller_hash)
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

    async casUpdateGameWithReceipt(code, expectedVersion, patch, nonce) {
      let results;
      const receiptId = newReceiptId();
      try {
        results = await db.batch([
          db.prepare('INSERT OR IGNORE INTO action_receipts (code, nonce, created_at, receipt_id) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM games WHERE code = ? AND version = ?)')
            .bind(code, nonce, patch.updated_at, receiptId, code, expectedVersion),
          db.prepare('UPDATE games SET status = ?, version = ?, state = ?, updated_at = ? WHERE code = ? AND version = ? AND EXISTS (SELECT 1 FROM action_receipts WHERE code = ? AND nonce = ? AND receipt_id = ?)')
            .bind(patch.status, expectedVersion + 1, JSON.stringify(patch.state), patch.updated_at, code, expectedVersion, code, nonce, receiptId),
        ]);
      } catch {
        return { error: 'db' };
      }
      const receiptChanges = asInt(results?.[0]?.meta?.changes ?? 0);
      const gameChanges = asInt(results?.[1]?.meta?.changes ?? 0);
      if (gameChanges > 1 || receiptChanges > 1) return { error: 'db' };
      return { changed: gameChanges === 1, duplicate: receiptChanges === 0 && await this.hasReceipt(code, nonce), version: expectedVersion + 1 };
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
