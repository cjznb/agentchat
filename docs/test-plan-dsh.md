# DSH 端消息同步测试方案（第一步：测试与探查）

> 范围：**只测 DSH 端**（Hub + `adapters/dsh` 插件 + MCP 工具面）。opencode/其它适配器不在本轮。
> 目的：把"消息怎么排队、什么时候送达、为什么有人收不到提醒"变成**可复现、可断言的状态迁移**，
> 并为后续「统一安排的群聊功能测试」提供可直接执行的用例集。

## 0. 结论目标（本轮要回答的问题）

| # | 问题 | 判定方式 |
|---|---|---|
| Q1 | 消息在 Hub 侧的状态迁移是否如设计：排队 → 在途 → 已送达 → 已读 | 测试适配器逐跳断言 `wake_jobs` 与四级回执 |
| Q2 | "忙碌中收不到"到底卡在哪一跳、延迟多久 | busy 场景量化时间戳差 |
| Q3 | "有概率有人收不到提醒"的结构性原因 | 群聊多收件方逐个 flush 的对照实验 |
| Q4 | 离线/逻辑节点/喊话/群成员的投递差异 | 分场景断言 |
| Q5 | agent 是否知道工具怎么用、何时用 | 工具描述审计 + 真机问询（另一路） |
| Q6 | 容器节点为何能入群并导致身份串用 | 守卫链审计 + 复现实验（另一路） |

## 1. 状态模型（测试断言的唯一口径）

**四级回执**（`shared/contracts.ts:26`）：`queued → sending → delivered → read`

**投递台账 `wake_jobs.state`**（`server/store/wake.ts`）：`pending | sending | accepted | refused | expired | cancelled`
- `pending` = **排队中**（`pending_reason='busy'` 表示因忙碌排队；`null` 表示空闲/离线排队）
- `sending` = **在途**（被认领，30s 租约 `CLAIM_TIMEOUT_MS`；崩溃未回执则过期重投）
- `accepted` = **已送达**（唯一来源是适配器回报 `delivered`；`store/wake.ts:274-303`）

**节点状态**：`online | busy | offline | retired`（`idle` 是适配器上报值，Hub 落库为 `online`；**子节点永不置 offline**，409 `child_never_offline`）

**关键常量**：`CLAIM_TIMEOUT_MS=30s`、`BUSY_TTL_MS=24h`、`REFUSAL_LIMIT=2`、退避 `min(30s, 500ms·2^attempts)`、`DUE_JOBS_PER_TICK=200`

**两条投递路径**
- **runtime 节点**：必须在 `wake_jobs` 有行才会被投递（非 system 消息无 job → 跳过，`server/routes/internal.ts:155-167`）；system 消息豁免（ask 卡/入群通知必达）。
- **logical / human**：不建 job、不门控，`/internal/wake` 只"取件"。

## 2. 测试分层

| 层 | 载体 | 是否需要 LLM | 用途 |
|---|---|---|---|
| **L0** | `adapters/test/`（本轮新增的**测试适配器**） | **不需要** | 无头假宿主：真注册/真状态上报/真取件闭环（复用 `adapters/dsh/lib/*`），`deliver` 可编程（delivered/refused/慢/抛错），全覆盖状态断言 |
| **L1** | `adapters/dsh/__tests__/*` | 不需要 | 插件逻辑单测（会话提示、原生工具、桥、安装器） |
| **L2** | 真机 DSH（真实会话） | 需要 | 端到端观感验证：真实 agent 是否收到、是否会用工具、群聊是否正常 |

L0 就是用户要的"脱离 LLM 测完整流程"：**新建会话不再靠与 agent 对话**，而是用 `register` 工具直接建节点
（`task_ref` 认领会话节点）；**设置联系人状态**用 `POST /internal/state`；**发送消息/查询消息状态**用 MCP 工具
`send` / `message_status` / `inbox` / `ack`；**库内真相**用 `GET /api/test/dump`。

测试适配器的调用形态（冻结）：

```powershell
# 自动化（进程内真 Hub + 临时 home）
npx vitest run adapters/test/__tests__/host.test.ts

# 真机步骤化场景（自己起 Hub、跑完自动清理；不会碰 ~/.agentchat）
node adapters/test/cli.mjs --scenario all --spawn --poll-ms 200
node adapters/test/cli.mjs --scenario busy --spawn        # 单场景
```

## 3. 详细测试步骤

每条给出：**目的 / 命令 / 观测点 / 期望 / 失败判据**。命令一律用测试适配器；括号内是等价的原始接口。

