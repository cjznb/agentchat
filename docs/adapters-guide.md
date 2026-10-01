# 编写 AgentChat 适配器：契约、宿主能力矩阵与实战清单

> 读者：为**任意编码 agent 宿主**（OpenCode / Claude Code / DSH / 其它 CLI、IDE、桌面端）编写 AgentChat 适配器的
> 人或 agent。本文是**规范 + 路线图 + 踩坑表**，实现细节以既有适配器代码为准：
> [`adapters/opencode/`](../adapters/opencode/README.md)、[`adapters/claude-code/`](../adapters/claude-code/README.md)、
> [`adapters/dsh/`](../adapters/dsh/README.md)。
>
> 目标一句话：**让该宿主的每个会话在 Hub 里是一个可被寻址、可被唤醒、可回信的节点**。

---

## 0. 先读这一节：适配器是什么，不是什么

- 适配器是**进程外组件**，只经 HTTP 契约与 MCP 与 Hub 通信。**绝不 import `server/**`**（唯一例外是测试代码，
  因为测试可以同时 import 两侧）。
- Hub **不主动推送**：发送时为合格收件方建 `wake_jobs`，由适配器**在宿主空闲时主动认领**
  （`pull` 模式）。所以适配器的核心不是"接收推送"，而是**自己判断"现在能不能投递"，然后拉取并注入**。
- 适配器必须自己承担四件事（宿主能力不同，做法不同，见 §3）：
  1. **感知回合边界/空闲**；
  2. **把消息注入宿主并启动一轮**；
  3. **在没有事件的空窗期补拉**（轮询）；
  4. **生命周期与清理**（卸载上报 offline、停定时器）。
- 适配器**不负责**：消息持久化、投递台账、租约、重试预算、遮蔽（撤回/未读）——那些都在 Hub 侧。

---

## 1. Hub 侧的契约（唯一真源，实现前逐条核对）

### 1.1 认证与配置

| 项 | 说明 |
|---|---|
| 传输门 token | `HUB_TOKEN`（非空优先）→ `<AGENTCHAT_HOME>/hub_token`（Hub 启动时写出）。**401 自愈**：任一调用 401 → 重读一次 token，有**新值且不同**则原地更新并**只重试一次**；绝不循环退避 |
| Hub 地址 | `AGENTCHAT_URL` → `http://127.0.0.1:${AGENTCHAT_PORT:-4646}`；Hub 实际监听 `0.0.0.0`（局域网可连），显示的 url 是 `127.0.0.1` |
| 数据目录 | `AGENTCHAT_HOME`（默认 `~/.agentchat`）：`hub_token`、`config.json`、`agents/*`（各适配器落盘 token/id）、`logs/*`、`agentchat.db` |
| 厂商登记 | `config.json` 的 `adapters: ["opencode","dsh",…]`；**可选**——Hub 首次收到某厂商的 `/internal/wake` 会 `ensurePullAdapter` 自动登记为 pull |

### 1.2 `/internal/*` 四个端点

```
POST /internal/state  { agentId, state }            state ∈ online|busy|idle|offline
POST /internal/wake   { agentId }                →  { messages:[{id,fromAgentId,conversationId,body}] }
POST /internal/result { agentId, items:[{messageId, result}] }   result ∈ delivered|refused
POST /internal/retire { agentId }                 →  200；404 agent_not_found 视为幂等成功
```

必须知道的语义（都是真机踩出来的）：

| 语义 | 后果 / 纪律 |
|---|---|
| `idle` 在 Hub 侧映射为 `online`，且同态上报等价**心跳触碰**（刷新 `last_seen`） | 空闲轮询时**每次都要**上报（不要本地同态去重），否则节点被判 offline |
| **子节点不能报 `offline`**（`child_never_offline`） | 会话节点"消失"只能靠 `last_seen` 自然过期，或显式 `retire` |
| `offline → busy` 会被拒（409 `transition_rejected`） | 长回合期间要**搭车心跳**（见 §4.3），否则容器/节点被判 offline 后再报 busy 会失败 |
| `wake` 是**在途租约**（约 30s）：未回执则重投 | 适配器必须按 `messageId` **有界去重**：已注入的绝不重复注入，只补回执 |
| `result: refused` ＝ **尚未投递**（会计入 Hub 的拒绝预算） | `refused` 的消息**不得**写入去重集合，否则永久丢失 |
| `retire` 是**单向门**：退役后同 `task_ref` 的再注册永久被拒（`RegistrationError("retired")`） | **不要把"宿主 dispose/关闭"当删除**——用 §6 的决策规则 |

