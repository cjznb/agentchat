# AgentChat — DSH 桌面端适配器（bundle）

把 **DSH（DeepSeek Harness）桌面端**接入 AgentChat Hub。每个打开过的 DSH 会话在 AgentChat 里是
**一个联系人（节点）**：会话加入 roster、回合始/末上报 `busy`/`idle`、**空闲时取件**并把其他 agent
发来的消息注入该会话，注入成功后回执 `delivered`。

适配器是 **`adapters/opencode`（已验证的「进程外插件 + MCP 桥」方案）的 DSH 版**，只是宿主扩展点与
安装方式换成 DSH 的 **Cordis bundle / Host 插件面**：

```
AgentChat Hub ──HTTP(/internal/*)+MCP──> adapters/dsh/index.js（Host 插件，进程内）
                    ▲                              │
                    │                    DSH 事件：agent/created ・ agent/status ・ agent/disposed
                    │                              ▼
                    └── mcp-bridge.mjs（stdio MCP）──> DSH agent 的 mcp__agentchat__* 工具
```

> 本文是**自包含**页（设计理由 + 取舍 + 扩展点核实结论）；`adapters/dsh/README.md` 是**更短的运维导读**
> （架构速览、安装四步、排障表），两者口径一致。冒烟步骤中标注「**真机未验证**」的必须由人在真机上跑。

## 概述 / 何时选择

**它做什么**

- **会话即联系人**：`agent/created` 把会话注册为 Hub 节点（`vendor=dsh`），层级为
  **实例容器（根）→ 会话节点 → 子代理会话节点**。
- **状态镜像**：`agent/status` 的 `running`/`idle` 分别上报 `busy`/`idle`；Hub roster 上能直接看到
  哪个会话在跑、哪个空闲。
- **空闲取件注入**：会话空闲时拉取 Hub 上排队的消息，合并为一条 `[AgentChat] …` 文本注入该会话，
  模型据此继续工作；回执按 `delivered`/`refused` 逐条上报。
- **工具面**：本地 stdio MCP 桥把 Hub 的 `POST /mcp` 工具面暴露为 DSH agent 可直接调用的
  `mcp__agentchat__*` 工具（`send` / `ask` / `roster` / …）。

**什么时候选它**

| 你的场景 | 选它 | 说明 |
|---|---|---|
| 主要用 **DSH 桌面端**当 agent，希望它能被别的 agent 找到、被派活、能回信 | ✅ | 会话级节点 + 工具面，两个方向都通 |
| 想让 **DSH 里的多个会话**（不同工作目录 / 子代理）在通讯录里**各自是一个联系人** | ✅ | 会话节点按 `task_ref = session.header.id` 稳定；子代理会话再嵌套其下 |
| 只是在 CLI 里跑一次性命令、不需要常驻会话 | ❌ | 适配器跟随**会话生命周期**；没有会话就没有节点 |
| 需要**逐会话精确的出站记账**（回复从会话节点发出，而不是实例容器） | ⚠️ 部分 | 见「设计取舍与已知限制 (b)」：DSH 禁止改写工具入参，故用磁盘提示兜底——**单会话精确、≥2 个顶层会话退回容器**（此时 Hub 拒绝以容器为收件方的回复） |
| 用的是 OpenCode / Claude Code | ❌ | 见 [`docs/adapters-opencode.md`](adapters-opencode.md) / [`docs/adapters-claude-code.md`](adapters-claude-code.md) |

前置：Node ≥ 22；Hub 可启动（`npm start`，默认 `http://127.0.0.1:4646`，首次启动写出
`<AGENTCHAT_HOME>/hub_token`）；**DSH 桌面端已安装**并至少创建过一个 profile。

## 架构与语义

### 节点层级

```
实例节点 dsh@<host>            ← 根，role_tag=container（分组容器，不是聊天对象）
                                 join_token 认领；MCP 出站身份的**兜底**（<home>/agents/dsh.id）
                                 单会话时实际出站身份取 <home>/agents/dsh.current（见「设计取舍 (b)」）
└─ 会话节点 <cwd 目录名>-<id8>  ← task_ref = session.header.id（Hub 侧幂等稳定）
   └─ 子代理会话节点            ← header.origin === 'subagent'，parent_ref = 父会话节点
```

| 层 | 注册参数 | 说明 |
|---|---|---|
| 实例节点 | `role_tag=container`、`purpose=coding-agent`、`name=dsh@<host>`、`join_token`（续连认领） | **懒注册**：第一个 `agent/created` 时建立；`config.name` 可改名 |
| 会话节点 | `parent_ref=<实例节点 id>`（或父会话节点）、`task_ref=<session.header.id>`、`purpose=coding-agent` | 名字 `<cwd 目录名>-<会话 id 前 8 位>`；无 `cwd` 回退 `dsh-<id8>` |
| 子代理会话节点 | 同上，`purpose=subagent`，父 = `header.parentSession` 已注册时的该节点 | 判据是 `header.origin === 'subagent'` |

> **名字必须唯一**：Hub 的 `agents.name`（与展示名）都有唯一索引。同一目录下多开会话时纯目录名会撞键，
> 故会话节点一律带会话 id 短后缀；标题由 DSH 侧的会话标题插件掌握，适配器**不猜也不跟随**（避免与
> 唯一索引反复冲突）。同一台机器跑多个不同 `AGENTCHAT_HOME` 的实例时，用 `config.name` 区分实例节点。

### 扩展点 → 适配器动作

| DSH 扩展点 | 适配器动作 |
|---|---|
| `agent/created` | **懒注册实例节点**（首次；`role_tag=container`，`join_token` 落盘 `<home>/agents/dsh.token`）；把该会话注册为实例节点的**子节点**（`task_ref=<session.header.id>`），上报 `online` |
| `agent/status` = `running` | 会话节点上报 `busy`，**停**空闲轮询 |
| `agent/status` = `idle` | 会话节点上报 `idle` → 走一次取件闭环 → 启动空闲轮询（默认 10s） |
| `agent/disposed` | **只停本地跟踪（停轮询、丢映射），不退役节点**（理由见「设计取舍 (a)」） |
| 插件卸载（`ctx.effect` 清理） | 停全部轮询；**实例节点（根）上报 `offline`**；会话子节点不报 offline |
| `mcp-bridge.mjs`（stdio MCP 桥） | 把 Hub 的 `POST /mcp` 工具面暴露为 DSH 的 `mcp__agentchat__*` 工具 |