### S1 环境自举
- 目的：确认测试面与 Hub 可用且**不触碰真实数据目录**。
- 命令：`node adapters/test/cli.mjs --scenario states --spawn`
- 观测：启动日志出现 `⚠ 测试接口已开启`；`GET /api/health` 200；临时 home 在进程结束后被删除。
- 失败判据：写入了 `~/.agentchat`；或 404/连接失败。

### S2 无 LLM 建会话（替代"与 agent 对话"）
- 目的：证明会话节点可被纯接口创建/认领。
- 步骤：`register {name:'dsh@test', role_tag:'container', vendor:'dsh'}` → 得根 id；再 `register {name:'会话A', parent_ref:<根>, task_ref:'sess-A', vendor:'dsh'}` → 得会话 id。
- 观测：`GET /api/test/dump` 的 `agents` 出现两行，子行 `parent_id`=根、`task_ref='sess-A'`、`role_tag` 为容器/非容器各按入参。
- 期望：第二次同 `task_ref` 再注册**认领同一节点**（幂等，不新增行）。
- 失败判据：新增重复行；或 `retired` 节点拒绝重注册（单向门）。

### S3 状态流转与心跳
- 步骤：`online → busy → idle`（落库 `online`）；对**子节点**报 `offline`；对**根**报 `offline`。
- 期望：前三次 200；子节点 `offline` → **409 `child_never_offline`**；根 `offline` → 200。
- 失败判据：子节点被置 `offline`；或 `busy` 在节点已被读路径落 `offline` 后持续 409（须先复报 `idle/online` 重激活）。

### S4 DM 全生命周期（Q1 主证据）
- 步骤：A、B 均 `online` → A `send {to:B, body:'x'}` → ①不 flush 时 dump；②B flush；③再 flush 一次；④A `message_status {ids:[...]}`。
- 期望：①B 的 `wake_jobs` 有行 `state='pending'`，回执 stage=`queued`（**排队**）；②`deliveries` +1、job→`accepted`、A 看到的 B 回执 = `delivered`（**送达**）；③**不重复注入**（seen 去重），只补回执；④`read` 仅在 B 走 `ack`/读位点后出现。
- 失败判据：①无 job（说明门控/收件方解析错）；②注入但 job 非 `accepted`；③重复注入同一条。

### S5 群聊多收件方（Q3 主证据）
- 步骤：建群（owner + 3 名 runtime 成员）→ 群内 `send` → 逐个成员 flush → 记录"谁被 flush 前始终无回执"。
- 期望：每名成员**各自**一行 job、各自注入一次、各自 `accepted`；**未被 flush 的成员在没有触发者时保持 `queued`**（这就是"只能手动查看"的结构性来源）。
- 失败判据：某成员**根本没有 job**（=真的漏投，非"没轮到"）。

### S6 忙碌中的投递时机（Q2 主证据）
- 步骤：B 置 `busy` → A 发消息 → 等 3 个轮询周期不 flush → dump 看 job 与 `pending_reason` → B 置 `idle` → flush。
- 观测：**记录发送时刻与最终送达时刻的毫秒差**，以及这段区间内 job 的状态与 `attempts`（是否被 dispatcher 尝试过、退避到多少）。
- 期望（P3 之后，task-9）：忙碌期间适配器**继续取件**，消息在**最近的 step 边界**经 `steer` 注入（默认每个 busy 回合最多 1 次插入，`busyInjectMax`；忙时心跳上报 `busy` 而非 `idle`）。**回退开关** `busyInject:false` 可恢复旧行为（忙时不取件，消息排队到回合结束）。
- 失败判据：忙碌期间消息被丢弃；或 `idle` 后仍长时间不投（退避未复位）；或忙时心跳把 Hub 上的 `busy` 翻成 `online`。

### S7 注入被拒（refused）
- 步骤：B 的 deliver 设 `refused` → flush → 再 flush。
- 期望：job **不是** `accepted`；`message_status` 中 B 仍非 `delivered`；再 flush 仍会重投（`refused` 不写 seen，`flush.js:12`）。
- 失败判据：被拒后误记 `delivered`；或永不再投。

### S8 在途租约与崩溃重投
- 步骤：flush 认领后**不回报执** → 立即再 flush → 把时钟推过 30s 租约 → 再 flush。
- 期望：租约内不重复认领；过期后**重投**；已成功注入过的消息因 seen 去重**只补回执不重复注入**。
- 失败判据：租约内重复认领；或过期后不再投（消息永久卡在 `sending`）。

### S9 离线收件方
- 步骤：B `online → offline`（合法路径；先 online 才能 offline）→ A 发消息 → dump → B 回 `online` → flush。
- 观测：如实记录离线时**是否建 job**（`store/wake.ts:156-160` 的设计是"一律建 job，`pending_reason=null`"），以及 `online` 上报是否 `makeJobsDue`。
- 失败判据：离线消息在 B 上线后永远取不到。