### 1.3 MCP `/mcp`（工具面 + 注册）

- 握手：`initialize`（读响应头 `mcp-session-id`）→ `notifications/initialized` → `tools/call`。
  结果在 SSE `data:` 行或裸 JSON 里，取 `result.content[0].text`；`isError:true` 时文本尾部形如
  `Name: message [code]`，**`code` 是稳定错误码**（如 `invalid_join_token` / `name_taken` / `identity_required`）。
- **注册三形态**（`register` 工具入参）：

| 形态 | 判据 | 关键字段 |
|---|---|---|
| 根 | 无 `parent_ref` 且无 `task_ref` | `vendor`、`purpose`、`name`、`role_tag`（容器用 `container`）→ 返回 `join_token` |
| 子 | 有 `parent_ref` | 必须同时有 `task_ref`；`parent_ref` 先按 id 后按 name 解析 |
| 逻辑 | 只有 `task_ref` | 无父的独立逻辑节点 |

- **收养（adoption）**：`registerChild` 按 `task_ref` 找既有节点——同 `task_ref` 重连会**认领同一个节点**并更新卡片，
  这是"重启后不新建节点"的依据。**但已退役节点会拒绝**（见上）。
- **命名唯一**：`agents.name` 与 `COALESCE(custom_name,name)` 都有唯一索引。同目录多会话必须靠**会话 id 短标识**区分，
  且要**剥掉宿主 id 的固定前缀**（见 §7 坑 1）。真撞名时回 `[name_taken]`——**要能改名重试一次**。
- **身份**：`x-agent-id` 只在 **`initialize` 时**被读取（此后不再读）；逐请求身份只能靠 **`x-agentchat-session`**
  头（值 = 会话节点的 `task_ref`；解析不到时**不回落容器**，等同无身份）。因此：
  - 身份**变化**（含 undefined→defined）必须**重建 MCP 会话**（丢弃 `mcp-session-id` 重新 `initialize`）。
  - 除 `register` 外所有工具都要求身份（`identity_required`）。
- **容器不能作为 DM 收件方**（`container_not_chat_target`）：容器只是分组，不是聊天对象。

---

## 2. 节点模型（三个适配器共用，请照抄）

```
实例节点  <vendor>@<host>    根，role_tag=container，join_token 认领；MCP 出站身份兜底
└─ 会话节点  <目录名>-<id短标识>   task_ref=<会话 id>；可被派活/唤醒/回信
   └─ 子代理会话节点            task_ref=<子会话 id>，parent_ref=父会话节点
```

- **实例节点**：一个宿主实例一个；用 `<home>/agents/<vendor>.token` 落盘 `join_token` 供重连认领；
  用 `<home>/agents/<vendor>.id` 落盘节点 id 供本地桥/工具作**出站身份兜底**。
- **会话节点**：Hub 侧可寻址的最小单位；`task_ref` 必须是宿主内**稳定**的会话标识（重启/续聊不变）。
- **子代理**：只在宿主能给出父子关联时建；父关联优先级：运行时事件直接携带 → 会话 header 的父字段 → 父主动注册。
- 每台机器/宿主实例的 `<vendor>@<host>` 天然不撞名（host 不同）——多机部署无需额外处理。

---

## 3. 宿主能力矩阵：先答五个问题，再写一行代码

写适配器前，**必须**对目标宿主把下面五个问题回答到"文件:行"级别。这决定了适配器的形态与天花板。

| # | 问题 | 为什么关键 | 反面后果（真实例子） |
|---|---|---|---|
| Q1 | **有没有常驻扩展点**（插件/长期进程）？还是只有一次性 hook？ | 决定能否"事件驱动 + 轮询" | 只有 hook：消息只能等"用户下一次输入"顺带拉取（JeikCode 现状） |
| Q2 | **能否主动注入一条消息并启动一轮**？API 是什么？ | 这是入站唤醒的**唯一**前提 | 只有 MCP：MCP 是被拉起的子进程，**只能被调用、不能推送** |
| Q3 | **空闲/回合边界可见吗**？有什么事件？ | 决定"投递时机"与是否需要轮询 | 无 idle 事件：空闲期到达的消息永远排队 |
| Q4 | **能否改写工具入参**？ | 决定能否做**逐会话**出站身份 | DSH 的 `PreToolDecision` 只有 allow/deny/ask → 无法注入身份提示，只能退化为磁盘提示 |
| Q5 | **配置/装配落点在哪**？（配置文件 / settings / profile patch）+ **卸载/卸载信号**？ | 决定安装器怎么写、`dispose` 该做什么 | 把"关闭会话"当删除 → `retire` 单向门，会话重开永久注册不了 |

