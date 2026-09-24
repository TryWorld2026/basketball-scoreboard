// 本地内存版假 supabase —— 仅 dev/server.mjs 使用，不进发布包。
// 实现 handler.mjs 用到的查询子集：from/select/eq/lt/limit/insert/update/delete + maybeSingle/single。
// 关键语义：写操作先锁定目标行，maybeSingle 返回受影响行（与 PostgREST 的 .select() 回读一致）。

function project(row, cols) {
  if (!cols || cols === '*') return structuredClone(row);
  const out = {};
  for (const c of cols.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (c in row) out[c] = structuredClone(row[c]);
  }
  return out;
}

class FakeQuery {
  constructor(store) {
    this.store = store;
    this.cols = null;
    this.filters = [];
    this.pending = null;
    this.limitN = null;
    this._result = null; // 写操作后待回读的行
  }
  select(cols) { this.cols = cols || '*'; return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
  lt(col, val) { this.filters.push((r) => new Date(r[col]) < new Date(val)); return this; }
  limit(n) { this.limitN = n; return this; }
  order() { return this; }
  matches() {
    let rows = [...this.store.values()].filter((r) => this.filters.every((f) => f(r)));
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return rows;
  }
  insert(row) { this.pending = { kind: 'insert', row: structuredClone(row) }; return this; }
  update(patch) { this.pending = { kind: 'update', patch: structuredClone(patch) }; return this; }
  delete() { this.pending = { kind: 'delete' }; return this; }
  runPending() {
    if (!this.pending) return { error: null };
    const { kind } = this.pending;
    if (kind === 'insert') {
      const row = this.pending.row;
      if (this.store.has(row.code)) { this.pending = null; return { error: { code: '23505', message: 'duplicate key' } }; }
      this.store.set(row.code, row);
      this._result = [row];
      this.pending = null;
      return { error: null };
    }
    if (kind === 'update') {
      const targets = this.matches(); // 过滤在写入前求值（CAS 条件基于旧 version）
      for (const r of targets) Object.assign(r, structuredClone(this.pending.patch));
      this._result = targets;
      this.pending = null;
      return { error: null };
    }
    const targets = this.matches();
    for (const r of targets) this.store.delete(r.code);
    this._result = [];
    this.pending = null;
    return { error: null };
  }
  async maybeSingle() {
    if (this.pending) {
      const { error } = this.runPending();
      if (error) return { data: null, error };
      const row = this._result[0];
      return { data: row ? project(row, this.cols) : null, error: null };
    }
    const rows = this.matches();
    const row = rows[0];
    return { data: row ? project(row, this.cols) : null, error: null };
  }
  async single() {
    const r = await this.maybeSingle();
    if (!r.error && !r.data) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    return r;
  }
  then(resolve, reject) {
    return Promise.resolve().then(() => {
      if (this.pending) {
        const { error } = this.runPending();
        return { data: null, error };
      }
      return { data: this.matches().map((r) => project(r, this.cols)), error: null };
    }).then(resolve, reject);
  }
}

export function createFakeSupabase(seed = []) {
  const store = new Map();
  for (const row of seed) store.set(row.code, structuredClone(row));
  return {
    _store: store,
    from() { return new FakeQuery(store); },
  };
}
