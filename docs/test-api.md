# `/api/test/*` 测试接口

面向**自动化测试与真机联调**的 HTTP 接口面：造数据、驱动会话与群聊、删除数据、改名字、断言库内真实状态。

> ⚠️ **这是测试面，不是生产面。** 接口含不可恢复的破坏性操作（清库、硬删节点、删除会话）。
> 默认**不挂载**，必须显式开启；且**仅回环**（127.0.0.1 / ::1）可用。
> **绝不要**对真实数据目录（`~/.agentchat`）开启本接口。

## 1. 开关

优先级：env `AGENTCHAT_TEST_API` > `<home>/config.json` 的 `testApi` > 默认 `false`。

```powershell
# PowerShell（Windows）
$env:AGENTCHAT_TEST_API = "1"
$env:AGENTCHAT_NO_OPEN  = "1"
npm start
```

```bash
# bash / zsh
AGENTCHAT_TEST_API=1 AGENTCHAT_NO_OPEN=1 npm start
```

```bash
# 通过 CLI（等价于上面的 env）
node bin/agentchat.mjs --test-api --no-open --home ./.test-data
```

开启后启动时会打印一条醒目告警（含端口与库路径）。关闭时 `/api/test/*` 全部返回 **404**（`server/index.ts` 的 `notFound` 对 `/api` 前缀返回纯文本 `Not Found`，不泄露路由存在性）。

隔离测试数据：始终配合临时 `AGENTCHAT_HOME`，例如

```powershell
$env:AGENTCHAT_HOME = Join-Path $env:TEMP ("agentchat-test-" + [guid]::NewGuid())
```

## 2. 通用约定

- 全部响应为 JSON；错误形如 `{"ok":false,"error":"<稳定错误码>"}`，必要时附 `detail` / `refs` / `count`。
- 非回环来源 → `403 {"ok":false,"error":"forbidden"}`。
- 非 JSON 请求体 / 校验失败 → `400 invalid_body`。
- 本模块无全局 `onError`，所有异常自转 JSON；兜底 `500 internal_error`（附 `detail`）。
- 参数里的 agent 引用可以是 **agent id** 或 **系统名**（`agents.name`）；会话引用可以是 **会话 id** 或 **会话 key**（`dm:<idA>_<idB>` / `group:<id>` / `shout`）。
- 缺省执行主体是 **human**（`ensureHuman`），因此走的是 UI 同款路径（human 过闸即执行、不产生审批单）；显式传 `from` 时按该 agent 走真实路径（可能产生审批单）。

## 3. 端点总表

### 3.1 探活 / 数据

| 方法 | 路径 | 请求体 | 成功响应 | 失败码 |
| --- | --- | --- | --- | --- |
| GET | `/api/test/ping` | – | `{ok:true,enabled:true}` | 403 `forbidden` |
| GET | `/api/test/dump` | – | `{ok:true,agents,conversations,participants,messages,approvals,wakeJobs,readStates,agentKeys}` | 403 |
| POST | `/api/test/reset` | `{confirm:"RESET"}` | `{ok:true}` | 400 `invalid_body` |
| POST | `/api/test/seed` | 见下 | `{ok:true,agents,conversations,messages}` | 400 `invalid_body` / `seed_ref_not_found` |

- `dump` 返回各表 `SELECT *` 的**原始行（snake_case 列名）**，用于直接断言库内状态；`messages` 按 `seq` 升序。
- `reset` 就地清空并重建全部业务表（`clearAllTables`）：**不做快照备份、不删适配器文件**。
  需要「备份 + 清适配器侧文件（`hub_token`/`tokens`/`agents`/`logs`/`backups`/`config.json`）」请用生产管理端点 `POST /api/admin/reset`。

#### `POST /api/test/seed`

一次性造夹具。**先完成全部引用解析再落库**：任一引用解析失败 → 400 `seed_ref_not_found` 且**零写入**。