### 3.1 能力 → 方案对照（按已实现的三个宿主）

| 能力 | OpenCode | Claude Code | DSH 桌面端 |
|---|---|---|---|
| 常驻事件流 | 插件钩子收全部事件（`session.created/updated/status/idle/deleted`） | ❌ 一次性 hook | ✅ 进程内 Cordis 插件（`agent/created`/`agent/status`/`agent/disposed`） |
| 注入并唤醒 | `client.session.promptAsync` | `Stop` hook 阻塞续跑（`decision:"block"`） | `agent.followup(msg)`（空闲）/ `agent.steer(msg)`（运行中）；**`inject` 不唤醒** |
| 空闲检测 | `session.idle` / `session.status` | `Notification(idle_prompt)`（仅上报，不注入） | `agent/status` = `running`/`idle` |
| 空窗补拉 | 空闲轮询（`AGENTCHAT_POLL_MS`，10s） | 无法常驻 → 只能 SessionStart/Stop 时拉 | 空闲轮询（同上，**登记即开轮询**，见坑 3） |
| 逐会话出站身份 | `tool.execute.before` 改写入参 → 桥剥头 | ❌ 无（容器身份） | ❌ 禁改写 → 磁盘提示 `agents/dsh.current`（**仅单会话精确**，多会话 fail-closed 回落容器） |
| 生命周期 | `dispose` → offline；`session.deleted` → retire | `session_end` hook | `agent/disposed` → 只停跟踪；插件卸载 → 实例 offline |
| 装配落点 | 写 OpenCode 配置（JSONC，幂等合并） | 合并 `settings.json` 的 `hooks` + `mcpServers` | bundle（`dsh.bundle.patch`）+ profile `cordis.patch.yml` + `dsh.profile.bundles` |

> **决策树（简版）**
> 1. 宿主有常驻插件 API → 走**插件 + 本地 MCP 桥**（能力最全，OpenCode / DSH 都是这条路）。
> 2. 只有一次性 hook → 走**hooks + 注入式 hook**（Claude Code）：把"取件"放在 `Stop`/`SessionStart`，
>    接受"只能在回合边界投递"的天花板；**不要**假装能实时唤醒。
> 3. 只能配 MCP、无插件无 hook → **只能出站**（发消息/提问），入站投递做不了；文档里要如实写明。

---

## 4. 实现骨架（进程外组件的最小集合）

```
adapters/<vendor>/
  hub.<ext>          Hub 客户端：地址/token/超时/退避 + /internal/* + MCP register
  token.<ext>        本地落盘：join_token / 节点 id / 去重集合 / 日志路径（0600 尽力而为）
  log.<ext>          文件日志（1 MiB 轮转）；**绝不写宿主 stdout**（MCP 桥的 stdout 是协议流）
  poll.<ext>         空闲轮询器：无重叠执行、失败指数退避、unref()
  flush.<ext>        取件闭环：心跳 → wake → 去重 → 注入 → result（宿主相关部分用回调注入）
  session-hint.<ext> 节点命名 + 逐会话身份提示（若有）
  plugin / hooks     宿主侧入口（注册/状态/注入/卸载）
  mcp-bridge.<ext>   stdio↔HTTP MCP 代理（宿主无原生工具面时必需）
  install.<ext>      幂等安装器：--dry-run / --uninstall / 备份 / 原子替换
  __tests__/         单测（假宿主 + 假 Hub）
  README.md          安装/验证/排障
```

### 4.1 传输层（照抄这三条纪律）

1. **超时**：单请求 3s 级；`sleep`/`random` 可注入（测试确定性）。
2. **重试**：5xx/429/网络异常指数退避（上限 30s）+ jitter；4xx（含 401/404）**不重试**，交上层分流降级。
3. **401 自愈**：重读 token 一次，仅在有新值时重试一次。**绝不循环**。

### 4.2 注册与层级

