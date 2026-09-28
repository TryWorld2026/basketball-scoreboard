-- 操作审计：每一次落地写一条——谁（凭证指纹，不明文）、何时、什么动作、比分从多少变成多少。
-- 赛后吵架时这是唯一能回溯的事实源；reset 重开不清日志（终局被擦掉这件事本身必须留痕）。
-- 与比赛行级联删除：半途放弃局清理时日志一起走；已结束的比赛连日志永久保留。
CREATE TABLE IF NOT EXISTS action_log (
  code TEXT NOT NULL REFERENCES games(code) ON DELETE CASCADE,
  seq INTEGER NOT NULL,          -- 落地后的 version，天然时间序
  actor TEXT NOT NULL,           -- 控制凭证 SHA-256 前 8 位（足以区分设备，不泄露凭证本身）
  action TEXT NOT NULL,          -- 意图 JSON 原样（含 nonce，可和补发对账）
  before_score TEXT NOT NULL,    -- "24:22"
  after_score TEXT NOT NULL,
  clock_ms INTEGER NOT NULL,     -- 动作时刻的比赛时钟剩余（屏幕显示值，不是库里字段）
  at TEXT NOT NULL,
  PRIMARY KEY (code, seq)
);

CREATE INDEX IF NOT EXISTS action_log_code_idx ON action_log (code, seq);
