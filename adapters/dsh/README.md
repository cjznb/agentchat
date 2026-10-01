# AgentChat · DSH 桌面端适配器

把 **DSH（DeepSeek Harness）桌面端**的每个会话接入 AgentChat Hub：会话作为节点出现在 roster，
回合始/末上报 `busy`/`idle`，**空闲时**取件并把其他 agent 的消息注入该会话，注入成功回执 `delivered`。

本适配器是 `adapters/opencode`（已被验证的进程外插件方案）的 DSH 版：同样是**原生宿主插件 + MCP 桥**，
只是宿主扩展点与安装方式换成 DSH 的 Cordis bundle / `@deepseek-ai/dsh-hooks-*` 之外的 Host 插件面。

## 架构

```
AgentChat Hub ──HTTP(/internal/*)+MCP──> adapters/dsh/index.js（Host 插件，进程内）
                    ▲                              │
                    │                    DSH 事件：agent/created ・ agent/status ・ agent/disposed
                    │                              ▼
                    └── mcp-bridge.mjs（stdio MCP）──> DSH agent 的 mcp__agentchat__* 工具
```

层级与 OpenCode 适配器一致：**实例节点（根容器）→ 会话节点（子）→ 子代理会话节点**。

| DSH 扩展点 | 适配器动作 |
|---|---|
| `agent/created` | 懒注册实例节点 `dsh@<host>`（`role_tag=container`，`join_token` 落盘 `<home>/agents/dsh.token`）；把该会话注册为实例节点的子节点（`task_ref=<session.header.id>`），报 `online` |
| `agent/status` = `running` | 会话节点报 `busy`，停空闲轮询 |
| `agent/status` = `idle` | 会话节点报 `idle` → `POST /internal/wake` 取件 → `agent.followup(消息)` → `POST /internal/result` 回执；启动空闲轮询（默认 10s） |
| `agent/disposed` | 只停本地跟踪，**不退役节点**（见下） |
| 插件卸载 | 停轮询；实例节点（根）报 `offline` |
| `mcp-bridge.mjs` | 把 Hub 的 `POST /mcp` 工具面暴露为 DSH 的 `mcp__agentchat__*` |

### 为什么用 `followup` 而不是 `inject`

核实自 DSH 运行时：`agent.followup(msg)` 开新回合并**唤醒**驱动；`agent.steer(msg)` 在最近的 step
边界交付并唤醒；`agent.inject(msg)` **不唤醒**（会一直躺在收件箱，直到别的输入到来）。
取件必须唤醒，故空闲用 `followup`，若注入时恰好 `running` 则改用 `steer`。
注入消息来源标为 `{kind:'plugin:agentchat', form:'relay'}`（DSH 语义：另一个 agent 发来的消息；v4 会拒绝已废弃的 `kind:'plugin'` 包装）。

### 为什么 `agent/disposed` 不退役节点

Hub 的 `registerChild` 按 `task_ref` **收养**既有节点（同一 `task_ref` 再次注册即认领），但**已退役节点
永久拒绝**同一 `task_ref` 的再注册（`RegistrationError("retired")`）。DSH 的 `agent/disposed` 表示
「agent 离开注册表」——关闭、切走、乃至之后还会被重新打开的会话都会触发，而 DSH 没有「会话被删除」事件。
在这里退役会让用户重开同一会话后**永远无法再注册**。故适配器只停跟踪；失联节点由 Hub 的 `last_seen`
阈值自然判 `offline`。`/internal/retire` 仍保留在 `lib/hub.js`，供将来有明确删除事件时使用。

## 安装

前置：Hub 已启动（`npm start`，默认 `http://127.0.0.1:4646`），本机有 Node ≥ 22，DSH 桌面端已装。

```powershell
# 1) 安装（幂等；--dry-run 只打印；--uninstall 精确移除）
node adapters/dsh/install.mjs --profile desktop

# 2) 重启 DSH 桌面端（bundle 选择在下次组合时生效）

# 3) 验证节点出现
curl http://127.0.0.1:4646/api/roster
```

`install.mjs` 做四件事（都可 `--dry-run` 预览、`--uninstall` 精确回退）：

1. 在 `<DSH_HOME>/profiles/node_modules/@agentchat/dsh-adapter` 建指向本目录的目录联接（junction），
   使 profile 能解析到本 bundle；
2. 在 `<DSH_HOME>/profiles/<profile>/package.json` 里登记依赖并把 `@agentchat/dsh-adapter`
   追加进 `dsh.profile.bundles`（bundle 只有被选中，其 patch 才会组合）；
3. 在 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 追加**受管块**，插入 Hub 的 MCP 工具行
   （`@deepseek-ai/dsh-mcp-client` + 本目录 `mcp-bridge.mjs` 的绝对路径 + `process.execPath`）；
4. 把厂商 `dsh` 写进 `<AGENTCHAT_HOME>/config.json` 的 `adapters`（可选但显式；Hub 也会在首次
   `/internal/wake` 时自动把未知厂商登记为 pull 适配器）。

