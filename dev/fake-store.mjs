// 内存版 store —— 只给本地测试网用，不进部署产物。
// 与 worker/store-d1.mjs 实现同一接口，语义对齐：CAS 看影响行数、主键冲突报 duplicate。

export function createFakeStore(seed = []) {
  const rows = new Map();
  const logs = new Map(); // code -> 审计条目（与 games 行同生同死）
  for (const g of seed) rows.set(g.code, structuredClone(g));

  const pushLog = (code, seq, e) => {
    if (!logs.has(code)) logs.set(code, []);
    logs.get(code).push({ seq, ...structuredClone(e) });
  };

  return {
    _rows: rows,
    _logs: logs,
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
    async casUpdateGame(code, expectedVersion, patch, logEntry = null) {
      const row = rows.get(code);
      if (!row || row.version !== expectedVersion) return { changed: false, version: expectedVersion + 1 };
      row.status = patch.status;
      row.version = expectedVersion + 1;
      row.state = structuredClone(patch.state);
      row.updated_at = patch.updated_at;
      // 与 D1 适配器一致：只有真落地了才记审计
      if (logEntry) pushLog(code, expectedVersion + 1, logEntry);
      return { changed: true, version: row.version };
    },
    async casUpdateGameWithReceipt(code, expectedVersion, patch, nonce, logEntry = null) {
      const row = rows.get(code);
      if (!row || row.version !== expectedVersion || (row.receipts || []).includes(nonce)) {
        return { changed: false, duplicate: !!row?.receipts?.includes(nonce), version: expectedVersion + 1 };
      }
      row.status = patch.status;
      row.version = expectedVersion + 1;
      row.state = structuredClone(patch.state);
      row.updated_at = patch.updated_at;
      row.receipts = [...(row.receipts || []), nonce];
      if (logEntry) pushLog(code, expectedVersion + 1, logEntry);
      return { changed: true, version: row.version };
    },

    async getLog(code, limit = 200) {
      const entries = [...(logs.get(code) || [])].sort((a, b) => b.seq - a.seq).slice(0, limit);
      return { entries: structuredClone(entries) };
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
        if (row.status === 'setup' && row.created_at < beforeIso) { rows.delete(code); logs.delete(code); }
      }
    },

    async deleteAbandoned(beforeIso) {
      for (const [code, row] of [...rows]) {
        if (['live', 'break', 'timeout'].includes(row.status) && row.updated_at < beforeIso) { rows.delete(code); logs.delete(code); }
      }
    },
  };
}
