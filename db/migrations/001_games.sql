-- 001_games.sql —— 篮球计分板首版 schema
-- 受平台迁移 API 的受限 SQL 子集约束：表在 app schema；不使用 DEFAULT / CHECK / 外键 /
-- 裸 RLS 或 GRANT 语句；默认值与 ID 一律由 Function 侧显式供给；
-- 访问权由迁移时的声明式 accessPolicies 表达（见下方注释），不写在 SQL 里。

CREATE TABLE app.games (
  code text PRIMARY KEY,
  status text NOT NULL,
  version integer NOT NULL,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX games_status_created_idx ON app.games (status, created_at);

-- 配套 accessPolicies（提交迁移时使用，完整描述该表的托管状态）：
-- [{ "table": "games", "principal": "anonymous",
--    "actions": ["select", "insert", "update", "delete"], "template": "public" }]
-- 理由：房间数据本身即「持有 4 位房间码者可共享」的临时公开数据，无私密性要求；
-- 数据库密钥只存在于 Function 侧，浏览器不直连数据库，写入必须经 handler 的意图白名单与版本号 CAS。
