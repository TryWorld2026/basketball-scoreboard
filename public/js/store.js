// 比赛状态仓库：每秒轮询 + 服务器时钟偏移 + 断网动作队列。
import { api, ApiError } from './api.js';
import { deriveClock, deriveShot } from './clock.js';

const QUEUE_KEY = (code) => `bsq:${code}`;
const TOKEN_KEY = (code) => `bs-token:${code}`;
const STALE_MS = 3000;
// 队列只有一份上限：内存与 localStorage 共用。超限拒绝新动作并明说，
// 而不是像旧实现那样持久化时静默截断——重开浏览器后那几步就无声无息消失了。
const QUEUE_LIMIT = 50;
// 可以排队等补发的动作：已经发生的事实（得分/犯规/球权）与幂等的归零/24 秒重置。
// 撤销、clock 迁移、终局类的含义依赖"发生的时刻"：迟到落地会吃掉别人后来的操作
// （撤销吞掉队友刚记的分）、或在错误的比赛上锁错局——这些必须联网才发。
const DELAY_SAFE = new Set(['score', 'foul', 'possession', 'clock_zero', 'shot_reset']);
export const isDelaySafe = (action) => DELAY_SAFE.has(action?.type);

// 控制凭证：create 响应里明文只回一次，之后只活在创建比赛的那台设备上。
// 按房间码分键存 localStorage——记分员的手机可能被系统杀后台重开，凭证要活过整场。
export function rememberControlToken(code, token) {
  try { if (token) localStorage.setItem(TOKEN_KEY(code), token); } catch { /* 隐私模式：按无凭证走，服务端 403 会提示 */ }
}
export function controlTokenOf(code) {
  try { return localStorage.getItem(TOKEN_KEY(code)); } catch { return null; }
}
// 「复制控制端链接」用：fragment 不进服务端日志与轮询，只在用户主动分享时出现。
export const controlLinkSuffix = (code) => {
  const t = controlTokenOf(code);
  return t ? `#t=${t}` : '';
};

function readControlToken(code) {
  try {
    const saved = controlTokenOf(code);
    if (saved) return saved;
    const m = /^#t=([0-9a-f]{64})$/.exec(location.hash || '');
    if (m) {
      rememberControlToken(code, m[1]);
      // 凭证不留在地址栏和历史记录里：换设备分享的是链接，不是永久后门
      history.replaceState(null, '', location.pathname + location.search);
      return m[1];
    }
  } catch { /* 无 DOM 环境（测试桩）按无凭证处理 */ }
  return null;
}

// 幂等键：响应丢失后补发同一意图时，服务端据此只记一次
const newNonce = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

export class GameStore {
  constructor(code) {
    this.code = code;
    this.snapshot = null;
    this.offsetMs = 0;
    this.online = true;
    this.loading = true;
    this.fatal = null; // game_not_found 等不可恢复错误
    this.lastOkAt = 0;
    this.queue = [];
    this.listeners = new Set();
    this.token = readControlToken(code);
    this._timer = null;
    this._draining = false;
    this._onVisible = () => { if (!document.hidden) this._tick(); };
    this._loadQueue();
  }

  get state() { return this.snapshot?.state || null; }
  get status() { return this.snapshot?.status || 'setup'; }
  get version() { return this.snapshot?.version ?? 0; }
  now() { return Date.now() + this.offsetMs; }
  stale() { return this.lastOkAt > 0 && this.now() - this.lastOkAt > STALE_MS; }
  clock() { return this.state ? deriveClock(this.state, this.now()) : null; }
  shot() { return this.state ? deriveShot(this.state, this.now()) : null; }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of [...this.listeners]) fn(this); }

  start(pollMs = 1000) {
    this._tick();
    this._timer = setInterval(() => this._tick(), pollMs);
    document.addEventListener('visibilitychange', this._onVisible);
  }
  stop() {
    clearInterval(this._timer);
    document.removeEventListener('visibilitychange', this._onVisible);
  }

  async _tick() {
    try {
      const snap = await api(`/api/game?action=get&code=${encodeURIComponent(this.code)}`);
      this._accept(snap);
      this.loading = false;
      this.online = true;
      this.fatal = null;
      this.emit();
      if (this.queue.length) this._drain();
    } catch (e) {
      this.loading = false;
      if (e.code === 'game_not_found') this.fatal = e;
      else this.online = false;
      this.emit();
    }
  }

  _accept(snap) {
    // 乱序保护：轮询 GET 可能比刚发出的 apply 响应更晚到达。
    // 版本号是权威序号，旧响应直接丢弃，避免快照/版本回退造成瞬态闪回。
    if (this.snapshot && Number.isInteger(snap?.version) && snap.version < this.version) return;
    this.snapshot = snap;
    this.offsetMs = Date.parse(snap.serverTime) - Date.now();
    this.lastOkAt = this.now();
  }

  /** 发送意图。返回 {ok}|{queued}|{conflict,error}|{error} */
  async apply(action) {
    const intent = action && typeof action.nonce === 'string' ? action : { ...action, nonce: newNonce() };
    if (!this.online || this.queue.length) {
      // 延迟不安全的动作（撤销/clock 迁移/终局）不排队：补发的时刻已不是点击的时刻
      if (!isDelaySafe(intent)) return { error: new ApiError('needs_online') };
      if (this.queue.length >= QUEUE_LIMIT) return { error: new ApiError('queue_full') };
      this._enqueue(intent);
      return { queued: true };
    }
    const res = await this._post(intent);
    if (res.ok) return res;
    if (res.error?.code === 'network') {
      // 响应可能已到服务端（Intent applied, response lost）：nonce 原样保留，补发去重
      if (!isDelaySafe(intent)) return { error: new ApiError('needs_online') };
      if (this.queue.length >= QUEUE_LIMIT) return { error: new ApiError('queue_full') };
      this.online = false;
      this._enqueue(intent);
      this.emit();
      return { queued: true };
    }
    if (res.error?.code === 'conflict' || res.error?.status === 409) { await this._tick(); return { conflict: true, error: res.error }; }
    return res;
  }

  async _post(action) {
    try {
      const snap = await api('/api/game?action=apply', {
        method: 'POST',
        body: { code: this.code, version: this.version, action },
        token: this.token,
      });
      this._accept(snap);
      return { ok: true, state: snap.state };
    } catch (error) {
      return { error };
    }
  }

  _enqueue(action) { this.queue.push(action); this._saveQueue(); }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    while (this.queue.length) {
      const res = await this._post(this.queue[0]);
      if (res.ok) { this.queue.shift(); this._saveQueue(); this.online = true; this.emit(); continue; }
      if (res.error?.code === 'network') break; // 稍后随轮询重试
      this.queue.shift(); this._saveQueue(); // 业务错误：丢弃该动作并提示
      this.emit();
      this.lastBusinessError = res.error;
      break;
    }
    this._draining = false;
  }

  _saveQueue() {
    // 内存队列已被 apply 挡在 QUEUE_LIMIT 内，这里不再是第二套上限
    try { localStorage.setItem(QUEUE_KEY(this.code), JSON.stringify(this.queue)); } catch { /* 隐私模式 */ }
  }
  _loadQueue() {
    try {
      const raw = localStorage.getItem(QUEUE_KEY(this.code));
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        // 旧版本可能存过延迟不安全的动作（撤销/clock 迁移）：补发的时刻已错，宁可不发
        this.queue = parsed.filter((a) => a && typeof a.type === 'string' && isDelaySafe(a)).slice(-QUEUE_LIMIT);
      }
    } catch { this.queue = []; }
  }
}
