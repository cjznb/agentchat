-- AgentChat SQLite schema —— spec §5.1–§5.3、§7、§8 的八张表。
-- 由 server/db.ts 打开数据库时幂等执行（全部 IF NOT EXISTS）。
-- 约定：时间戳统一 epoch 毫秒（INTEGER）；JSON 以 TEXT 存储；
-- 枚举 CHECK 取值与 shared/contracts.ts 锁定枚举逐字一致（SQL 无法 import，此处镜像）。
-- wake_jobs 列结构参考 claude-codex-mcp-bridge（MIT，出处见 AGENTS.md）。

-- 节点（spec §5.1）：混合树（runtime 根/子 + logical），邻接表 + root_id 定位所属树。
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('runtime', 'logical')),
  task_ref    TEXT UNIQUE,                          -- runtime 子注册幂等键（spec §5.2）
  parent_id   TEXT REFERENCES agents(id),           -- NULL = 根
  root_id     TEXT NOT NULL REFERENCES agents(id),  -- 所属树根（根 = 自身）
  vendor      TEXT NOT NULL,                        -- opencode | claude-code | human | —
  model       TEXT NOT NULL DEFAULT '—',
  status      TEXT NOT NULL CHECK (status IN ('online', 'busy', 'offline', 'retired')),
  purpose     TEXT,                                 -- 工作概述（A2A AgentCard）
  skills      TEXT NOT NULL DEFAULT '[]',           -- JSON 数组
  role_tag    TEXT,                                 -- 执行者/组织者/监管者
  remark      TEXT,                                 -- 用户备注
  status_text TEXT,                                 -- 自定义状态
  last_seen   INTEGER NOT NULL,
  retired_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents (parent_id);
CREATE INDEX IF NOT EXISTS idx_agents_root ON agents (root_id);

-- 会话（spec §5.3）：key 唯一，DM = dm:<idA>_<idB>（成员排序），群 = group:<id>。
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
  key        TEXT NOT NULL UNIQUE,
  name       TEXT,                                  -- 群名；DM 无名
  created_by TEXT NOT NULL REFERENCES agents(id),
  created_at INTEGER NOT NULL
);

-- 成员：DM 自动两行；群 = owner 一行 + 每成员一行；human 亦为显式行（隐含成员落库）。
CREATE TABLE IF NOT EXISTS participants (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  role            TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at       INTEGER NOT NULL,
  invited_by      TEXT REFERENCES agents(id),
  PRIMARY KEY (conversation_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_agent ON participants (agent_id);

-- 消息：seq 全局自增（顺序唯一来源，WS 事件序同源），id 短随机码。
CREATE TABLE IF NOT EXISTS messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  from_agent_id   TEXT NOT NULL REFERENCES agents(id),
  body            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('text', 'system')),
  meta            TEXT,                             -- JSON 或 NULL
  idempotency_key TEXT,
  created_at      INTEGER NOT NULL
);
-- 幂等唯一索引（spec §12 重复投递；NULL 不参与冲突，未带 key 的消息不受限）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency
  ON messages (from_agent_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq
  ON messages (conversation_id, seq);

-- 每参与者已读位点（spec §5.4 同步与未读的唯一真相）。
CREATE TABLE IF NOT EXISTS read_states (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  last_read_seq   INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, agent_id)
);

-- join_token 哈希存储（spec §5.2/§5.3；本任务只建表，store 层后续任务提供）。
CREATE TABLE IF NOT EXISTS agent_keys (
  join_token_hash TEXT NOT NULL UNIQUE,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  created_at      INTEGER NOT NULL
);

-- 审批 / 请求批示单（spec §8 + §17；一套状态机两用，checkpoint 2026-09-27）。
-- kind='action'=审批(T7)；kind='ask'=请求批示(§17)；result 存 ask 答复(JSON)。
-- created_at 为 24h TTL 起点；read_at 为单用户 MVP 全局已读（epoch ms，NULL=未读）。
-- 旧库无新列/旧 CHECK 时由 server/db.ts 幂等重建（CHECK 不可 ALTER）。
CREATE TABLE IF NOT EXISTS approvals (
  id                 TEXT PRIMARY KEY,
  requester_agent_id TEXT NOT NULL REFERENCES agents(id),
  kind               TEXT NOT NULL DEFAULT 'action',
  target             TEXT NOT NULL DEFAULT 'human',
  action             TEXT NOT NULL,                 -- 审批动作或 ask 占位
  payload            TEXT NOT NULL,                 -- JSON
  status             TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'answered')),
  result             TEXT,                          -- JSON 或 NULL
  created_at         INTEGER NOT NULL,
  decided_at         INTEGER,
  read_at            INTEGER                        -- epoch ms；NULL = 未读
);

-- 唤醒任务（spec §7；状态机 store 后续任务实现，列结构对齐 bridge 状态机）。
CREATE TABLE IF NOT EXISTS wake_jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id     INTEGER NOT NULL REFERENCES messages(seq),
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  state          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending', 'sending', 'accepted', 'refused', 'expired', 'cancelled')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  retry_at       INTEGER NOT NULL,                  -- 退避 min(30000, 500·2^attempts)
  pending_reason TEXT,                              -- busy | offline
  notified_at    INTEGER,                           -- 失败通知 30min 合并窗口
  detail         TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,                  -- busy 24h 过期基准
  UNIQUE (message_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_wake_jobs_due ON wake_jobs (state, retry_at);