```jsonc
{
  "agents": [
    { "name": "甲", "vendor": "opencode", "kind": "logical", "status": "online",
      "taskRef": "t-1", "parentId": "甲", "roleTag": "执行者", "purpose": "…" }
  ],
  "conversations": [
    { "kind": "dm", "a": "甲", "b": "乙", "ref": "dm-1" },
    { "kind": "group", "name": "作战室", "createdBy": "甲", "memberIds": ["乙"], "ref": "g-1" }
  ],
  "messages": [
    { "conversationKey": "g-1", "from": "甲", "body": "开工", "kind": "text" },
    { "conversationId": "<真实会话 id>", "from": "乙", "body": "收到", "idempotencyKey": "k1" }
  ]
}
```

- `agents`：store 直插。默认 `vendor:"opencode"`、`kind:"logical"`、`status:"online"`。
- `conversations`：`dm` 走 `createDm`（幂等取或建）、`group` 走 store `createGroup`（**不过审批闸**，专为造夹具）。`ref` 是本次请求内的测试别名。
- `messages`：store 直写，**不触发 wake / 不推送 WS**（造历史数据用）。要驱动真实投递请用 §3.5 的发送端点。

实现口径（测试断言请照此）：

| 情形 | 结果 |
| --- | --- |
| `messages` 项**恰好**给 `conversationId` 或 `conversationKey` 之一 | 必须；都缺或都给 → 400 `invalid_body` |
| 同一请求内 `ref` 别名重复 | 400 `invalid_body` |
| 同一请求内 agent 重名 / 与库内既有 agent 重名 | 409 `name_taken` |
| `parentId` 前向引用（父也由本请求创建） | 支持（内部拓扑排序）；成环 → 400 `seed_ref_not_found`（`detail` = 卡住的父引用） |
| 新会话的真实 `group:<新id>` / `dm:...` | **不可**在同一个请求的 `messages` 里引用（id 创建时才生成）——请用本请求的 `ref` 别名 |
| DM 两端指向**同一节点**（同名，或名字与 id 混写指同一人） | 400 `invalid_body`（`createDm` 无法为同一 agent 插两行成员） |
| 任何引用解析失败 / 任何写入失败 | **整请求零写入**（单事务 + 写前全量预解析，比"尽力而为"更严） |

### 3.2 会话（DM + 群通用）

| 方法 | 路径 | 请求体 | 成功响应 | 失败码 |
| --- | --- | --- | --- | --- |
| GET | `/api/test/conversations` | – | `{ok:true,conversations:[{…会话, participants, messageCount, lastSeq}]}` | 403 |
| POST | `/api/test/conversations` | `{kind:"dm",a,b}` 或 `{kind:"group",name,memberIds?}` | `{ok:true,conversation}` / `{ok:true,approval}` | 400 / 404 `agent_not_found` |
| PATCH | `/api/test/conversations/:id` | `{name}`（trim 1..64，禁控制字符） | `{ok:true,conversation}` | 400 / 404 `conversation_not_found` |
| DELETE | `/api/test/conversations/:id` | – | `{ok:true,deleted:{messages:<n>}}` | 404 `conversation_not_found` |
| GET | `/api/test/conversations/:id/messages` | `?before&limit`（limit 1..200） | `{ok:true,messages}` | 400 `invalid_before`/`invalid_limit` |
| POST | `/api/test/conversations/:id/messages` | `{from?,body,mentions?,idempotencyKey?}` | `{ok:true,…SendMessageResult}` | 见下 |
| POST | `/api/test/conversations/:id/purge` | – | `{ok:true,deleted:<n>}` | 404 |
| POST | `/api/test/conversations/:id/read` | `{agentId?}` | `{ok:true,lastReadSeq}` | 404 |

- **DM 与群都可删**：`DELETE` 走 `deleteConversationCascade`，按外键现实级联删除
  `wake_jobs → messages → read_states → participants → conversations`（单事务）。