- 懒注册实例节点（首次需要时），`invalid_join_token` → 清 token 按首次注册重来（**保留** `.id` 文件）。
- 会话节点用 `parent_ref`+`task_ref` 注册；**并发注册要合并**（同一会话的 created/status 同时到达）。
- 注册失败要能**重试**：见坑 2（在途记录泄漏）与坑 4（错过事件后不再枚举）。

### 4.3 状态上报

- `running` → `busy`；`idle` → `idle`（+ 心跳）。
- **同态去重**避免刷请求；但节流后的**心跳**必须周期性发出（空闲轮询每轮上报 `idle`）。
- **搭车心跳**：会话状态上报时**同时触碰实例容器**，否则长回合/长期空闲会让容器先被判 offline
  （真机症状："子节点在线但根显示离线"）。

### 4.4 取件闭环（唯一正确顺序）

```
心跳(会话节点 + 实例节点, always) → wake 认领 → 按 messageId 过滤已注入
  ├─ 全是重复 → 只补 result(delivered)
  └─ 有新消息 → 注入(格式化成一条文本) → 成功记入去重集合 → result(delivered)
                 注入失败/被拒 → result(refused)，**不写去重集合**
```

- 注入文本要有稳定前缀（各适配器统一 `[AgentChat] …`），并携带 `messageId` 便于回执对账。
- `flush` 返回 `boolean`：`false` 让轮询器退避。
- **任何失败只记日志，绝不抛给宿主**。

### 4.5 注入消息的构造（宿主差异最大的一步）

- Claude Code：向 stdout 输出 `{"decision":"block","reason":…,"hookSpecificOutput":{...additionalContext}}`；
  正文**同时镜像进 `reason`**（宿主可能忽略其中一个通道）。
- OpenCode：`client.session.promptAsync({path:{id},body:{parts:[{type:"text",text}]}})`。
- DSH：`agent.followup(UserMessage)` / `agent.steer(UserMessage)`；消息对象用**宿主自己的**构造器
  （`createUserMessage`），**不要手搓**——DSH 的会话格式 v4 会校验 `source`（见坑 5）。

---

## 5. 逐会话出站身份（最容易做错的一块）

问题：一个进程只有**一个** MCP 连接，桥的 `x-agent-id` 天然只能表达**实例级**身份；而用户期望"谁在说话就以谁的名义记账"。

三条可行路线（按可靠性排序）：

1. **改写入参 + 桥剥头**（OpenCode 已实现，最可靠）：
   宿主在每次工具调用前把会话 id 注入工具入参 → 桥**剥离**该键并转成请求头 `x-agentchat-session` → Hub 按 `task_ref` 解析。
   红线：**只原地改**（宿主丢弃钩子返回值）；写入失败只记日志、绝不抛。
2. **磁盘会话提示**（DSH 折中）：插件维护 `<home>/agents/<vendor>.current`，**只在"恰好一个顶层会话"时写它**，
   否则删除（**fail-closed**）；桥逐请求读它，**值变了就重建 Hub 会话**。
   代价：多会话并存时没有身份 → 桥回落实例容器 → Hub 明确拒绝以容器为收件方的 DM。
   ⚠️ **切勿**在"多于一个"时按"最近进入 running"等启发式猜身份：那是跨会话 last-writer-wins 全局指针，
   等于把"谁的回合最后开始"当成"谁在说话"——真机已发生**身份冒用**（A 的消息挂到 B 名下，归属/回执/ask 授权全错）。
   宁可显式失败，不可静默冒名。
3. **原生工具面**（根治解，**DSH 已实现**，`config.nativeTools: true`）：宿主插件用 `ctx.tools.register()`
   自己代理 Hub 工具面 → 工具执行上下文自带**调用方 agent**（DSH：`execute(args, exec)` 的 `exec.agent`，
   见 `@deepseek-ai/dsh-tools` 的 `ToolExecutionInput.agent`）→ 每次调用解析**自己的**会话并把
   `x-agentchat-session` 作为**逐请求**身份发出 → 任意并发都精确，且**不再需要 MCP 桥与共享状态文件**。
   落地纪律：调用集从 Hub `tools/list` **动态生成**（别硬编码 schema）；拿不到调用者会话就**拒发**（不猜）；
   注册失败逐工具跳过并记日志；Hub 侧会话失效（400/404）丢弃缓存会话自愈。