### S10 喊话广播
- 步骤：某会话 `shout` → dump 看广播会话（`key='shout'`、无 participants）→ 逐个 runtime 节点 flush。
- 期望：每个 runtime 收件方各一行 job；逻辑节点不建 job 但可取件。
- 失败判据：广播会话被建了 participants；或收件方数量与 roster 不符。

### S11 撤回与清空对投递的影响
- 步骤：A 发消息 → B 未读时 A 撤回（HTTP 或 MCP）→ B flush；再对会话 `purge` 后 flush。
- 期望：已撤回消息**绝不进注入文本、不补建 job**（`internal.ts:150-152`）；清空后无残留 job。
- 失败判据：撤回原文被注入；或 job 残留导致反复空转。

### S12 真机 DSH 端到端（L2，人工）
- 前置：真实 Hub + 装了 `adapters/dsh` 的 DSH；两个会话（或一个会话 + 一个群）。
- 步骤：会话 A 里让 agent 调 `roster` 找到 B → `send` 给 B → 观察 B 是否被唤醒、多久、注入文本长什么样；再在群里发一条并观察**每个**成员。
- 记录：DSH 侧会话日志（`<AGENTCHAT_HOME>/logs/plugin.log` 之类）、Hub 侧 dump 快照、时长。
- 期望与失败判据：与 L0 的状态迁移一致；不一致处即为宿主侧特有问题（例如宿主只在 idle 才允许注入）。

#### S12 前置检查（**不满足则结论无效**）

| 检查 | 判据 | 不通过时的现象 |
|---|---|---|
| Hub 在运行 | `GET <base>/api/health` 200；适配器日志不再刷 `实例节点注册失败` | 所有会话都收不到（本机实测过：Hub 未运行时日志每 2s 一轮失败、19 个会话未注册） |
| 出站身份是**会话节点**而非容器 | `<AGENTCHAT_HOME>/agents/dsh.current` 存在；日志无 `出站身份 …（取自 …agents\dsh.id）` | 消息会以 `dsh@<host>` 容器署名（"所有人都用父节点身份发言"） |
| 顶层会话恰好 1 个 | 关掉其余会话后再测 | ≥2 个顶层会话时 `dsh.current` 被删除 → 回落容器身份 |
| 观察注入是否真的进了模型 | DSH 会话 transcript 里出现 `[AgentChat] …` 的 user 消息 | Hub 显示 `accepted` 但 transcript 无内容 = 宿主持有了但模型没看见 |

#### S12 的 agent 问答清单（验证"是否真的会用工具"）

在 DSH 里新开一个会话（保持顶层会话恰好 1 个），**先不给任何提示**，逐条问：

1. 「群聊里该怎么发言？」→ 期望答：`send` 且 `to=<群会话 id>`，群 id 从 `group{op:"list"}` 取，**并主动说出"我必须是这个群的成员"**。答"用 group 发"或"先把父容器拉进群"= 失败。
2. 「给 X 发消息怎么发？」→ `send{to:<X 的 agent id>}`（自动建私聊），不是先 `ask`。
3. 「`dsh@<host>` 我能给它发消息吗？」→ 答**不能**：它是 `role_tag=container` 的分组容器，报 `container_not_chat_target`，要发给它下面的会话节点。
4. 「群里被 @ 了怎么回？」→ 用 `send` 回到**同一会话 id**，只回一次、不寒暄。
5. 「什么时候用 ask、什么时候用 send？」→ ask 要选项/决策、需已有共同会话、群问要 `mentions`。
6. 「等回信会怎么等？」→ `wait{until,timeoutMs}` 阻塞；超时后用 `message_status` 查四级回执，而不是反复重发。
7. 反向验证：「把 `register` 工具的描述念一遍」→ 念不出说明描述/`instructions` 没进上下文（问题在宿主侧，需要先解决可发现性投放通道）。

（问答清单与 `P4` 任务的 DoD 对应；L0/L1 只锁机械断言，措辞是否真的被理解只能在 L2 判。）


## 4. 针对用户报告问题的定位实验

