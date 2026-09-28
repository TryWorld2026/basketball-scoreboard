// 内存版 store —— 只给本地测试网用，不进部署产物。
// 与 worker/store-d1.mjs 实现同一接口，语义对齐：CAS 看影响行数、主键冲突报 duplicate。

export function createFakeStore(seed = []) {
  const rows = new Map();
  for (const g of seed) rows.set(g.code, structuredClone(g));

  return {
    _rows: rows,
    async getGame(code) {
      const row = rows.get(code);
      return row ? structuredClone(row) : null;
    },
    async hasReceipt(code, nonce) {
      return [...rows.values()].some((row) => row.code === code && row.receipts?.includes(nonce));
    },
    async insertGame(game) {
      if (rows.has(game.code)) return { error: 'duplicate' };
      rows.set(game.code, structuredClone(game));
      return { ok: true };
    },
    async casUpdateGame(code, expectedVersion, patch) {
      const row = rows.get(code);
      if (!row || row.version !== expectedVersion) return { changed: false, version: expectedVersion + 1 };
      row.status = patch.status;
      row.version = expectedVersion + 1;
      row.state = structuredClone(patch.state);
      row.updated_at = patch.updated_at;
      return { changed: true, version: row.version };
    },
    async casUpdateGameWithReceipt(code, expectedVersion, patch, nonce) {
      const row = rows.get(code);
      if (!row || row.version !== expectedVersion || (row.receipts || []).includes(nonce)) {
        return { changed: false, duplicate: !!row?.receipts?.includes(nonce), version: expectedVersion + 1 };
      }
      row.status = patch.status;
      row.version = expectedVersion + 1;
      row.state = structuredClone(patch.state);
      row.updated_at = patch.updated_at;
      row.receipts = [...(row.receipts || []), nonce];
      return { changed: true, version: row.version };
    },
    async recordReceipt(code, expectedVersion, nonce) {
      const row = rows.get(code);
      if (!row || row.version !== expectedVersion) return { changed: false };
      if ((row.receipts || []).includes(nonce)) return { changed: false, duplicate: true };
      row.receipts = [...(row.receipts || []), nonce];
      return { changed: true };
    },
    async deleteStaleSetup(beforeIso) {
      for (const [code, row] of [...rows]) {
        if (row.status === 'setup' && row.created_at < beforeIso) rows.delete(code);
      }
    },

    async deleteAbandoned(beforeIso) {
      for (const [code, row] of [...rows]) {
        if (['live', 'break', 'timeout'].includes(row.status) && row.updated_at < beforeIso) rows.delete(code);
      }
    },
  };
}