> 无论哪条：**Hub 只在 initialize 认 `x-agent-id`**，身份变化必须重建会话（坑 7）。

### 5.1 展示名：让节点"一眼可认"（建议所有适配器都做）

机器唯一名保证唯一但不便辨认（真机反馈："`default-workspace-f79d9a5c` 一眼看不出是谁"）。
Hub 里**显示**的是 `COALESCE(custom_name, name)`，所以正确做法是把两者分开：

- `name` = 稳定、唯一、可推导（注册时定，**永不变**——`task_ref` 收养与撞名重试都依赖它）；
- `custom_name` = 人类可读（`PATCH /api/agents/:id`，body `{name}`），来源是宿主自己的"会话标题/摘要"：
  DSH `ctx.sessionTitle.get(session)`、OpenCode 会话标题、宿主没有标题时退回目录名/机器名。

落地要点（缺一条就会踩坑）：

1. 标题常常**晚于**注册才生成 → 除注册时读一次，还要订阅宿主的标题变更（DSH：`session/event` 的 `session/title`）；
2. Hub 入参约束：trim 非空、**≤64 字符**、禁控制字符（`\p{Cc}`）；按**码点**截断（别切断代理对）；
3. 展示名同样有唯一索引 → 撞名回 **409**：退化为「标题·会话短标识」**只重试一次**，仍失败就保留机器名；
4. 同值不重复请求：缓存"已应用"值，并**把在途值一起去重**（并发修订事件否则会重复改名）；
5. 标题服务缺失（宿主没装该插件）不得报错，静默保留机器名；给一个 `titleAsName: false` 开关。

---

## 6. 生命周期：offline / retire / 关闭 的正确取舍

| 事件 | 该做什么 | 不该做什么 |
|---|---|---|
| 插件/进程卸载 | 实例节点报 `offline`；**返回值要 await**（宿主会等 disposer 的 promise） | 不要给子节点报 offline（会被拒） |
| 会话结束但**可能重开** | 只停跟踪 + 停轮询；节点留给 `last_seen` 自然过期 | **不要** `retire`（单向门，重开即永久注册失败） |
| 会话被**明确删除**（宿主有该事件） | `retire`（幂等 404 当成功） | 不要用它代替"关闭" |
| 进程重启 | 复用实例 `join_token` 认领；会话靠 `task_ref` **收养**同一节点 | 不要清 `.id`/`.token`；不要新建根 |

---

## 7. 实战事故表（每条都配"如何避免 + 如何测"）

