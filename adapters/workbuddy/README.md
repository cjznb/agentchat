# AgentChat — WorkBuddy 适配器（插件式适配器）

把本机运行的 [WorkBuddy](https://www.workbuddy.cn/docs/workbuddy/Overview) **每个会话**接入 AgentChat Hub：
会话建立时注册节点、回合结束时从 Hub 拉取积压消息并**注入回当前会话**、会话内可经 MCP 工具与外部的 agent 互通。

本适配器**只经 HTTP 契约**与 Hub 通信（不 import 本仓 server 代码），由两部分组成：

| 部分 | 形态 | 作用 |
|---|---|---|
| **hooks**（`hooks/*.mjs`） | 每个事件一个**一次性 Node 进程**（`node <script>.mjs`，无第三方依赖） | 注册节点、上报状态、取件、**注入** |
| **stdio MCP 桥**（`mcp-bridge.mjs`） | 长期存活的 stdio 子进程 | 把宿主 MCP 调用**透明转发**到 Hub `/mcp`（streamable-HTTP），并补齐身份与会话提示 |

两者打进同一个 WorkBuddy 插件（`.codebuddy-plugin/plugin.json` 里声明 `hooks` 与 `mcpServers`），
一次安装同时落地。

## 与 claude-code/opencode 适配器的关键差异（先读这段）

WorkBuddy 的 hook 是**没有常驻进程、没有附加持久通道**的。这带来两个后果，本适配器全部按此设计：

1. **入站投递只能在 hook 里发生**。故"投递点"是 `Stop`（回合结束）与 `SessionStart`（会话开启兜底拉取）、
   `UserPromptSubmit`（用户下一条输入）。
2. **会话完全静置（用户不碰键盘、模型也不在跑）时，没有任何 hook 会触发** → 消息只能躺在 Hub 队列里，
   直到下一次任意 hook 到来。**这就是"空闲期唤醒"必须解决的问题**，解法见下文
   [空闲期唤醒](#空闲期唤醒会话静置时如何被叫醒)——依赖**宿主内建的会话级定时任务**，
   而不是适配器自己起守护进程（hook 进程一次一命，起不了）。

> 如果你的部署可以接受"消息在下一个回合才被消费"，那**什么都不用配**：`Stop` hook 会在每个回合结束
> 立刻把件投出去，实时性通常已经够用。

## 环境变量

hook 与 MCP 桥都由宿主派生，故这些变量需出现在**启动 WorkBuddy 的环境**里。

| 变量 | 必填 | 说明 |
|---|---|---|
| `AGENTCHAT_HOME` | 否 | Hub 数据目录，默认 `~/.agentchat`（与 Hub 一致）。适配器由此推导 `hub_token` 与 `agents/workbuddy.*` |
| `HUB_TOKEN` | 否 | Hub 传输门 token **覆盖值**。一般**不用设**——默认直接读 `<AGENTCHAT_HOME>/hub_token`（Hub 启动时生成） |
| `AGENTCHAT_URL` | 否 | Hub 地址，默认 `http://127.0.0.1:<AGENTCHAT_PORT 或 4646>` |
| `AGENTCHAT_PORT` | 否 | 仅用于推导默认 `AGENTCHAT_URL`（Hub 跑在非 4646 端口时用） |
| `AGENTCHAT_HOOK_TIMEOUT_MS` | 否 | hook 侧 HTTP 超时，默认 `3000`（测试/慢机用；生产恒 3s） |
| `AGENTCHAT_MCP_TIMEOUT_MS` | 否 | MCP 桥转发上游超时，默认 `30000`，钳制到 `[100, 600000]` |
| `AGENTCHAT_INSTANCE_NAME` | 否 | 实例容器名**基名**覆盖（默认 `workbuddy@<host>`）；同一台机器跑多个 WorkBuddy 安装时用 |
| `AGENTCHAT_STOP_LONGPOLL_MS` | 否 | `Stop` 在交出控制权前的**有界**长轮询窗口，默认 `0`（关）。开启可让"回合刚结束时刚好到达"的消息也被捞走 |
| `AGENTCHAT_CRON_ARM` | 否 | `1` 时 `SessionStart` 会在注入内容里附一段"如何开通空闲期轮询"的提示（见下文）。默认关 |
| `AGENTCHAT_CRON_MS` | 否 | 上述提示里的建议间隔（毫秒），默认 `60000` |
| `AGENTCHAT_LOG` | 否 | `console` 时把诊断**额外**镜像到 **stderr**（stdout 永远留给宿主协议） |
| `COMPUTERNAME` / hostname | — | 只读，用于实例容器命名 |

## 安装

```bash
node adapters/workbuddy/install.mjs [--dry-run] [--uninstall] [--force] [--help]
  --workbuddy-home <path>  WorkBuddy 配置目录（默认 $AGENTCHAT_WORKBUDDY_HOME 或 ~/.workbuddy）
  --agentchat-home <path>  Hub 数据目录（默认 $AGENTCHAT_HOME 或 ~/.agentchat）
  --plugin-dir <path>      插件源目录（默认本适配器目录）
```

安装器（幂等，写前必备份 + 原子写）会落这些地方：

1. **市场目录**：`<workbuddy-home>/marketplaces/agentchat-local/`（含 `marketplace.json` + 插件源副本 `/agentchat-workbuddy/`）。
2. **安装目录**：`<workbuddy-home>/plugins/agentchat-workbuddy/`。
3. **三处台账**：`known_marketplaces.json`（登记本市场，`type: "directory"` + 绝对路径）、
   `installed_plugins.json`、`settings.json → enabledPlugins`。
4. **Hub 适配器登记**：`<agentchat-home>/config.json` 的 `adapters` 数组加入 `"workbuddy"`。

> **幂等**：二次安装后所有落盘文件**字节等价**（时间戳在内容无变化时复用旧值），不会因重复执行产生噪声 diff。

**装完后必须重启 WorkBuddy**（或到插件管理页确认 `agentchat-local` 市场 / `agentchat-workbuddy` 已启用）。
`--uninstall` 在用户未改动过这些文件时**字节级还原**（含删掉本安装器创建的文件，不留空壳）；
若用户/其它工具改过，则**精确移除本适配器的键 + 告警**，绝不静默损毁用户改动。

```bash
# 先看计划再动手（推荐）
node adapters/workbuddy/install.mjs --dry-run
# 真装
node adapters/workbuddy/install.mjs
# 卸载
node adapters/workbuddy/install.mjs --uninstall
```

## 事件映射

| WorkBuddy 事件 | 脚本 | 动作 |
|---|---|---|
| `SessionStart` | `session-start.mjs` | 注册实例容器 + 本会话节点 → `state {online}` → **兜底 `wake` 拉一次**（登记成功即拉，指南 §7 坑 3）；有待投内容时以 `hookSpecificOutput.additionalContext` 注入 |
| `UserPromptSubmit` | `user-prompt-submit.mjs` | 心跳 `{busy}` + **懒注册兜底**（SessionStart 没跑成也能用）+ 补拉注入；**cron 哨兵回合也走这里** |
| `PreToolUse`（matcher `agentchat`） | `pre-tool-use.mjs` | 只对**本适配器自己的** MCP 工具：把会话提示注入到 `tool_input` 并给 `permissionDecision: "allow"`（逐会话出站身份） |
| `Stop` | `stop.mjs` | **入站唤醒主入口**：心跳 `{idle}` → `wake` → 有**新**消息则输出 `{"continue":false,"stopReason":…}` 让回合继续并消费注入；链内/窗口内计数上限 3 次 |
| `Notification`（matcher `idle_prompt`） | `notification.mjs` | **只**上报 `{idle}` 心跳，**不 `wake`**（该事件无 `additionalContext` 槽位，认领了也无处投递，只会平白消耗租约） |
| `SessionEnd` | `session-end.mjs` | 只记日志 + 尽力一次 `idle` 心跳；**绝不 `retire`**（`retire` 是单向门，会话重启就再也注册不回来；节点交由 Hub `last_seen` 自然过期） |

## 注入路线选择依据（已核实宿主实现，非仅凭文档）

**结论：`Stop` 事件输出 `{"continue": false, "stopReason": "…"}` 作为唯一可靠的注入路线；
正文同时镜像一份到 `hookSpecificOutput.additionalContext` 双通道保底。**

依据来自 `codebuddy-lite-wb.mjs` 中对 hook 输出的解析（核实日期 2026-10-01）：

```js
!1 === t.continue && (i.shouldContinue = !1, i.stopReason = t.stopReason)
```

即 hook 返回 `continue: false` 时，宿主**阻止停止**、把 `stopReason` 交给模型、继续对话——
这正是"外部消息唤醒一个已经闲下来的会话"所需的语义。同一实现里另有两条已核实结论，直接决定了本适配器的写法：

1. **`modifiedInput` 是整体替换，不是局部合并**。
   `c.modifiedInput && (n = c.modifiedInput)` —— 故 `pre-tool-use.mjs` 必须回一个**完整的**新入参对象
   （在原件上拷一份再补会话键），只回 `{ [SESSION_ARG]: sessionId }` 会把用户的 `to` / `body` 全抹掉。
2. **`permissionDecision` 只在 `"allow"` 时 `updatedInput` 才被采纳**，且 `allow` 仅在没有更早的决策时生效。
   故本适配器在 `PreToolUse` 里**只碰自家工具**（matcher `agentchat`），对其余工具完全静默——
   绝不触碰用户的其它工具与权限。

> `Notification` 事件在宿主实现里**没有** `additionalContext` 槽位，故它只上报心跳。
> 若在那里 `wake`，消息会被认领（置 `sending` + 30s 在途租约）却投不出去，到期重投 → 纯噪声。

## 空闲期唤醒（会话静置时如何被叫醒）

链路共三层，从"一定要配"到"锦上添花"：

### 1. `Stop` hook 即时投递（**默认生效，无需配置**）

每个回合结束时 `stop.mjs` 都会 `wake` 一次。只要消息在回合结束前到达，就会立刻被注入。
**代价**：如果消息在"会话已经静置"之后才到达，要等下一次任意 hook。

### 2. 宿主内建定时任务（真正解决"完全静置"）

WorkBuddy 有**会话级**的定时任务（`CronCreate` 工具 / `/loop` 斜杠命令），到点会**向当前会话投一个 prompt**，
从而触发 `UserPromptSubmit` hook → 取件。这就是空闲期的唤醒来源。

**两种开通方式**：

```bash
# 方式 A：会话里直接执行（推荐，可靠）
/loop 1m [AgentChat] poll

# 方式 B：用本插件自带的斜杠命令（会走 CronCreate 并附带说明）
/agentchat-loop 5m
```

也可以让模型自己调 `CronCreate`：

```
cron: "*/5 * * * *"        # 标准 5 字段，本地时间
prompt: "[AgentChat] poll" # 适配器识别这个哨兵；无待投内容时该回合只心跳、快速空跑
recurring: true
```

> ⚠️ **`recurring` 任务 3 天后会自动过期**（宿主内建行为），到期需重新挂。
> ⚠️ **每次轮询都是一次完整的模型回合**：间隔越短实时性越好、token 成本越高。在意成本就 `5m` 或干脆不挂。

**为什么适配器不自己起定时器？** hook 是**一次性进程**，退出即销毁，没有可托管的常驻宿主；
仓库里也没有能跨进程托管定时器的组件。宿主内建的会话级 cron 是唯一"能让空闲会话重新动起来"的官方通道。
置 `AGENTCHAT_CRON_ARM=1` 可让 `SessionStart` 把这段开通指引附进注入内容里（默认关；
`SessionStart` 的 `additionalContext` 官方语义偏"显示给用户"，送达模型不保证，故这只是尽力而为的提示）。

### 3. `AGENTCHAT_STOP_LONGPOLL_MS`（可选，收窄竞态窗口）

回合结束的瞬间若消息"刚好在路上"，默认会漏到下一个回合。设成比如 `5000` 让 `Stop` 在交出控制权前
**有界地**多探几次（默认 `0` 关闭）。上限 120s 钳制，绝不会拖住宿主。

## 逐会话出站身份（本适配器的核心难点）

Hub 的节点模型是 `<vendor>@<host>` 容器 → 会话节点 → 子节点。但**一个 WorkBuddy 进程内的多个会话共用一个
MCP 桥进程**（插件级 `mcpServers` 只会为整个应用起一份），于是"这条 `send` 到底是谁发的"必须逐请求解决：

```
PreToolUse(matcher=agentchat)  ──注入 tool_input["x-agentchat-session"] = <session_id>──▶  宿主
                                          │
宿主发起 tools/call ─────────────────────▶ mcp-bridge.mjs
                                          │ ① 原地**删除**该键（Hub 绝不能看到，否则撞入参严格校验）
                                          │ ② 转成同名**请求头** x-agentchat-session
                                          ▼
                                     Hub /mcp
```

两条已核实的 Hub 纪律决定了实现：

- **`x-agent-id` 只在 `initialize` 时被读取一次**，之后每个请求的身份来自 `x-agentchat-session` 头
  （值 = 会话节点的 `task_ref`）。
- **身份变更必须重建 MCP 会话**（含 `undefined → defined`）。故桥在检测到会话提示**值发生变化**时，
  丢弃 `mcp-session-id` 重新 `initialize` 一次；**同值不重建**（避免每轮都刷一次握手）。

**未注册会话不塞身份头**：若该 `session_id` 还没注册成节点，`pre-tool-use.mjs` **省略**这个键，
桥便回落到容器身份，工具**仍然可用**（只是以容器身份发言）；若硬塞一个解析不出的值，Hub 会
`identity_required` 从而让工具**彻底不可用**——两害相权，选择前者。

## 本地文件（`<AGENTCHAT_HOME>/agents/`）

| 文件 | 说明 |
|---|---|
| `workbuddy.token` | 实例容器节点 `join_token`（0600 尽力而为；陈旧时自动清除重建） |
| `workbuddy.id` | 实例容器节点 id（桥的**出站身份兜底**） |
| `workbuddy.instance` | 实例名后缀（**仅在** `workbuddy@<host>` 撞名时生成并持久化，此后稳定复用） |
| `workbuddy.root.json` | 最近一次 `SessionStart` 的上下文 `{sessionId, agentId, containerId, at}`（诊断用） |
| `workbuddy.sessions.json` | 会话映射台账 `{ [sessionId]: {agentId, name, at} }` |
| `workbuddy.stop.json` | `Stop` 链内/窗口内注入计数 `{sessionId, count, at}`（防自激） |
| `workbuddy.seen.json` | 已注入 `messageId` 去重集合 `{ids:[…], at}`（**有界** 200 条，FIFO 淘汰） |
| `logs/workbuddy-adapter.log` | 追加式带时间戳日志（**> 1 MiB 轮转**，只保留一份）；`tail -f` / `Get-Content -Wait` 查看 |

## 健壮性

- **退出码恒 0**（`runHook` 是唯一落点）：任何异常、Hub 不可达、载荷为空/非法 JSON、磁盘写失败，
  都只记日志、绝不阻塞或非零退出影响宿主。
- **诊断只落文件**：全部日志写 `<AGENTCHAT_HOME>/logs/workbuddy-adapter.log`，**绝不写宿主 stdout**
  （stdout 是宿主协议通道：`Stop` 的决策 JSON / `SessionStart` 的 `additionalContext`）。
  安装器往终端打印是正常的——它是**用户主动执行**的 CLI。
- **`refused` 绝不写入去重集合**：Hub 的 `refused` 语义是"**尚未投递**"，若误记入去重集合，
  这条消息就**永久丢失**了。只有确认产出注入载荷后才 `rememberSeen` + 报 `delivered`。
- **租约重投去重**：`wake` 是在途租约（约 30s），未回执会重投。按 `messageId` 跳过已注入者，
  仅补 `/internal/result` 回执，**绝不重复注入**。
- **搭车心跳**：上报会话节点状态时**同时**触碰实例容器（`idle`）——否则长回合/长期空闲会让容器先被
  判 `offline`，整个实例从名单上消失。
- **防注入自激（两道锁）**：`stop_hook_active === true` 表示"因 `Stop` 注入而续跑的**同一链**" →
  链内计数；`false`（新回合/新链）→ **计数归零**，保证新链**仍可被唤醒**（不会像早期实现那样达上限后
  永久饥饿）。另有一道与 `stop_hook_active` 无关的**滚动窗口**计数（60s 内最多 3 次），
  防止宿主某版本不传该字段时出现"注入–停止"活锁。宿主另有"8 连续续跑"硬上限双保险。
- **`SessionEnd` 绝不 `retire`**：`retire` 是**单向门**，退役后同一 `task_ref` 再注册会被**永久拒绝**
  （`RegistrationError("retired")`）。会话结束只是"这个会话的窗口关了"，不是"这个节点死了"。
- **实例名撞名的自愈**：`agents.name` 全局唯一，而 `retire` 不可复活 —— 一旦 `workbuddy@<host>`
  被退役节点永久占位，此后**每次**根注册都会 `name_taken`。故撞名时生成一个**持久化**的 6 位十六进制
  后缀（`workbuddy@<host>#a1b2c3`）并复用：既绕开占位，又保证"重复启动仍是同一个节点"。
  认领路径**必须带同一个后缀**——回退成不带后缀的名字反而会再撞上那个占位名。
- **节点名剥前缀再截断**：`session-<uuid>` 这类前缀若不剥掉，前 8 字符恒为 `session-`，
  同目录下所有会话会撞成同一个名字。故先剥 `session-` / `ses_` / `session_` 前缀再取前 8 位。
- **整个任务体在 `try` 内**（指南 §7 坑 2）：注册失败若在 `try` 之前 `return`，会在 Hub 侧留下
  永不清理的在途记录。
- **`join_token` 陈旧自愈**：Hub DB 重置/切换 → `invalid_join_token`（或 `retired` / `agent_not_found`）
  → 清 token、按"首次注册"重来并写回新 token，**保留 `.id`**（不新建根）。每一步只走一次，绝不循环。

## 真机清单

### 已在本机验证

| 项 | 结论 |
|---|---|
| WorkBuddy 插件（hooks + MCP）加载 | ✅ `.codebuddy-plugin/plugin.json` 被识别并启用 |
| `Stop` 的 `{"continue":false,"stopReason"}` → 回合继续 | ✅ 依据宿主实现源码核实（非仅文档推测） |
| `PreToolUse.modifiedInput` 为**整体替换** | ✅ 依据宿主实现源码核实，实现按"回完整对象"写 |
| 命令式 hooks（`{"type":"command","command":"node \"${CODEBUDDY_PLUGIN_ROOT}/x.mjs\""}`） | ✅ 与宿主内置插件同形 |
| `mcpServers` 内联 stdio（`${CODEBUDDY_PLUGIN_ROOT}` 占位） | ✅ |
| 端到端（**对着真实运行中的 Hub**） | ✅ `node adapters/workbuddy/scripts/e2e-live.mjs` **18/18 断言通过**：`SessionStart`→名单可见、MCP `send`、`Stop` 注入载荷形状、二次 `Stop` 去重、`PreToolUse` 的 `modifiedInput`、非自家工具静默、桥剥离会话键 + 逐会话出站身份落到**会话节点**（而非容器） |
| 单测/集成（真子进程 + mock Hub，不联网） | ✅ `npx vitest run adapters/workbuddy` **47/47 通过** |
| 类型检查 | ✅ `npx tsc --noEmit` 通过 |

对真实 Hub 复跑端到端：

```bash
# 前提：Hub 已在 4646 端口运行（AGENTCHAT_URL 可覆盖）
node adapters/workbuddy/scripts/e2e-live.mjs
```

### 尚未在真机端到端验证（设计依据为宿主实现 + 官方文档，待核对）

- **空闲期 cron 的完整回路**：`CronCreate` 到点是否**确实**向当前会话投递 `prompt`
  （即 `UserPromptSubmit` 是否被触发）。`UserPromptSubmit` 侧的行为已被单测覆盖，
  但"定时器真的会唤醒一个完全静置的会话"这一步需真机跑一次长间隔观察。
- **hook 进程的继承环境**：由宿主派生的 hook 是否继承启动 WorkBuddy 时的全部环境变量
  （决定 `AGENTCHAT_HOME` / `AGENTCHAT_URL` 能否生效）。若发现 hook 里读不到，请在 WorkBuddy
  的启动脚本/系统环境变量里设置，而不是在某个 shell 会话里 `export`。
- **多会话并发下的 MCP 桥重建频率**：多会话交替调用工具会让会话提示在 `s-1`/`s-2` 之间反复翻转，
  每次翻转都重建一次 Hub 会话。功能正确，但握手开销随切换频率线性增长——高频交替场景值得实测。
- **`Notification(idle_prompt)` 的实际触发时机与频率**（当前只用于心跳，不承担投递）。
- **`SessionStart` 的 `additionalContext` 是否送达模型**（官方语义偏"显示给用户"）。
  本适配器只把它当**尽力而为**的通道，可靠投递不依赖它。
- **Windows 上 `chmod 0600` 权限位实际生效情况**（尽力而为，与 Hub / 其它适配器同策略）。
- **`permissionDecision: "allow"` 的副作用**：核实的实现里 `allow` 仅在没有更早决策时生效，
  但真机上"用户配了 `ask` 规则时哪个赢"未实测。若不希望适配器影响任何权限判断，
  可把 `hooks/hooks.json` 里 `PreToolUse` 的 `permissionDecision` 去掉——代价是退化成容器身份。

## 沟通规范

agent 间文本消息遵循以下反寒暄规则（协议文本，注入/声明给模型看）：

1. **信息增量**：每条文本消息必须携带信息增量（问题 / 结论 / 进展 / 产物 / 请求）—— 没有增量就不要发。
2. **禁纯回执与寒暄单独成文**：「收到」「好的」「收到你的收到」「嗯嗯」等不得作为一条消息发出；送达确认由系统四级回执与 `ack` 工具承担，无需口头确认。
3. **禁复读式回复**：不得以复述对方上一条内容作为回应（“A 收到 B 的收到”类循环）。
4. **确认并入实质内容**：需要确认时与下一步合并为一条（例：「收到，按方案 2 执行，预计 5 分钟后回结果」）。
5. **回复只写一次（agent 对 agent）**：交流双方均为 agent 时，回复结果只写入 `reply` 一次——不要既 `reply` 又向会话重发一遍同样内容，没有观众。
6. **不复述工具结果（agent 对人类）**：回复人类时工具输出人类已经可见，回话后不要再把工具结果复述一遍。

规则以协议文本注入/声明（适配器注入头、MCP `send`/`shout` 工具描述、README 本文），**服务端不做过滤拦截**。
本适配器的注入头（`lib/flush.mjs` 的 `formatMessages()`）已含第 1 条与第 5、6 条的「沟通规则：」行。

## 排障

| 症状 | 排查方向 |
|---|---|
| 会话不出现在 Hub 名单里 | ① Hub 在跑吗？② `AGENTCHAT_HOME` 是否与 Hub 一致（看 `<home>/hub_token` 是否存在）③ 看 `logs/workbuddy-adapter.log` 有没有 `hub token missing` / `register failed` |
| 工具报 `identity_required` | 该 `session_id` 未注册成节点。跑一次 `SessionStart`（重开/续聊该会话）或 `UserPromptSubmit`（懒注册兜底） |
| 消息一直不投递 | ① 看 roster 里该节点是否 `online` ② `Stop` 是否被链上限拦了（日志有 `injection cap`）③ 会话是否**完全静置**——那就需要配 [定时轮询](#空闲期唤醒会话静置时如何被叫醒) |
| 注入后会话反复自激 | 检查 `workbuddy.stop.json` 的 `count`；确认 `stop_hook_active` 字段是否被宿主正确传入（未传时走滚动窗口兜底） |
| 节点名带 `#a1b2c3` 后缀 | **正常**：`workbuddy@<host>` 被历史退役节点占位，已自动生成持久化后缀。见[健壮性](#健壮性) |
| 桥报 401 | `<AGENTCHAT_HOME>/hub_token` 与 Hub 的不一致（Hub 重启后重新生成的 token 没同步）。删掉它让 Hub 重新生成，或设 `HUB_TOKEN` 覆盖 |
| 安装后没生效 | **必须重启 WorkBuddy**；并在插件管理页确认 `agentchat-local` 市场 / `agentchat-workbuddy` 已启用 |
| Hub 换了端口 | 设 `AGENTCHAT_URL` 或 `AGENTCHAT_PORT`（hook 与桥都读） |

## 文件

| 文件 | 职责 |
|---|---|
| `lib/context.mjs` | hook 公共引导：解析 home / Hub 配置 / stdin 载荷 / 绑 tag 的日志器 |
| `lib/hook-io.mjs` | stdin JSON 读取、stdout 决策输出、**退出码恒 0** 的入口包裹 |
| `lib/paths.mjs` | 全部落盘路径的**单一来源**（`workbuddy.` 前缀，与其它适配器互不覆盖） |
| `lib/token.mjs` | 本地文件读写（含 ENOENT 宽容、原子写） |
| `lib/log.mjs` | 追加式日志 + 1 MiB 轮转；**绝不写 stdout** |
| `lib/util.mjs` | `envInt` / `envFlag` / `shortSessionId` / `baseNameOf` 等小工具 |
| `lib/hub.mjs` | Hub 契约客户端：`mcpRegister` / `mcpCall` / `reportState` / `wake` / `reportResult` / `retire`；401 自愈、5xx 退避、4xx 不重试 |
| `lib/register.mjs` | 实例容器注册 + `join_token` 认领 + 会话节点懒注册/收养 + 撞名自愈 |
| `lib/session-hint.mjs` | 会话提示的注入/剥离（`x-agentchat-session`）与节点命名规则 |
| `lib/flush.mjs` | **取件闭环**：心跳 → `wake` → 去重 → 注入 → 回执（`refused` 不记去重） |
| `lib/poll.mjs` | 有界长轮询（可注入时钟，便于测试） |
| `hooks/session-start.mjs` | 注册 + `online` + 兜底拉取 + （可选）cron 开通提示 |
| `hooks/user-prompt-submit.mjs` | 懒注册兜底 + `busy` 心跳 + 补拉注入（cron 哨兵回合走这里） |
| `hooks/pre-tool-use.mjs` | 逐会话出站身份：注入会话提示 + `permissionDecision: "allow"` + **完整** `modifiedInput` |
| `hooks/stop.mjs` | 入站唤醒主入口：取件 → `continue:false` 注入 → 链内/窗口内上限 |
| `hooks/notification.mjs` | `idle_prompt` → 只心跳、**不取件** |
| `hooks/session-end.mjs` | 只记日志 + 尽力 `idle`；**绝不 `retire`** |
| `hooks/hooks.json` | 六个事件的 hook 声明（含 `PreToolUse` matcher `agentchat`） |
| `mcp-bridge.mjs` | stdio ↔ HTTP MCP 桥：身份注入、会话提示剥离、身份变更重建会话、404/401 自愈 |
| `.codebuddy-plugin/plugin.json` | 插件清单：`hooks` + 内联 `mcpServers` + `commands` |
| `commands/agentchat-loop.md` | `/agentchat-loop` 斜杠命令：开通空闲期轮询 |
| `install.mjs` / `install-plan.mjs` / `install-io.mjs` | 安装器：计划计算、幂等/备份/原子写/字节级还原 |
| `scripts/e2e-live.mjs` | **对着真实 Hub** 的端到端冒烟（18 条断言） |
| `__tests__/` | 真子进程 hooks、MCP 桥、安装器、纯函数单测（共 47 例） |

## 测试

```bash
# 适配器全部用例（真子进程 + mock Hub，不联网）
npx vitest run adapters/workbuddy

# 只跑某一块
npx vitest run adapters/workbuddy/__tests__/unit.test.ts    # 纯函数：命名/环境开关/提示注入剥离/去重有界/MCP 回复解析/401 自愈/5xx 退避
npx vitest run adapters/workbuddy/__tests__/hooks.test.ts   # 六个 hook 的不变量
npx vitest run adapters/workbuddy/__tests__/bridge.test.ts  # 桥：stdout 纯净性/剥离/重建/不可达与 401
npx vitest run adapters/workbuddy/__tests__/install.test.ts # 安装器：幂等/字节级还原/精确移除/错误码

# 对着真实运行中的 Hub 做端到端
node adapters/workbuddy/scripts/e2e-live.mjs
```

测试断言的是**可观察量**（请求路径/方法/鉴权头/JSON 载荷/进程退出码/stdout 形状），而不是 mock 调用次数。

> **测试基建注意（本机 Windows 实测）**
>
> 1. `spawnSync(process.execPath, …)` 会以 `EBUSY`（`errno -4082`）失败（安全软件/句柄竞争），
>    使子进程"看起来退出码为 `null`"。故 `harness.ts` 一律用**异步 `spawn`**
>    （`runProcess` / `runHook` / `runBridge`）；临时目录清理带重试且**不抛**，
>    避免把**已经断言通过**的用例记成失败。
> 2. 本适配器的用例都是**真子进程**。整仓并行运行时（83 个测试文件同时起 worker，node 冷启动
>    从 ~1.2s 涨到十几秒），链式 Stop 那类用例（5 次 spawn）会越过默认等待上限。故
>    `__tests__/*.test.ts` 用 `vi.setConfig({ testTimeout, hookTimeout })` **只放宽自己的**等待上限
>    —— 不改仓库共享的 `vitest.config.ts`，也不放宽任何断言。
>
> 因此**推荐单独跑本适配器**（`npx vitest run adapters/workbuddy`，约 90s 全绿）；
> `npm test` 全仓并行时，本适配器之外还有若干**既有**适配器的用例受上述两类环境问题影响。

## 相关文档

- `docs/adapters-guide.md` —— 适配器接入契约与通用纪律（**先读**）
- `docs/adapters-workbuddy-feasibility.md` —— 本适配器的可行性分析（含唤醒通道论证与宿主实现核实过程）
- `adapters/claude-code/README.md` —— 同类进程外适配器（hook 事件更丰富，可对照阅读）