取件闭环（`lib/flush.js`，与宿主解耦，宿主相关操作只有注入函数）：

```
idle 心跳（会话节点 + 实例节点各一次 idle，实例根不搭车会被判 offline）
  → POST /internal/wake（按**会话节点** id 认领积压）
  → 有消息 → 合并渲染成一条注入文本 → agent.followup/steer
  → 逐条 POST /internal/result（delivered / refused）
```

去重的唯一权威是**有界 `seen` 集**（上限 256，FIFO 淘汰）：Hub 的在途租约到期重投同一 `messageId` 时**绝不
重复注入**，只幂等补回执；`refused` **不写入 `seen`**（注入被拒 = 尚未注入，下一轮仍会尝试）。

### 为什么注入用 `followup` / `steer`，而**不用** `inject`

核实自 DSH 运行时（见附录 C）：三个方法都只是 `send(message, target, wakeup)` 的薄封装，差别在 `wakeup`：

| 调用 | 等价于 | 语义 |
|---|---|---|
| `agent.followup(msg)` | `send(msg, 'next-turn', true)` | 开**新回合**并**唤醒**驱动；该消息成为其回合的唯一普通消息 |
| `agent.steer(msg)` | `send(msg, 'next-step', true)` | 在**最近的 step 边界**交付并**唤醒**；空闲驱动会因此起一个回合 |
| `agent.inject(msg)` | `send(msg, 'next-step', false)` | **不唤醒**：只作为下一步的模型可见上下文；空闲驱动会一直让它躺在收件箱，直到别的输入把它唤醒 |

取件必须**唤醒**，所以：

- 会话**空闲** → `followup`（开新回合并唤醒，符合「唤醒即续跑」语义）；
- 注入时该会话**恰好已 `running`** → `steer`（在下一个 step 边界即被看到，不额外插一个回合）；
- **绝不**用 `inject` 取件——它不会唤醒，消息会被静默滞留。

注入消息的来源标为 **`{kind:'plugin', plugin:'agentchat', form:'relay'}`**——`form: 'relay'` 的 DSH 语义正是
「另一个 agent 发来的消息」，与 AgentChat 的中继投递完全对应（见附录 C 的 `MessageSource`/`ContextForm`）。

消息对象优先用 `@deepseek-ai/dsh-llm` 的 `createUserMessage({content, source})` 构造；该模块不可用时
**退化为自带 `randomUUID()` 的最小 UserMessage**（同形状：`{id, role:'user', content:[{type:'text',text}], source}`），
只记一次日志，不中断投递。

### 为什么需要空闲轮询（默认 10s）

宿主只在**事件**上触发取件，而消息可能在会话**已经 `idle` 之后**才到达 Hub——此时没有任何 DSH 事件可依，
消息会永久停在「排队中」。故 `idle` 之后启动**周期轮询**（`AGENTCHAT_POLL_MS`，默认 `10000`ms），每轮走与
idle 状态**同一条 `flush` 路径**。轮询器纪律（`lib/poll.js`）：

- **无重叠执行**：`run()` 未落定前不排下一个定时器；定时器 `unref()`（尽力而为）不阻塞宿主退出；
- 失败**指数退避**（`interval · 2^failures`，上限 60s），成功立即复位基础间隔——Hub 不可达时不刷屏不自旋；
- 间隔**钳制**到 `[1000, 3600000]`ms，非法值回落 10s；
- `running` 时停轮询（busy 期间靠 `steer`/下一轮完场，不需要空转）。

## 安装

```powershell
# 1) 安装（幂等；--dry-run 只打印；--uninstall 精确回退）
node adapters/dsh/install.mjs --profile desktop

# 2) 重启 DSH 桌面端（bundle 选择与 MCP 行都在启动时装配）

# 3) 验证节点出现
curl http://127.0.0.1:4646/api/roster
```

安装器**不改动 DSH 自带文件**，只动四处产物；`--uninstall` 逐一反向，**幂等**（在已安装/已卸载状态下
所有动作 `changed=false`）。写盘前备份 `<file>.bak`（仅当原文件存在），一律**临时文件 + rename** 原子替换。

`install.mjs` 做的四件事：

| # | 产物 | 内容 | 为什么需要 |
|---|---|---|---|
| 1 | `<DSH_HOME>/profiles/node_modules/@agentchat/dsh-adapter` | **目录联接** → 本适配器目录（Windows 用 `junction`，无需提权；其它平台 `dir`） | DSH 启动器在 `<DSH_HOME>/profiles/node_modules` 维护**共享扁平模块根**，profile manifest 里的 `file:` 依赖靠它解析 |
| 2 | `<DSH_HOME>/profiles/<profile>/package.json` | `dependencies["@agentchat/dsh-adapter"] = "file:<适配器绝对目录>"`（路径**一律写成正斜杠**，Windows 原生反斜杠在 manifest 里会被转义）**且**把包名追加进 `dsh.profile.bundles` | 只建联结不登记是不够的：loader 只对**被选中**的 bundle 合成其 patch |
| 3 | `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` | **受管块**（`MANAGED_HEAD`/`MANAGED_TAIL` 两个 marker 界定），插入 Hub 的 MCP 工具行 | MCP 行含**机器相关**的绝对路径，不能随包发布；重复安装只替换块内文本，`--uninstall` 只摘这一块 |
| 4 | `<AGENTCHAT_HOME>/config.json` | `adapters` 追加 `dsh` | 显式厂商登记（免手动设 `AGENTCHAT_ADAPTERS`）；Hub 也会在首次收到该厂商 `/internal/wake` 时自动识别为 pull 适配器，故**未登记也不丢消息** |

受管块的形状（写入 profile 用户 patch 层；`<node>` = 安装时的 `process.execPath`，`<bridge>` = 本目录
`mcp-bridge.mjs` 的绝对路径）：

```yaml
# >>> agentchat adapter (managed) — 由 adapters/dsh/install.mjs 维护，请勿手改
- insert:
    - id: agentchat-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agentchat
        transport: stdio
        command: '<node>'
        args:
          - '<bridge>'
# <<< agentchat adapter (managed)
```

### 命令行开关