- `POST` 建 DM 时若 `a` 与 `b` 解析到**同一节点** → 400 `invalid_body`（不是 500）。
- `PATCH` 改名对 DM 也生效（写 `conversations.name`，UI 对 DM 仍显示对方名）。
- `POST …/messages` 走**真实投递**（`core/messaging.sendMessage`：写 wake_jobs + 推送 WS）。错误码：
  404 `conversation_not_found` / 404 `agent_not_found` / 404 `recipient_not_found` /
  403 `not_participant` / 409 `self_send` / 409 `container_not_chat_target`。
- `purge` 只清消息（含其 wake_jobs），保留会话与成员；`read` 把读位点推到该会话最新 seq。

### 3.3 群成员与解散

| 方法 | 路径 | 请求体 | 成功响应 | 失败码 |
| --- | --- | --- | --- | --- |
| POST | `/api/test/conversations/:id/members` | `{agentId,role?}` | `{ok:true}` / `{ok:true,approval}` | 404 `agent_not_found` |
| POST | `/api/test/conversations/:id/members/remove` | `{agentId}` | `{ok:true}` | 404 `conversation_not_found` / 400 `not_group` / 404 `not_in_group` / 409 `cannot_remove_last_member` |
| POST | `/api/test/conversations/:id/dissolve` | – | `{ok:true}` | 404 `conversation_not_found` / 400 `not_group` |

- `members` 走 `core/messaging.addParticipant`（human 直通；入群 system 通知在 core 内）
- `members/remove` 与 `dissolve` 与生产端点 `POST /api/groups/:id/members/remove`、`POST /api/groups/:id/dissolve`
  **共用同一实现**（`server/core/group-ops.ts`），错误码/守卫序/通知文案逐字一致。
- `members/remove` 的 `agentId` 支持 id 或系统名；解析不到时按原值透传，最终落 404 `not_in_group`
  （而不是另立错误码）。
- `…/read` 的 body 可**整体省略**（等价 `{}`，缺省 reader = human）。
- 两个操作都会写 `kind=system` 的通知消息（`meta.action` = `group_remove` / `group_dissolve`）后再落库删除。

### 3.4 消息

| 方法 | 路径 | 成功响应 | 失败码 |
| --- | --- | --- | --- |
| DELETE | `/api/test/messages/:id` | `{ok:true}` | 404 `message_not_found` |

按消息**短 id** 删除单条，同时删除引用它的 `wake_jobs`（否则触发外键失败）。撤回（软删）请用生产端点
`POST /api/conversations/:id/messages/:messageId/revoke`。

### 3.5 节点（agent）

| 方法 | 路径 | 请求体 / 查询 | 成功响应 | 失败码 |
| --- | --- | --- | --- | --- |
| GET | `/api/test/agents` | – | `{ok:true,agents}` | 403 |
| POST | `/api/test/agents` | `{name,vendor?,kind?,status?,taskRef?,parentId?,roleTag?,purpose?,model?}` | `{ok:true,agent}` | 400 `invalid_body` / 404 `agent_not_found`（父）/ 409 `name_taken` |
| PATCH | `/api/test/agents/:id` | `{name}` | `{ok:true,name}` | 400 / 404 `agent_not_found` / 409 `name_taken` |
| DELETE | `/api/test/agents/:id?mode=retire\|hard&force=1` | – | `{ok:true,mode,agent\|report}` | 404 / 409 `agent_has_children` / 409 `agent_in_use` |

- `POST` 的 `status` 只接受 `online|busy|offline`（`retired` 请用退役端点）；改名与生产端点
  `PATCH /api/agents/:id` 同语义（展示名唯一索引、成功后广播 `agent` 树事件）。