| 实验 | 步骤 | 判定 |
|---|---|---|
| **E1 忙碌延迟** | S6，记录 `t_send → t_delivered` | 若延迟 ≈ 轮询周期/直到回合结束，则根因在"仅 idle 取件" |
| **E2 漏提醒** | S5，先不 flush 任何成员，只 flush 一半，再 dump 比对 | 若某成员无 job → 真漏投（服务端）；若有 job 但无触发者 → 适配器侧无轮询/无事件（宿主侧） |
| **E3 工具不可发现** | 真机问 agent"群聊里怎么发言/容器是什么"；并 dump `tools/list` 的 description | 回答含糊或工具描述缺少"何时用/何时不用" → 可发现性缺口 |
| **E4 容器身份** | 复现：把根容器加入群 → 让两个会话各发一条 → 看 `from_agent_id` | 若都变成根容器 id → 身份回落（`agents/dsh.current` 0 或 ≥2 顶层会话）；根因定位到 `lib/session-hint.js` + 桥的回落语义 |

## 5. 记录与产物

每次运行保留：①测试适配器输出（状态迁移表）；②`GET /api/test/dump` 的 JSON 快照（含 `wake_jobs`）；③Hub 与适配器日志；④失败场景的最小复现步骤。
产物统一放 `D:\projects\agent\.artifacts\`（**不进仓库**）。

## 6. 退出标准

- L0 全部场景 PASS（`--scenario all`），且状态断言与本文口径一致；
- Q2/Q3 有**量化结论**（延迟中位数、漏投命中率与触发条件）；
- 遗留项逐条标注：是"设计如此"、"宿主侧限制"还是"待修缺陷"。

## 7. 观测口径与陷阱（真机教训，2026-11-10/11 追加）

> 这一节是**断言口径**的强制约定：下面每条都是真机上踩过的坑，写错口径会得到相反的结论。

### 7.1 「被唤醒」的唯一判据

**三个状态必须分开断言**（测试员A/B 联合口径，2026-11-11）：

| 状态 | 判据 | 注意 |
|---|---|---|
| **可见** | `inbox` / `conversation` 里能读到该消息 | ≠ 被唤醒 |
| **被唤醒** | **注入文本里出现该消息 id**，或 `wake_jobs` 有 `(message_id, agent_id)` 行 | 唯一可断言"叫醒了它"的依据 |
| **已交付** | `wake_jobs.state ∈ {sending, accepted}`、回执 `delivered` | **≠ 模型已见**：适配器把消息交给宿主即回报 delivered，而 DSH 只能在**下一个 step 边界**呈现给模型（忙时可滞后一个 step，实测 +22–24s） |

| 现象 | 含义 |
|---|---|
| **注入文本里出现该消息 id**（适配器注入的那批） | = 被唤醒（`/internal/wake` 认领到它） |
| `wake_jobs` 里有 `(message_id, agent_id)` 行 | = 该收件方被唤醒（receipts 集合的唯一来源） |
| 只在 `inbox` / `conversation` 里看到 | **≠ 被唤醒**：`inbox` 是"各会话已读位点之后"的收件视角——含未读、也含**你自己发出的**消息；被别的消息唤醒后再调 inbox 就会看到群里别人互相 @ 的内容，很容易误判成"被它唤醒了" |
| `message_status{ids}.receipts` | 派生自 `wake_jobs`，是核验唤醒集合的正确工具 |

**文本去重陷阱**：真机上存在**正文完全相同、id 不同**的多条消息（如连续三条「收到消息停止等待」）。按文本判断会得出"重复注入"的错误结论——判重必须用 **message id**，并记录该 id 的 `wake_jobs.attempts`。

唤醒路由（spec §2，`routeWake`）：仅普通群解析提及；命中集合 M 非空 → M；M 空且发送者是 human → 全体参与者；M 空且发送者是 agent → **∅（0 唤醒）**；发送者恒排除；容器在参与者映射阶段即排除。`mentions:["*"]` 是**显式**全员（规格内）。

### 7.2 会话/成员类错误的归因禁忌

- `group{op:list}` 是**全局**群列表，且每条带 `is_member`（会列出 `is_member=false` 的群）。因此"列表为空"只能推出**Hub 内已无任何群**，不能推出"我不是成员"。
- `roster{conversation:<id>}` 的 `not_participant` **同时覆盖**「未知会话」与「非成员」两种情形（契约同码）→ **不可**据此断定成员资格；要断言成员资格用 `group{op:list}` 的 `is_member` 或 `dump.participants`。
- 因此测试脚本里**解散测试群必须排在"真实回复落地"之后**：真机曾因脚本先 dissolve、agent 30–90s 后才回复，导致回复撞 `recipient_not_found`，被误报成"能收不能回"的产品缺陷。

### 7.3 延迟口径

- 工具执行中**不可抢占**：忙时消息只在**下一个 step 边界**进入模型上下文；叠加忙时轮询间隔，实测延迟可达 1–2 个 step（10s 工具 → 20–24s）。
- 计轮数统一为「**消息到达所在轮**」（避免"到达轮 vs 已完成等待轮"两套口径打架）。