| 开关 | 默认 | 作用 |
|---|---|---|
| `--profile <name>` | `$DSH_PROFILE` 或 `desktop` | 目标 profile 名 |
| `--dsh-home <path>` | `$DSH_HOME` 或 `~/.dsh` | DSH home（profile 与共享模块根都在其下） |
| `--agentchat-home <path>` | `$AGENTCHAT_HOME` 或 `~/.agentchat` | AgentChat 数据目录（写 `config.json` 的 `adapters`） |
| `--dry-run` | 关 | 只打印将要写入的路径与**完整内容**（stdout），不落盘；是否有改动打到 stderr |
| `--uninstall` | 关 | 反向执行四步（移除联接、`file:` 依赖与 bundle 选择、受管块、厂商登记），幂等 |
| `--help` / `-h` | — | 用法与四步说明 |

安全边界（宁可报错也不破坏用户配置）：

- 目标 profile 目录不存在 → **报错退出（非 0）**，提示先在 DSH 桌面端创建该 profile 或用参数指定；
- profile patch 顶层**不是 YAML 数组** → **拒绝改写并抛清晰错误**（顶层校验只看第 0 列的行，
  以免把合法的列表续行误判为非数组）；
- 联结路径已存在且**不是**符号链接/目录联接（例如 pnpm 铺开的实体目录）→ 拒绝覆盖；
  卸载时同样只对**链接本身**下手（绝不 `rm -rf` 穿透联接删掉目标内容）。

### 官方支持的 Desktop 替代路径

DSH 桌面端自己带一个 `plugin_manager` 工具（**Desktop 宿主的工具**，不在 npm 安装的 `dsh` 里可见）。
也可以让它执行：

- `action: install_bundle`
- `target: <本适配器目录的绝对路径>`

这是 Desktop 推荐的安装方式（需要用户批准）。**注意它只装 bundle**——MCP 工具行里的**绝对路径**
（node 可执行文件与 `mcp-bridge.mjs`）仍要由 `install.mjs` 写进 profile 的 `cordis.patch.yml`。
两者可组合：先用 `plugin_manager` 装 bundle，再跑 `install.mjs` 补齐 MCP 行（第二次运行是幂等的）。

### 安装后

**重启 DSH 桌面端**——bundle 选择与 MCP 行都在启动时装配；Host 插件是**进程内加载**，替换已安装包
同样需要重启才能加载新的模块代。随后用 `GET /api/roster` 确认节点出现。

## 配置

### bundle 行 `config`

`adapters/dsh/cordis.patch.yml` 里 `id: agentchat-dsh` 那一行的 `config`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `pollMs` | `AGENTCHAT_POLL_MS` → `10000` | 空闲轮询间隔（毫秒）。消息在「已经 idle 之后」到达时靠它补拉 |
| `name` | `dsh@<host>` | 实例节点可读名。同一台机器跑多个不同 `AGENTCHAT_HOME` 的实例时用它避重名 |

> 该 patch **只插入插件行**，不含任何机器路径——所以同一份包可以被任意路径安装
> （`plugin_manager install_bundle`、`pnpm add <目录>`、或本安装器的联结），不会把开发机路径写进版本库。

### 环境变量

| 变量 | 默认 | 作用域 | 说明 |
|---|---|---|---|
| `AGENTCHAT_URL` | `http://127.0.0.1:<AGENTCHAT_PORT 或 4646>` | 插件 + 桥 | Hub 地址（尾部 `/` 归一化）。插件据此定位 `/mcp` 与 `/internal/*`，桥据此定位 `/mcp` |
| `AGENTCHAT_PORT` | `4646` | 插件 + 桥 | 仅用于推导默认 `AGENTCHAT_URL` |
| `HUB_TOKEN` | 自动读磁盘 | 插件 + 桥 | 传输门 token **覆盖**：非空时优先（trim 后判空）。缺省时两者都自动读 `<AGENTCHAT_HOME>/hub_token` |
| `AGENTCHAT_HOME` | `~/.agentchat` | 插件 + 桥 | 数据目录：`hub_token`、`agents/dsh.*`、`logs/dsh-adapter.log` 的落盘根（与 Hub 一致） |
| `AGENTCHAT_POLL_MS` | `10000` | 插件 | 空闲轮询间隔（钳制 `[1s, 1h]`，非法回落 10s）；bundle 行 `config.pollMs` 优先 |
| `AGENTCHAT_TIMEOUT_MS` | `3000` | 插件 | 插件对 Hub 的**单次 HTTP 超时**（仅测试用途；生产恒 3s）。可重试失败按 `min(30s, 250ms·2^attempt)+jitter` 退避，最多 4 次尝试 |
| `AGENTCHAT_MCP_TIMEOUT_MS` | `30000` | 桥 | 桥转发到 Hub 的**单次上游请求超时**，钳制 `[100ms, 600000ms]`，非法回落 30s |
| `AGENTCHAT_LOG` | （落文件） | 插件 + 桥 | 设为 `console` 时诊断改打 **stderr**（调试回退，默认关闭）；缺省写 `<AGENTCHAT_HOME>/logs/dsh-adapter.log` |

**token 解析顺序（插件与桥一致）**：`HUB_TOKEN`（非空优先）→ `<AGENTCHAT_HOME>/hub_token`（trim）→ 空。
安装器**不写任何 token**，安装步骤无需 `export HUB_TOKEN`；两处都拿不到时插件会打明确 warn，调用按既有
401 路径失败。

> **为什么桥必须自己读 `<AGENTCHAT_HOME>/hub_token`**：DSH 的 MCP 客户端 spawn stdio 子进程时会**清洗环境**
> ——名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量与**全部 `DSH_*`** 都被删除（核实自
> `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv`，见附录）。于是 `HUB_TOKEN` 常常**对桥不可见**。
> 桥因此**逐请求**重新解析 token（Hub 换 token 后无需重启桥即可自愈），且诊断信息**绝不含 token 值**。

插件侧的 401 自愈：任一 Hub 调用返回 401 → **重读一次** token，有**新值且不同**才更新共享 bearer 并
**仅重试这一次**（不循环、不退避）。

## 验证

### 已存在的自动化覆盖

以下测试是仓库里**实际存在**的，读代码即可核对（本页不重复跑它们）：