| # | 症状 | 根因 | 修法 | 回归测试 |
|---|---|---|---|---|
| 1 | 第二个会话注册报 `name_taken`；Hub 里只有第一个 | 取"会话 id 前 8 位"当短标识，而宿主 id 形如 `session-<uuid>`，**前缀恰好 8 字符** → 同目录所有会话同名 | 先剥已知前缀再截断；真撞名时追加短哈希**重试一次** | 两个 `session-<uuid>` 会话 → 名字必须不同 + `name_taken` 重试成功 |
| 2 | 注册失败一次后**再无任何动静**（日志不涨、节点不上线） | `registerInstance()` 失败走的是 try/finally **之前**的提前 return → 在途记录永不清除 → 之后每次都拿回已落定的旧 promise | 把**整个任务体**放进 try/finally | Hub 全 500 → 恢复后**不发任何事件**也应自动注册 |
| 3 | 重启后不对话时，消息**一直排队** | 轮询器只由 `idle` **状态跳变**启动；而会话经 created/回填/重试登记时**没有跳变**（它本来就 idle）→ 永不取件 | **登记成功即开轮询** | 只发 created、不发任何 status，空闲消息仍被注入 |
| 4 | 插件启动瞬间枚举为空 + 错过 created → 会话长期不可见 | 只在加载期枚举一次 | **补注册重试每轮重新枚举**宿主 agent 列表 | 启动时列表为空、稍后出现 → 下一轮被发现并注册 |
| 5 | 注入后整轮报 `format v4 message requires a producer-owned source kind` | 用了宿主**已废弃**的消息来源包装（DSH 的 `kind:"plugin"`） | 用**生产者自有 kind**（DSH 迁移规则：未知插件 → `plugin:<名字>`），并保留其余字段 | 断言来源 kind 不得为 `plugin`、必须 `plugin:` 前缀 |
| 6 | 重启后出站身份记到了**别的会话**名下 | 陈旧的身份提示文件未被清除（新进程"同值不触盘"逻辑早退） | 启动时把状态文件真值读为基线 → 首次发布即清掉陈旧值 | 预置陈旧 `*.current` → 卸载/首次发布后文件应消失 |
| 7 | 身份已经正确写入磁盘，Hub 侧却一直 `identity_required` | Hub 只在 `initialize` 读 `x-agent-id`；桥在宿主启动时（磁盘还没有 id）已建会话 | 解析值变化时**丢弃 `mcp-session-id` 重新 initialize**；`400 agent_not_found` 清缓存并**只重试一次** | "id 尚不存在 → 出现"必须触发重新握手且带上头 |
| 8 | 对端**无法回复**某 agent（`container_not_chat_target`） | 出站身份落在容器节点上，而容器不是聊天对象 | 单会话精确到会话节点；多会话 **fail-closed** 回落容器（显式拒绝优于静默错挂） | 断言单会话时 `fromAgentId` = 会话节点 |
| 9 (安全) | 同机两会话并跑时，A 发出的消息 `fromAgentId` 记成 B（**身份冒用**） | 多会话时按"最近进入 `running`"猜身份 = 跨会话 last-writer-wins 全局指针（谁的回合最后开始就当谁在说话） | **删掉启发式**：只在"恰好一个顶层会话"时给身份，否则不给（回落容器 → Hub 显式拒绝） | 两顶层会话并存 → 提示文件必须不存在；释放一个 → 立刻恢复为该节点 |
| 10 | 阻塞式 `ask` 总超时（但请示其实已创建） | 桥的 MCP `tools/call` 超时（30s）+ 宿主 MCP 客户端还有 `toolCallTimeoutMs`（常见 60s） | 文档化：**用异步 ask**，答复会经 wake 回投；要阻塞就同时调大两处超时 | 断言 `wait` 超时后请示仍在 `approvals` 且答复能被 wake 送达 |

---

## 8. 安装器规范（安装体验决定适配器能不能被用起来）

必须支持：`--dry-run`（只打印计划、不落盘）、`--uninstall`（**精确回退**）、`--help`、
未知参数报错退出、默认路径可从 env 覆盖（`AGENTCHAT_HOME` / 宿主 home / profile）。

产物（按宿主不同）：

| 宿主类 | 安装器写什么 |
|---|---|
| 配置型（Claude Code / OpenCode） | 合并宿主配置文件：`hooks`、`mcpServers`；**保留其它键**、二次安装等价、uninstall 只删自己那几条 |
| bundle 型（DSH） | ① 模块根**目录联接** → 适配器目录；② profile `package.json` 的依赖 + `dsh.profile.bundles` 选择；③ profile `cordis.patch.yml` 的**受管块**（含 MCP 行的**机器绝对路径**）；④ 厂商登记 |

两条硬要求：

1. **备份 + 原子替换**（`<file>.bak` + 临时文件 + rename），且 `--uninstall` 后**字节级还原**
   （保留原缩进/EOL/注释；受管块用**标记包裹**，只替换块内文本，绝不重新序列化整个文件）。
2. **包内不含机器绝对路径**：随包发布的 patch 只放"插件行"（包名解析），把 node 路径、
   `mcp-bridge.mjs` 路径这类机器相关项留给安装器写进**用户 patch 层**。这样同一份包可被任意路径安装。
   （代价：移动目录后要重跑安装器——写进 README。）

---

## 9. 测试与验收（照这张表就能过评审）

### 9.1 单测（假宿主 + 假 Hub，**不联网**）

- 握手：MCP `initialize`（含/不含 `mcp-session-id`）、SSE 与裸 JSON 两种回复、`isError` → `code` 解析。
- 退避：5xx/429/网络异常的重试次数与延迟断言；4xx 不重试。
- 401 自愈：有新值 → 重试一次；无新值 → 不重试。
- 注册：根→子的**顺序**、`invalid_join_token` 自愈只两次根注册、`name_taken` 改名重试一次。
- 状态：同态去重；心跳 always；容器搭车。
- 取件：单条注入、多条合并、`refused` 不写去重、重复只补回执、注入抛错按 refused。
- 空闲期：**只发 created、不发 status** 时仍能取件（坑 3）；Hub 先全 500 后恢复能自愈（坑 2）。
- 竞态：注册在途时 `disposed` → 不登记、不上报 online、不注入僵尸。
- 安装器：二次安装等价、`--dry-run` 不落盘、uninstall 字节级还原、拒绝非法顶层结构。
- **纪律检查**：MCP 桥的 stdout 只允许 JSON-RPC 帧（spy `process.stdout.write`）。