- `DELETE` 缺省 `mode=retire`：软退役（`status='retired'`，行保留、树上灰显、取消未投递唤醒）。
- `mode=hard`：**物理删除，不可恢复**。守卫：
  1. 有子节点（`parent_id` 或 `root_id` 指向它）→ `409 agent_has_children`（带 `count`），`force` 也不删子节点；
  2. 无 `force` 且自身有消息 / 审批单 / 创建的会话 → `409 agent_in_use`（带 `refs` 计数明细）；
  3. `force=1` 时级联清理：其创建的会话整体级联删除 → 其剩余消息（及其 wake_jobs）→ 审批单 →
     已读位点 → 成员行 → `participants.invited_by` 置 NULL → `agent_keys` → 作为唤醒目标的 wake_jobs → `agents` 行。
  响应 `report` 给出各项真实删除行数：**口径 = 本次操作在相关表上实际减少的行数（含级联删除的副作用行数）**，
  即 `report.deletedMessages` 会包含「该 agent 创建的会话里**他人**的消息」；唯一例外 `clearedInvites`
  是 UPDATE 置 NULL 的 `.changes`（不是删除）。调用方据此对账「库里无残留」。
  守卫失败路径（409）**零写入**；`force` 全程单事务，失败回滚。

### 3.6 喊话

| 方法 | 路径 | 请求体 | 成功响应 |
| --- | --- | --- | --- |
| POST | `/api/test/shout` | `{from?,body}` | `{ok:true,…SendMessageResult}` / `{ok:true,approval}` |

- `from` 缺省 human（过闸即执行）；传 **子节点 / 逻辑节点**时 `gate` 直接拒绝 → **403 `forbidden`**；
  传**持 hub 身份的 runtime 根**时落审批单 → `{ok:true,approval}`（且不广播）；
  `from` 解析不到 → 404 `agent_not_found`。错误码与核心闸门同源。

## 4. 典型真机测试流程

```powershell
$home = Join-Path $env:TEMP ("agentchat-e2e-" + [guid]::NewGuid())
$env:AGENTCHAT_HOME = $home; $env:AGENTCHAT_TEST_API = "1"; $env:AGENTCHAT_NO_OPEN = "1"; $env:AGENTCHAT_PORT = "4737"
Start-Process -FilePath "npm" -ArgumentList "start" -WorkingDirectory "D:\projects\agent\agentchat" -WindowStyle Hidden

# 1) 探活
Invoke-RestMethod http://127.0.0.1:4737/api/test/ping

# 2) 造夹具（零审批、不唤醒）
$seed = @{ agents = @(@{name="甲"},@{name="乙"},@{name="丙"})
           conversations = @(@{kind="group";name="作战室";createdBy="甲";memberIds=@("乙","丙");ref="g1"})
           messages = @(@{conversationKey="g1";from="甲";body="第一条"}) } | ConvertTo-Json -Depth 8
Invoke-RestMethod http://127.0.0.1:4737/api/test/seed -Method Post -ContentType application/json -Body $seed

# 3) 驱动真实投递 + 断言库内状态
Invoke-RestMethod http://127.0.0.1:4737/api/test/dump | ConvertTo-Json -Depth 6

# 4) 清理（按会话 / 按节点 / 整体）
#    DELETE /api/test/conversations/:id
#    DELETE /api/test/agents/:id?mode=hard&force=1
#    POST   /api/test/reset  -Body '{"confirm":"RESET"}'
```

## 5. 实现位置

| 关注点 | 文件 |
| --- | --- |
| 路由与编排 | `server/routes/test.ts` |
| 挂载开关 | `server/index.ts`（`AppOptions.testApi`）、`server/config.ts`（`testApi`） |
| 群操作唯一实现 | `server/core/group-ops.ts`（与 `server/routes/groups.ts` 共用） |
| 存储原语 | `server/store/conversations.ts`、`server/store/messages.ts`、`server/store/agents.ts` |
| 集成测试 | `tests/integration/test-api.test.ts` |