| 测试文件 | 覆盖什么 |
|---|---|
| [`tests/integration/dsh-plugin.test.ts`](../tests/integration/dsh-plugin.test.ts) | **真 Hub**（`server/index.ts` 的 `start({port:0})` + 真实路由/store/dispatcher）+ 假 DSH 宿主。断言 ① `agent/created` 后 roster 出现会话节点（`vendor=dsh`、挂在 `role_tag=container` 的实例节点下、名字唯一、状态 `online`）② 消息先排队、再驱动 `idle` → 假 agent 的 `followup` **恰收到一条**（含 message id 与正文、未走 `steer`）③ 该消息的 `wake_jobs` 落 **`accepted`** ④ 回执落定后再取件**绝不二次注入** ⑤ `running` 期间在途认领的交付走 **`steer`**（用本地中继把「在途 flush」窗口做成确定性）⑥ `agent/disposed` **不退役**：节点仍在 roster 且同 `task_ref` 可再次注册为**同一个 Hub id** ⑦ 插件诊断只落文件、**stderr 全程为空** |
| [`adapters/dsh/__tests__/plugin.test.ts`](../adapters/dsh/__tests__/plugin.test.ts) | 假 Hub 单测：注册层级与顺序（实例根 → 会话子）、子代理 `purpose=subagent` 且 `parent_ref=父会话节点`、`join_token` 复用与 `invalid_join_token` 自愈（清 token 重建、**保留 `dsh.id`**）、`running`→`busy` / `idle`→`idle`+心跳、`followup`/`steer` 分流、`seen` 去重只补回执、disposed 不退役（不发 `/internal/retire`、不报 offline）、卸载上报实例 `offline`、**Hub 全 500 时监听器不抛且无未处理拒绝** |
| [`adapters/dsh/__tests__/install.test.ts`](../adapters/dsh/__tests__/install.test.ts) | 安装器：四步规划全程不落盘、写进已有 patch 保留用户条目、**安装两次逐字节相同**（幂等、不重写 `.bak`）、`--dry-run` 只计算不落盘、**卸载后与安装前快照逐字节相同**、受管块只替换块内文本、CRLF 保持、顶层非 YAML 数组时拒绝改写、`parseArgs`、目录联接 |
| [`adapters/dsh/__tests__/lib.test.ts`](../adapters/dsh/__tests__/lib.test.ts) | 契约层：MCP `register` 握手（SSE 与裸 JSON）、工具层 `isError` → `HubToolError` 带稳定 code、**重试/退避策略**（5xx/429 退避、4xx 不重试、401 后重读 token 只重试一次）、`/internal/*` 载荷、`wake` 畸形项过滤、`parsePollMs`/`IdlePoller`（不重入、退避、stop 后不再 tick）、`createIdleFlush` 闭环（含 `refused` 不写 `seen`）、文件日志轮转、token 文件读写 |
| [`adapters/dsh/__tests__/mcp-bridge.test.ts`](../adapters/dsh/__tests__/mcp-bridge.test.ts) | 桥：行帧（跨 chunk、CRLF、超长丢弃）、`initialize` 会话捕获与回带、**token 判序**、`x-agent-id` 懒解析只在命中时缓存、`tools/list`/`tools/call` 原样转发、`x-agentchat-session` **从入参剥离并转请求头**、`404 session_not_found` 重 init 后重试一次、连不上/超时回 JSON-RPC error 且桥存活、未知方法 `-32601`、诊断只落文件且 **stdout 恒为 JSON-RPC 帧** |

覆盖边界：自动化只到「**真实 Hub + 假 DSH 宿主**」。**真机项**必须由人跑——DSH 桌面端加载 bundle 后的
事件实际触发、`followup` 是否真的唤醒会话、桌面端 UI 上的观感。

### 手动冒烟清单（**真机未验证**）

1. **[ ] 节点现身**：启动 Hub 与 DSH 桌面端后
   ```bash
   curl http://127.0.0.1:4646/api/roster
   ```
   roster 里应出现 `dsh@<host>`（`role_tag=container`，子节点下挂着打开过的会话），以及会话节点
   （`vendor=dsh`，名字形如 `<目录名>-<id8>`）。
2. **[ ] 空闲注入**：从另一个节点（Hub Web UI 或另一 agent 的 MCP `send`）向**某个会话节点**发消息；
   在该会话**空闲**时，消息被注入，模型看到 `[AgentChat] 你收到了以下来自其他 agent 的消息…`。
3. **[ ] 回执变 `delivered`**：Hub 侧该消息回执应为 `delivered`（`message_status` 工具或 Web UI 气泡回执）。
4. **[ ] 运行中走 `steer`**：会话正在跑回合时发消息 → 下一次 step 边界即被注入（不会另开一个回合）。
5. **[ ] 重开同一会话重新认领**：关闭该会话（DSH 里切走/关标签）后再打开 → 节点被**重新认领**
   （同一 `task_ref`，不新建节点、不报错）。
6. **[ ] 退出 DSH → 自然 offline**：容器节点在 Hub 的 `last_seen` 阈值后变 `offline`；会话节点同样
   自然 offline（**不退役**）。

## 排障

先看日志：**`<AGENTCHAT_HOME>/logs/dsh-adapter.log`**（行格式 `<ISO 时间> [plugin|mcp-bridge] <消息>`）。

