// 比赛状态仓库：每秒轮询 + 服务器时钟偏移 + 断网动作队列。
import { api } from './api.js';
import { deriveClock, deriveShot } from './clock.js';

const QUEUE_KEY = (code) => `bsq:${code}`;
const STALE_MS = 3000;

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
    this.snapshot = snap;
    this.offsetMs = Date.parse(snap.serverTime) - Date.now();
    this.lastOkAt = this.now();
  }

  /** 发送意图。返回 {ok}|{queued}|{conflict,error}|{error} */
  async apply(action) {
    const intent = action && typeof action.nonce === 'string' ? action : { ...action, nonce: newNonce() };
    if (!this.online || this.queue.length) { this._enqueue(intent); return { queued: true }; }
    const res = await this._post(intent);
    if (res.ok) return res;
    if (res.error?.code === 'network') { this.online = false; this._enqueue(intent); this.emit(); return { queued: true }; }
    if (res.error?.code === 'conflict' || res.error?.status === 409) { await this._tick(); return { conflict: true, error: res.error }; }
    return res;
  }

  async _post(action) {
    try {
      const snap = await api('/api/game?action=apply', {
        method: 'POST',
        body: { code: this.code, version: this.version, action },
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
    try { localStorage.setItem(QUEUE_KEY(this.code), JSON.stringify(this.queue.slice(0, 50))); } catch { /* 隐私模式 */ }
  }
  _loadQueue() {
    try {
      const raw = localStorage.getItem(QUEUE_KEY(this.code));
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) this.queue = parsed.filter((a) => a && typeof a.type === 'string').slice(0, 50);
    } catch { this.queue = []; }
  }
}
