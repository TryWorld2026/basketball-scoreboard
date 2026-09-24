-- 房间表：一场比赛一行。整场状态存 JSON 文本，读-改-写 + version CAS 保证并发不丢分。
-- created_at/updated_at 用 ISO-8601 UTC 文本（SQLite 无原生时间类型，字典序即时间序）。
CREATE TABLE IF NOT EXISTS games (
  code TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS games_status_created_idx ON games (status, created_at);