| 现象 | 原因 | 处理 |
|---|---|---|
| roster 里没有 `dsh@<host>` | 传输门 token 未解析到（401） | 看日志里的 warn；启动 Hub 会写出 `<home>/hub_token`，也可显式设 `HUB_TOKEN`。确认 `AGENTCHAT_HOME` 与 Hub 一致 |
| 节点出现但**从不收消息** | 该节点没进过 `idle`，或其 `vendor` 未被 Hub 登记为 pull 适配器 | 日志里应有 `wake failed` 之类；确认 `/internal/wake` 未被 401 拦截；确认会话确实经过 `agent/status = idle` |
| 消息被注入但**模型看不到** | 只写进了收件箱而未唤醒 | 本适配器用 `followup`（会唤醒），`inject` **不会**；核对代码/日志走的是哪条通道 |
| 注册报 **`name` 唯一冲突**（`name_taken`） | 同一目录多开导致同名 | 适配器已带会话 id 短后缀；若仍冲突，改 `config.name`（实例节点）或确认没有别的适配器占用同名 |
| 日志出现 **`RegistrationError("retired")`** | 该 `task_ref` 的节点曾被退役（旧版本适配器或手工 retire） | Hub 侧**无法复活**：删除该节点或换 `task_ref`（例如换工作目录重开会话） |
| MCP 工具 `mcp__agentchat__*` **不存在** | MCP 行没进 profile 的 `cordis.patch.yml`；或 `mcp-bridge.mjs` 路径失效（移动过仓库）；或 DSH 未重启 | 重跑 `install.mjs`；确认受管块在目标 profile 的 patch 文件里；重启 DSH 桌面端 |
| 工具调用报「读不到 Hub 传输门 token（…hub_token）」 | Hub 还没写过 `hub_token`（未启动或 `AGENTCHAT_HOME` 不一致） | 先 `npm start`；桥**逐请求**重读，启动 Hub 后重试即可，无需重启 DSH |
| 工具调用报 `401 unauthorized` | 磁盘 `hub_token` 与 Hub 的 token 不一致（换过 `AGENTCHAT_HOME` / 重置过 Hub） | 用 Hub 当前 `<AGENTCHAT_HOME>/hub_token` 覆盖；桥逐请求读盘，改对后重试 |
| 工具调用报 `400 agent_not_found` | `<home>/agents/dsh.id`（或 `dsh.current`）陈旧——通常是 Hub 换库/重置后 | 适配器会**自愈**：桥遇到该错误即清缓存身份与会话、**只重试一次**（重新 `initialize`）；插件注册成功后会重写 `dsh.id`。若持续失败，检查 `AGENTCHAT_HOME` 是否与 Hub 一致 |
| 对端**无法回复**本 DSH 会话（报 `container_not_chat_target`） | 当前有 **0 个或 ≥2 个顶层会话**，出站身份退回了实例容器 | 只留一个顶层会话即可恢复双向；或改用原生工具面（见「设计取舍 (b)」） |
| **改了适配器代码不生效** | Host 插件是**进程内加载**：模块代在启动时固定 | 重启 DSH 桌面端；替换已安装包同样必须重启 |
| `--uninstall` 后配置里还留着空容器 | manifest 原本就是手写的、缺 `dependencies`/`dsh.profile.bundles` 容器 | 安装器**只增删自己那两个位置**、不删空容器（不做启发式猜测以免误删用户结构）——残留空容器是预期行为 |

**日志位置与轮转**：`<AGENTCHAT_HOME>/logs/dsh-adapter.log`（插件与桥**共用**同一文件，靠行内 tag 区分）。
单文件超过 **1 MiB** 时在下一次写入前整体改名 `.1`（覆盖旧 `.1`，只保留一份）；日志失败一律**静默**
（绝不影响宿主）；日志行**绝不含** token 值；`AGENTCHAT_LOG=console` 可临时改打 stderr。
**stdout 绝不用于诊断**——桥的 stdout 就是 MCP 传输通道（只允许 JSON-RPC 帧）。

## 设计取舍与已知限制

### (a) `agent/disposed` **不**退役节点

Hub 的 `registerChild` 按 `task_ref` **收养**既有节点（同一 `task_ref` 再次注册即认领同一 id），
但**已退役节点永久拒绝**同一 `task_ref` 的再注册——报 `RegistrationError("retired")`，这是**单向门**。

DSH 的 `agent/disposed` 表示「agent 离开注册表」：关闭、切走、乃至**之后还会被重新打开**的会话都会触发它，
而 **DSH 没有「会话被删除」事件**。在这里退役，会让用户重开同一会话后**永远无法再注册**。
故适配器只停跟踪（停轮询、丢本地映射）；失联节点由 Hub 的 `last_seen` 阈值**自然判 `offline`**。
子节点也不能报 offline（Hub 以 `child_never_offline` 拒绝），故离开即静默。

`/internal/retire` 的实现仍保留在 `lib/hub.js`（`404 agent_not_found` 视为已退役、幂等），
供将来有明确删除事件时使用。

### (b) 出站身份：**单会话精确（磁盘提示），多会话退回容器**

Hub 的 `send`/`ask` 等工具按**调用方身份**记账（MCP `initialize` 的 `x-agent-id`，或逐请求的
`x-agentchat-session` 头）。OpenCode 适配器靠 `tool.execute.before` 把当前会话 id 注入工具入参、由桥剥离
转成请求头，从而把调用记在**会话节点**名下。

**DSH 做不到入参注入**：`tools/pre-execute` 的决定类型**只有** `allow` / `deny` / `ask`，官方 JSDoc 明确
*「Input rewriting is excluded because arguments are already logged and presented」*——无法改写工具入参，
也就没有逐调用注入会话提示的地方。此外 **Hub 只在创建 MCP 会话时读一次 `x-agent-id`**
（`server/routes/mcp.ts` 的 `initializeContext`）：同一 MCP 会话内后来再改这个头**不会**生效，
只能靠 `x-agentchat-session` 逐请求重解析。

因此本适配器用**磁盘会话提示**替代入参注入：

- 插件维护 `<AGENTCHAT_HOME>/agents/dsh.current`：当**恰好一个顶层会话节点**（实例节点的直接子节点，
  子代理会话不计入）存在时写入该会话的 Hub 节点 id；0 个或 ≥2 个顶层会话时**删除**该文件。
- `mcp-bridge.mjs` **逐请求**把 `x-agent-id` 解析为 `agents/dsh.current`（有则用）→ 否则 `agents/dsh.id`
  （实例容器）；解析值一旦**变化**（含「从未知变为已知」）就丢弃缓存的 Hub 会话，下一次请求重新
  `initialize` 并带上新头——这是身份能改变的唯一途径。Hub 报 `400 agent_not_found`（如换库/重置）时同样
  清缓存身份与会话并**只重试一次**。

由此的行为边界：

| 场景 | 出站记账 | 对端能否回复本 DSH 会话 |
|---|---|---|
| **恰好一个**顶层会话在跑（桌面端最常见） | 该**会话节点** | ✅ 可以：回复落到会话节点，插件会唤醒并注入 |
| 0 个或 ≥2 个顶层会话并存 | **实例容器**（`dsh@<host>`） | ❌ 不能：Hub 拒绝以分组容器为**收件方**的 DM（`container_not_chat_target`），对端拿到**明确错误**而非静默失败 |

**收件（唤醒/注入）始终按会话节点进行，与上表无关**；受限的只是「由本 DSH 会话发起的 MCP 出站记账」。
容器节点是「分组容器、非聊天对象」，故不能作为回复目标。