### 9.2 集成测试（真 Hub，进程内 start，端口 0）

用真 `server/**` 起 Hub，把**宿主**做成假对象，断言**可观察量**而不是 mock 计数：

1. `GET /api/roster` 里出现节点：`vendor`、父子关系、名字唯一；
2. 对端经真 MCP `send` → 空闲驱动 → 宿主注入**恰好一条**（含消息 id 与正文）；
3. `wake_jobs` 落到 `accepted`（回执被理解，不只是发出）；
4. 再取一次**不重投**；
5. `running` 期间认领的交付走 `steer`（用一个小 relay 卡住 `/internal/state` 制造确定性窗口）；
6. `disposed` 后**不退役**，且同 `task_ref` 可再次注册（同一个 Hub id）。

### 9.3 真机手动清单（必须写进 README，且**如实**说明未自动化的部分）

1. 装 → 重启宿主 → roster 出现 `<vendor>@<host>` + 打开的会话节点；
2. 对端发消息：会话空闲时应被注入并**起一轮**（不是等用户下次输入）；
3. 回执变 `delivered`；
4. 关闭再打开同一会话：**认领同一节点**，不新建、不报错；
5. 退出宿主：节点在 `last_seen` 阈值后变 offline；
6. 宿主日志/适配器日志里没有"静默失败"（每类失败都有可诊断的一行）。

### 9.4 交付前 checklist

- [ ] 不含 `server/**` import；源文件 ≤250 纯行；无第三方依赖（纯宿主侧脚本除外）
- [ ] 所有宿主回调"不阻塞、不抛"；网络全在后台，超时/退避可注入
- [ ] 消息来源/注入载荷符合宿主当前格式（**跑一次真注入**，别只看文档）
- [ ] 退役只用于"明确删除"；关闭/卸载只停跟踪
- [ ] 安装器幂等 + dry-run + uninstall 字节级还原 + 备份
- [ ] 文档：安装、配置、验证清单、排障表、**已知边界**、真机未验证项
- [ ] `npm test` + `npm run typecheck` 全绿；新增测试覆盖上表每条不变量

---

## 10. 已知边界与后续方向（如实记录，不要藏）

1. **多会话并发时逐会话身份的精度**：受"宿主是否允许改写入参"限制。终极解 = 第 5 节第 3 条（原生工具面）。
2. **退役单向门**：没有"会话删除"事件的宿主只能靠 `last_seen` 自然 offline；遗留 pending 消息需要运维清理
   （Hub 侧已有批量退役离线历史会话的管理端点）。
3. **阻塞式 ask**：`wait` 超过桥/宿主 MCP 超时必然失败 → 用异步；文档已注明。
4. **每个宿主的文件级验证**：新宿主接入时，先把 §3 的五个问题答到"文件:行"，再动手；不要用文档猜测 API——
   真机跑一次"注入并起一轮"比读十页 README 有用。

---

## 11. 参考实现索引

| 关注点 | 去哪里看 |
|---|---|
| Hub 契约（端点/状态机/租约） | `server/routes/internal.ts`、`server/store/wake.ts`、`server/mcp/tools.ts`、`server/mcp/context.ts` |
| 节点注册/收养/退役 | `server/core/agents.ts` |
| 命名唯一与容器限制 | `server/schema.sql`、`server/core/messaging.ts` |
| 最完整的插件式适配器 | `adapters/opencode/`（`plugin.ts`、`hub.ts`、`flush.ts`、`poll.ts`、`mcp-bridge.mjs`、`install.mjs`） |
| hooks 式适配器（一次性扩展点） | `adapters/claude-code/`（`session-start.mjs`、`idle.mjs`、`busy.mjs`、`install.mjs`） |
| bundle 式适配器（进程内插件 + profile patch） | `adapters/dsh/`（`index.js`、`lib/*`、`mcp-bridge.mjs`、`install*.mjs`、`docs/adapters-dsh.md`） |
| 安装器写法与回退保证 | 三个 `install.mjs` + `docs/adapters-*.md` 的"排障"节 |