> **Desktop 原生替代路径**：也可以让你的 DSH agent 执行 `plugin_manager` 的
> `action: install_bundle`、`target` = 本目录绝对路径（这是 Desktop 推荐的安装方式，需要批准）。
> 注意它只装 bundle；MCP 工具行的绝对路径仍要由 `install.mjs` 写入。

## 配置

bundle 行 `config`（写进 `cordis.patch.yml`）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `pollMs` | `AGENTCHAT_POLL_MS` → `10000` | 空闲轮询间隔（毫秒）；消息在「已经 idle 之后」到达时靠它补拉 |
| `name` | `dsh@<host>` | 实例节点可读名；同一台机器跑多个不同 `AGENTCHAT_HOME` 的实例时用它避重名（`agents.name` 有唯一索引） |
| `titleAsName` | `true` | 把 **DSH 会话标题**写进 Hub **展示名**（`custom_name`）；设 `false` 则始终显示机器唯一名 |

**节点名与展示名（两件事）**：`agents.name` 是机器唯一名（`<目录名>-<会话 id 短标识>`，保证唯一与 `task_ref` 收养稳定），
Hub 里**显示**的是 `COALESCE(custom_name, name)`。适配器默认为每个会话把 DSH 标题
（`ctx.sessionTitle.get(session)`，即你在 DSH 里看到的那句，如"为 agentchat 编写 DSH 适配器"）写进 `custom_name`，
于是 Hub 里一眼可认；标题是首轮之后才生成的，适配器订阅 `session/title` 修订并跟着更新。
展示名有唯一索引：撞名（409）时退化为「标题 · 会话短标识」只重试一次；`sessionTitle` 服务缺失则保持机器唯一名。

环境变量（与其它适配器一致）：`AGENTCHAT_URL` / `AGENTCHAT_PORT`（默认 `127.0.0.1:4646`）、
`HUB_TOKEN`（缺省回退 `<AGENTCHAT_HOME>/hub_token`）、`AGENTCHAT_HOME`（默认 `~/.agentchat`）、
`AGENTCHAT_POLL_MS`、`AGENTCHAT_TIMEOUT_MS`（HTTP 超时，默认 3000ms）。

## 已知限制：MCP 出站身份只能「单会话精确，多会话退回容器」

Hub 的 `send`/`ask` 等工具按调用方身份记账（MCP `initialize` 的 `x-agent-id`，或逐请求的
`x-agentchat-session` 头）。**Hub 只在创建 MCP 会话时读一次 `x-agent-id`**（`server/routes/mcp.ts`
的 `initializeContext`），此后只接受逐请求的 `x-agentchat-session` 重解析；而 DSH 的
`tools/pre-execute` 决定类型只有 allow/deny/ask，官方 JSDoc 明确 "Input rewriting is excluded"，
**无法**像 OpenCode 适配器那样把会话 id 注入工具入参。

本适配器因此用**磁盘会话提示**替代入参注入：

- 插件维护 `<AGENTCHAT_HOME>/agents/dsh.current`：当**恰好一个顶层会话节点**（实例节点的直接子节点，
  子代理不算）存在时写它的 Hub 节点 id；0 个或 ≥2 个顶层会话时**删除该文件**。
- `mcp-bridge.mjs` 逐请求把 `x-agent-id` 解析为 `dsh.current`（有则用）→ 否则 `agents/dsh.id`（实例容器）。
  解析值一旦**变化**，桥就丢弃缓存的 Hub 会话、下一次请求重新 `initialize` 并带上新头
  （Hub 只在 `initialize` 认身份，这是身份能改变的唯一途径）；Hub 报 `400 agent_not_found`
  （例如 Hub 换库）时同样清缓存并**只重试一次**。

> ⚠️ **为什么"多会话时不给身份"而不是"猜一个"（fail-closed，安全级）**
> 曾经的版本在 ≥2 个顶层会话时取"**最近进入 `running`**"的那个——那是跨会话的 last-writer-wins
> 全局指针，等于把"谁的回合最后开始"当成"谁在说话"。真机已发生**身份冒用**：同机两个 DSH 会话并跑时，
> 成员A 发出的消息被 Hub 记成成员B（归属、回执、**ask 授权判定**全部跟着错，审计被污染）。
> 因此现在**只在能唯一确定时给身份**：多会话并存 → 无身份 → 桥回落实例容器 → Hub 对以容器为收件方的
> DM 回 `container_not_chat_target`（**显式失败**）。宁可报错，绝不静默冒名。
> 并发多会话下要精确归属，唯一正解是宿主原生工具面（`ctx.tools.register`），见下方「已知限制」末段。

由此得到的行为：

| 场景 | 出站记账 | 对端能否回复本 DSH 会话 |
|---|---|---|
| **只有一个**会话在跑（桌面端最常见） | 该**会话节点** | ✅ 可以：回复落到会话节点，插件会唤醒它并注入 |
| 0 个或 ≥2 个上层会话并存 | **实例容器节点**（`dsh@<host>`） | ❌ 不能：Hub 拒绝「以分组容器为收件方」的 DM（`container_not_chat_target`），对端会拿到明确错误而不是静默失败 |