**彻底修法**：在本插件里用 `ctx.tools.register()` 注册**原生工具**（而非 MCP 桥）代理 Hub 工具面——
原生工具能拿到调用它的 agent 上下文，即可在**任意并发会话数**下按会话精确归属。本版本为对齐已验证的
OpenCode 结构（原生插件 + MCP 桥）而采用「磁盘提示」折中；桥里 `x-agentchat-session` 的
**入参剥离 → 请求头**路径**照旧保留**（今天没有注入方，等价于不存在），待原生工具面落地后直接复用。

### (c) bundle 刻意不含机器相关路径

`adapters/dsh/cordis.patch.yml` 只插入**插件行**（包名 `@agentchat/dsh-adapter`，由 profile 模块根解析），
**不写任何绝对路径**。机器相关的东西（Hub MCP 行的 node 可执行文件与 `mcp-bridge.mjs` 绝对路径、厂商登记）
一律由 `install.mjs` 写进**该 profile 的用户 patch 层**。这样同一份包可以被**任意路径**安装
（联结、`pnpm add <目录>`、`plugin_manager install_bundle`），也不会把开发机路径写进版本库。
代价是：**移动仓库目录后必须重跑 `install.mjs`**（受管块里的绝对路径会失效）。

### (d) 纯 ESM JS，无构建步骤

插件与桥都是**纯 ESM JavaScript**（不参与 `tsc`、无第三方依赖、只用 node 内置与本适配器 `lib/*.js`）。
理由：

- bundle 由**宿主进程**加载（不是由本仓工作区解析），任何构建产物/路径映射都会多一层易碎假设；
- 适配器**不 import 本仓 server 代码**，只经 HTTP 契约与 Hub 通信——HTTP 契约是唯一耦合面，
  类型检查帮不上忙，反而增加「构建产物与源码不同步」的风险；
- 宿主加载的是**已安装的模块代**，无构建步骤意味着「改文件 → 重启即生效」，排障路径最短。

### 其它已知限制

- **逐会话出站身份**：见 (b)，本版本无法做到（真机未验证项：将来 `ctx.tools.register()` 路线的可行性）。
- **本机自动化覆盖不到的部分**：桌面端实际加载 bundle 后的事件触发、`followup` 是否真的唤醒会话、
  桌面端 UI 的观感——**真机未验证**。
- `AGENTCHAT_HOME` 不一致（Hub 与适配器指向不同目录）会表现为 token/id 读不到：这是环境错误而非适配器缺陷。

## 附录：DSH 扩展点核实结论

本附录把适配器**实际依赖**的 DSH 宿主事实列成可核对的清单。引用一律写成**包内相对路径**
（相对 `@deepseek-ai/dsh` 安装里的 `node_modules/@deepseek-ai/`），格式 `包/路径:行`，
可直接在安装目录里定位。**行号为核实时的读数**，升级 DSH 后可能漂移（以代码为准）。
本机核实版本：`@deepseek-ai/dsh` **0.1.0-rc.6**，各 `dsh-*` 包报 **0.2.0-rc.2**。

### A. 插件与 bundle 形态

| 事实 | 引用 |
|---|---|
| Cordis 接受函数/类/带 `apply` 的对象；`apply(ctx, config)` 是各 DSH 宿主插件共同采用的形式 | `cordis/lib/types/registry.d.ts:48-81` |
| 函数插件上可挂 `name` / `inject` / `Config`（`Config` 是 standard-schema 校验器，加载前 `resolveConfig`，失败抛 `ValidationError`） | `cordis/lib/types/registry.d.ts:53-58,71-72`；`cordis/lib/types/fiber.d.ts:13-31` |
| **bundle** = 任何 `package.json` 声明 `dsh.bundle.patch` 的包 | `dsh-app-boot/lib/index.js:293-294` |
| 组合顺序 = `dsh.profile.bundles` 里各 bundle 的 patch 依次 → profile 自己的 patch → 启动器层 | `dsh-app-boot/lib/index.js:290-297` |
| patch 顶层是 YAML 数组；`insert` 无 `id` 时追加到根列表（有 `id` 且目标为 `group` 时追加进其 `config`） | `dsh-app-boot/lib/index.js:68-85` |
| 非 `insert` 的 patch 必须带 `id`，可选校 `name`（不符则跳过 + warn），其余键**整体赋值**到目标（`config` 是**替换而非合并**） | `dsh-app-boot/lib/index.js:87-104` |
| `$DSH_HOME/profiles/node_modules` 是 DSH 维护的**共享扁平模块根**，宿主侧 `dsh-*` 包从任何 profile 都可解析 | `dsh-app-boot/lib/index.js:390-438` |
| `plugin_manager` / `action: install_bundle` **不在** npm 安装的 `dsh` 里（`dsh-plugin-manager` 包不存在）——它是 **Desktop 宿主自带**的工具，契约以 Desktop 为准 | 本机核实（npm 安装中不存在）；`install_bundle` 语义按 Desktop 文档 |

适配器的对应物：`package.json` 里 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，
patch 为单条 `- insert:` 行（`id: agentchat-dsh`、`name: '@agentchat/dsh-adapter'`、`config.pollMs`）。

### B. 事件：确切名称与载荷

所有条目都是 Cordis 事件，用 `ctx.on(name, listener)` 注册；`@mode emit` = 同步 fire-and-forget
（监听器失败被兜住）。

| 事件 | 模式 | 载荷 / 参数 | 引用 |
|---|---|---|---|
| `agent/created` | emit | **只有** `{ agent }`（**没有** `source`/`signal`） | `dsh-agent/lib/types/runtime-types.d.ts:146-148` |
| `agent/disposed` | emit | `{ agent }` | `dsh-agent/lib/types/runtime-types.d.ts:157-159` |
| `agent/status` | emit | `{ agent, status: 'idle' \| 'running' }`（= 刚进入的状态） | `dsh-agent/lib/types/runtime-types.d.ts:169-172`；`AgentStatus` 定义 `:45` |
| `session/event` | emit | `(session, event: SessionEvent)` —— 提交后的追加 feed，`event` 与落盘记录一致 | `dsh-session/lib/types/index.d.ts:66` |
| `session/created` / `session/disposed` | emit | `(session)` | `dsh-session/lib/types/index.d.ts:44,54` |
| `session/flush` | parallel | `(session): Promise<void> \| void` | `dsh-session/lib/types/index.d.ts:75` |
| `subagent/start` | emit | `(info: SubagentRunInfo)` → `{runId, provider, id, local}` | `dsh-subagent/lib/types/index.d.ts:86` |
| `subagent/end` | emit | `(info: SubagentRunEndInfo)` → 追加 `stopReason`、`lastAssistantMessage?` | `dsh-subagent/lib/types/index.d.ts:95` |
| `tools/pre-execute` | waterfall | `(exec, next)` → `PreToolDecision` | `dsh-tools/lib/types/index.d.ts:38` |
| `tools/execute` | waterfall | `(exec, next)`（包装者**只能**改 `exec.signal`） | `dsh-tools/lib/types/index.d.ts:49` |

**「回合始/末」不是 agent 事件，而是 session 事件**：它们被追加进会话日志——`turn/start {turn}`、
`turn/end {turn, reason}`。要观察它们就监听 `session/event` 并按 `event.type` 分派，或者监听
`agent/status`（唤醒时 `'running'`，无驱动残留时 `'idle'`）。

| 事实 | 引用 |
|---|---|
| `turn/start` 载荷 `{ turn: number }`；`turn/end` 载荷 `{ turn, reason: TurnEndReason }` | `dsh-session/lib/types/types.d.ts:230-232,241-244` |
| `'running'` = 唤醒交付在预留取消后**同步**进入；`'idle'` = 没有驱动被调度或活跃 | `dsh-agent/lib/types/runtime-types.d.ts:160-163` |
| **注意**：`agent/created` 只有 `{ agent }`；某随包发行的示例插件按 `{ agent, source, signal }` 解构，那两个字段在运行时是 `undefined`，`source` 只属于 `agent/session-start` —— **不要照抄该模式** | `dsh-agent/lib/types/runtime-types.d.ts:146-148` |

适配器的对应物：只注册 `agent/created`、`agent/status`、`agent/disposed` 三个监听器（都用 fire-and-forget
包装，异常各自消化、绝不冒泡到宿主事件循环）；每个监听器都按 `payload?.agent?.session?.header?.id`
做形状守卫，缺失即记一条日志后跳过。

### C. Agent API：`followup` / `steer` / `inject`

| 成员 | 签名 | 对循环的影响 | 引用 |
|---|---|---|---|
| `agent.id` | `SessionId` | 与 `agent.session.id` 同值 | `dsh-agent/lib/types/runtime-types.d.ts:60-133` |
| `agent.session` | `Session` | 持久日志 | 同上 |
| `agent.status` | `'idle' \| 'running'` | 镜像 `agent/status` | 同上 |
| `agent.whenIdle()` | `Promise<void>` | 整个 agent 静默（**不是**单个 follow-up） | `dsh-agent/lib/types/runtime-types.d.ts:87` |
| `agent.send(message, target, wakeup)` | `void` | 底层收件箱路由；`target: 'next-turn' \| 'next-step'` | `dsh-agent/lib/types/runtime-types.d.ts:109` |
| `agent.followup(message)` | `void` | **唤醒**：普通的下一个回合，且是它那个回合的**唯一**普通消息 | `dsh-agent/lib/types/runtime-types.d.ts:115` |
| `agent.steer(message)` | `void` | **唤醒**：最近的 step 边界；**空闲驱动会因此起一个回合** | `dsh-agent/lib/types/runtime-types.d.ts:123` |
| `agent.inject(message)` | `void` | **不唤醒**：仅下一步的模型可见上下文；空闲驱动会让它一直 pending，直到 follow-up 或 steering 唤醒 | `dsh-agent/lib/types/runtime-types.d.ts:132` |

唤醒位的**运行时证据**（三个方法只是 `send` 的薄封装）：

```js
send(message, target, wakeup) { …; if (wakeup) this.wakeDriver(wakingAfterAbort); }
followup(input) { this.send(input, "next-turn", true); }
steer(input)    { this.send(input, "next-step", true); }
inject(input)   { this.send(input, "next-step", false); }
```

引用：`dsh-agent-loop/lib/index.js:390-404`（`send` 的 `if (wakeup)` 在 `:394`）。

编译期证明同一结论的通道还有 `followup → send('next-turn', true)` **⇒ 取件必须唤醒 ⇒ 用 `followup`，
`inject` 只会把消息停在收件箱**。

### D. 会话身份：`SessionHeader` 与消息构造

`SessionHeader`（已深冻结）：

| 字段 | 类型 | 含义 | 引用 |
|---|---|---|---|
| `version` | `number` | 落盘格式版本（与 `SESSION_FORMAT_VERSION` 一致） | `dsh-session/lib/types/types.d.ts:40-46` |
| `id` | `SessionId` | 会话 id（与 `session.id` 同值） | `dsh-session/lib/types/types.d.ts:47-48` |
| `createdAt` | `number` | 创建时刻（Unix epoch ms） | `dsh-session/lib/types/types.d.ts:49-50` |
| `cwd?` | `string` | 会话创建时的**绝对**工作目录 | `dsh-session/lib/types/types.d.ts:51-52` |
| `parentSession?` | `SessionId` | 该会话 fork 自谁（**种子血缘**，不是运行时归属） | `dsh-session/lib/types/types.d.ts:53-54` |
| `origin?` | `'subagent'` | 「作为子代理创建」的粗粒度产品分类（呈现元数据，不证明可继续） | `dsh-session/lib/types/types.d.ts:60-64` |
| `delegationDepth?` | `number` | 委托深度：顶层缺席（=0），子代理为父深度 + 1；**持久化**，故重启/恢复后递归预算不丢 | `dsh-session/lib/types/types.d.ts:65-70` |
| `agentPreset?` | `string` | 组合该会话 agent 的 preset id（若按会话组合） | `dsh-session/lib/types/types.d.ts:71-77` |
| `seedLength?` | `number` | 经种子继承的前导事件数 | `dsh-session/lib/types/types.d.ts:55-59` |

适配器的对应物：会话节点名取 `header.cwd` 的目录名 + `header.id` 前 8 位；子代理判据取
`header.origin === 'subagent'`；父节点取 `header.parentSession` 已注册时的对应节点，否则回落实例节点
（根会话 / 顺序未定时的兜底）；`task_ref` 取 `header.id`（Hub 侧幂等稳定的关联键）。