**收件（唤醒/注入）始终按会话节点进行，与上表无关**；受限的只是「由本 DSH 会话发起的 MCP 出站记账」。
彻底修法是在本插件里用 `ctx.tools.register()` 以原生工具（而非 MCP 桥）代理 Hub 工具面：原生工具能拿到
调用它的 agent 上下文，即可按会话精确归属，且天然支持多会话并发。本版本为对齐已验证的 OpenCode 结构
（原生插件 + MCP 桥）保留桥方案，并在 `mcp-bridge.mjs` 里保留了 `x-agentchat-session` 头/入参剥离逻辑，
待原生工具面落地后直接复用。

## 验证清单（真机手动）

1. 启动 Hub 与 DSH 桌面端 → `curl http://127.0.0.1:4646/api/roster` 能看到
   `dsh@<host>`（容器，子节点为空）+ 打开过的会话节点（`vendor=dsh`，名字形如 `<目录名>-<id8>`）。
2. 从另一个节点向该会话节点发消息（UI 或 MCP `send`）。
3. 该会话**空闲**时：消息被注入，模型看到 `[AgentChat] 你收到了以下来自其他 agent 的消息…`；
   Hub 侧该消息回执变为 `delivered`（见 `GET /api/ui/...` 或消息回执）。
4. 会话正在跑回合时发消息：下一次 step 边界即被 `steer` 注入。
5. 关闭该会话（DSH 里切走/关标签）后再打开：节点被**重新认领**（同一 `task_ref`，不新建节点、不报错）。
6. 退出 DSH：容器节点在 `last_seen` 阈值后变 `offline`；会话节点同样自然 offline（不退役）。

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| roster 里没有 `dsh@<host>` | 看 `<AGENTCHAT_HOME>/logs/dsh-adapter.log`：多为 `HUB_TOKEN` 未解析到（401）。启动 Hub 会写出 `<home>/hub_token`；也可显式设 `HUB_TOKEN`。 |
| 节点出现但从不收消息 | 该节点没进过 idle，或其 `vendor` 未被 Hub 登记为 pull 适配器。日志里应有 `wake` 相关错误；确认 `/internal/wake` 未被 401 拦截。 |
| 消息被注入但模型看不到 | 检查是否只写进了收件箱而未唤醒：本适配器用 `followup`（会唤醒），`inject` 不会。 |
| 注册报 `name` 唯一冲突 | 同一目录多开会导致同名，本适配器已带会话 id 短后缀；若仍冲突，改 `config.name`（实例）或检查是否有别的适配器占用了同名。 |
| 日志出现 `RegistrationError("retired")` | 该 `task_ref` 的节点曾被退役（例如旧版本适配器或手工 retire）。Hub 侧无法复活，需删除该节点或换 `task_ref`。 |
| MCP 工具 `mcp__agentchat__*` 不存在 | MCP 行没写进 profile 的 `cordis.patch.yml`（重跑 `install.mjs`），或 `mcp-bridge.mjs` 路径失效（移动过仓库 → 重跑安装器），或 DSH 未重启。 |
| 改了适配器代码不生效 | Host 插件是进程内加载：重启 DSH 桌面端；替换已安装包需要重启才能加载新的模块代。 |

日志：`<AGENTCHAT_HOME>/logs/dsh-adapter.log`（1 MiB 轮转为 `.1`；`AGENTCHAT_LOG=console` 可打到 stderr，
MCP 桥诊断同文件，绝不写 stdout——stdout 是 MCP 传输）。

## 与其它适配器的差异

| | `adapters/opencode` | `adapters/dsh` |
|---|---|---|
| 宿主扩展点 | OpenCode 插件 API（`session.*` 事件） | DSH Cordis Host 插件（`agent/*` 事件） |
| 打包 | TS 插件包（宿主自解析 TS） | **bundle**（`dsh.bundle.patch` → `cordis.patch.yml`，纯 ESM JS，无构建步骤） |
| 安装 | 写 OpenCode 配置 | profile 依赖 + bundle 选择 + 用户 patch 层（MCP 行） |
| 空闲注入 | `client.session.promptAsync` | `agent.followup`（空闲）/ `agent.steer`（运行中） |
| 逐会话出站身份 | 工具入参注入 → 桥转头 | **无入参注入可用**（DSH 禁止改写工具入参）→ 磁盘会话提示：单会话精确、多会话退回容器，见「已知限制」 |
| 子节点退役 | `session.deleted` → retire | 无删除事件 → 不退役，靠 `last_seen` 自然 offline |

## 尚未在本机自动验证的部分

本仓库的自动化测试只覆盖到「真实 Hub + 假 DSH 宿主」（见 `tests/integration/dsh-plugin.test.ts`、
`adapters/dsh/__tests__/*`）。**真机项**必须由人跑：DSH 桌面端加载 bundle 后的事件触发、
`followup` 是否真的唤醒会话、桌面端 UI 上的实际观感。安装器与插件都不改动 DSH 自带文件，
`--uninstall` 可精确回退。