**构造注入消息**：`createUserMessage` 来自 `@deepseek-ai/dsh-llm`，输入 `NewUserMessage`
（= `Omit<UserMessage,'id'|'role'>`，即**必填 `content: ContentBlock[]` 与 `source: MessageSource`**），
返回带新稳定 id 的**冻结** user 消息。

```js
import { createUserMessage } from '@deepseek-ai/dsh-llm'
agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'hub: ping' }],
  source: { kind: 'plugin', plugin: 'agentchat', form: 'relay' },
}))
```

| 事实 | 引用 |
|---|---|
| `createUserMessage` 签名（输入不得带 `id`/`role`） | `dsh-llm/lib/types/message.d.ts:166-174` |
| `NewUserMessage = Omit<UserMessage, 'id' \| 'role'>`；`content` 与 `source` 必填 | `dsh-llm/lib/types/message.d.ts:145-146,120-133` |
| `MessageSourceMap` 的 `plugin` 分支：`{ kind: 'plugin'; plugin: string } & ContextFormed`（另有 `user`/`model`/`tool`） | `dsh-llm/lib/types/message.d.ts:94-104` |
| `ContextForm` 词表：`'instructions' \| 'catalog' \| 'snapshot' \| 'notice' \| 'relay' \| 'recall'` | `dsh-llm/lib/types/message.d.ts:42-54` |
| `'relay'` 的文档语义：「**另一个 agent 发来的消息**」——正是 AgentChat 中继投递 | `dsh-llm/lib/types/message.d.ts:51-52` |
| `MessageSource` 可合并扩展（`switch on kind` 并对未知情形兜底） | `dsh-llm/lib/types/message.d.ts:117-118` |
| 文本内容块形状 `{ type: 'text', text }` | 随包示例插件 `hooks-claude-code` 的注入处 |

适配器取的来源字面量是 **`{kind:'plugin', plugin:'agentchat', form:'relay'}`**（`index.js` 的
`MESSAGE_SOURCE`）；`createUserMessage` 取不到时退化为同形状的最小 UserMessage。

### E. 工具入参为何不能改写（(b) 的根据）

```ts
type PreToolDecision = { kind:'allow' } | { kind:'deny'; reason:string } | { kind:'ask'; reason?:string }
```

| 事实 | 引用 |
|---|---|
| 决定类型**封闭**为 allow/deny/ask，JSDoc 明确 *「Input rewriting is excluded because arguments are already logged and presented」* | `dsh-tools/lib/types/index.d.ts:412-426` |
| `tools/execute` 的包装者**只能**改 `exec.signal` | `dsh-tools/lib/types/index.d.ts:39-49` |
| `ctx.tools.guard(fn)` 是**单调 deny-only** 的 `(exec) => string \| undefined` | `dsh-tools/lib/types/index.d.ts:481-488,612-622` |
| 实用替代：`tools/post-execute` 可 block 并给修正反馈、附加 `additionalContexts`，或替换结果投影；以 `ctx.tools.register(definition)` 注册**自己的原生工具** | `dsh-tools/lib/types/index.d.ts:427-445,603` |
| 只观察不改动用 `tools/result`（emit、已冻结） | `dsh-tools/lib/types/index.d.ts:83` |

适配器因此**没有**注册 `tools/pre-execute`；`mcp-bridge.mjs` 里保留的
「`tools/call` 入参剥离 `x-agentchat-session` → 转请求头」路径今天**没有注入方**。

### F. MCP 桥的运行环境事实

| 事实 | 引用 / 出处 |
|---|---|
| DSH 的 MCP 客户端只支持 `stdio`（spawn 本地进程）与 `streamable-http`；stdio 的 child env = **清洗过的父 env** + 配置里的显式 `env` | `@deepseek-ai/dsh-mcp-client/lib/index.js:27-49` |
| 清洗规则：名字匹配 **`/KEY\|PASSWORD\|SECRET\|TOKEN/i`** 的变量与**全部 `DSH_*`** 被删除（`PATH` 等保留；需要凭据就用配置里的显式 `env`） | `@deepseek-ai/dsh-subprocess/lib/index.js:12,31,46-48` |
| MCP 工具的模型可见名 = `mcp__<serverName>__<rawName>`（规范化到 DeepSeek 函数名约束） | `@deepseek-ai/dsh-mcp-client/lib/index.js:57-61,120` |
| MCP stdio 帧 = 换行分隔 JSON（`JSON.stringify(msg) + "\n"`，读侧按 `\n` 切） | `@modelcontextprotocol/sdk` 的 `stdio.ts`（`serializeMessage`） |

推论（适配器据此设计）：

1. `HUB_TOKEN` 常常**对桥不可见** → 桥必须自己读 `<AGENTCHAT_HOME>/hub_token`，且逐请求重读；
2. `serverName: agentchat` ⇒ 工具名 `mcp__agentchat__*`；
3. 桥的 **stdout 是传输通道**，诊断只能落文件。

### G. `plugin_manager` 是 Desktop 宿主工具

`plugin_manager`（`action: install_bundle`，`target` = 绝对包目录）**不在**本机 npm 安装的 `dsh` 里
（`@deepseek-ai/dsh-plugin-manager` 不存在，包内也无 `install_bundle` 字样）——它随 **DSH 桌面端宿主**发行，
契约以 Desktop 为准。因此：

- 安装器 `install.mjs` 的 CLI 路线是**可脚本化、可测试**的那条，也是本文推荐的默认路线；
- `install_bundle` 是 Desktop **官方支持**的替代路径，但它只装 bundle——MCP 行的绝对路径仍由
  `install.mjs` 写入（见「安装」小节）。

### 未验证项（诚实清单）

- **真机未验证**：DSH 桌面端实际加载本 bundle 后的事件触发顺序/时机、`followup` 是否在真实会话里
  唤醒驱动、桌面端 UI 上的观感。仓库自动化只覆盖到「真实 Hub + 假 DSH 宿主」。
- **未核实**：`DSH_PROFILE` / `DSH_PROFILE_DIR` 的确切设置者（npm 安装里找不到 `DSH_PROFILE` 字样，
  推断由 Desktop 启动器/其 host bundle 设置）——故只当作**环境提示**，不作为 API 依赖。
- **未核实**：`DSH_HOME` 之外，Desktop 宿主与 npm 安装的 `dsh` 在 bundle 解析/`install_bundle` 上是否
  完全一致。要在**实际加载插件的那个进程**里核对能力。
