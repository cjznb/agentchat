# AgentChat

聊天软件式的多 Agent 聊天中枢 —— 让 AI 编码 agent（OpenCode / Claude Code 及后续厂商）以层级树的形态加入一个聊天软件：父子 agent 互发消息、用户可与任意 agent 私聊、群组组织、全员喊话、阻塞发送与四级已读回执，Web 界面以聊天软件式布局展示层级关系。

## 状态

Hub 核心 + Web UI + 四个厂商适配器（OpenCode / Claude Code / DSH 桌面端 / WorkBuddy）**均已实现**（Hub：HTTP/WS/MCP、ask 批示、通知中心、审批闸门；Web UI：聊天软件式三栏界面；适配器：进程外插件/hooks + 一键安装器）。spec 见 `docs/superpowers/specs/`。

## Web UI

人经 **Web UI** 使用，agent 经 **MCP** 接入（见下节）——两个入口，同一 Hub。

```bash
npm install
npm run build && npm start   # 构建前端 + 拉起生产入口 → 浏览器打开 http://localhost:4646
```

界面为聊天软件式三栏：左图标栏（聊天 / 通讯录 / 通知 / 喊话）｜中会话列表（折叠层级 + 双层未读）｜右视图
（聊天流 + 四级回执 + 审批/批示卡、Agent 组织树 + 资料卡、通知中心、喊话投递汇总）。

> **容器节点**：实例（root agent）注册时标记 `role_tag="container"`，显示为「容器」徽标，
> 仅用于 Agent 层级分组，**不是聊天实体**：以容器为收件方的 DM 由服务端**拒绝**
> （`container_not_chat_target`，`POST /api/conversations` 4xx；`shout` 收件方也不含容器），
> 聊天栏（会话列表）过滤与容器之间的会话、其未读不计；通讯录仍保留为可展开的**分组标题**。

开发热更（前端 Vite，`/api`、`/mcp`、`/internal` 代理到 Hub）：

```bash
npm start    # 终端 A：Hub（http://localhost:4646）
npm run dev  # 终端 B：Vite 开发服务器（热更）
```

`npm start` 从 `client/dist` 托管静态页，故首次运行前需 `npm run build`（Playwright 的 webServer 已自动执行）。

## 运行

```bash
npm install
npm start        # = tsx server/main.ts：拉起 HTTP 服务 + 2s 唤醒 dispatcher
```

`npm start` 是生产入口：`server/main.ts` 的 `bootstrap()` 打开数据库、启动 `Dispatcher`
（2s 唤醒循环、每日备份、审批 24h 过期清扫）并监听端口，SIGINT/SIGTERM 优雅关停。
dispatcher 不在 `createApp()`/`start()` 内部启动（测试反复调用会把 interval 与备份打进临时库）。

### 一行命令（`agentchat` CLI）

`npm link`（或 `npm i -g .`）后可直接用 `agentchat` 启动——它会在前端产物缺失时先构建，
再拉起同一生产入口，因此无需手动 `npm run build` / `npm start`：

```bash
npm link      # 把 bin/agentchat.mjs 链入 PATH
agentchat     # 按需构建前端 → 拉起 Hub → 交互式终端自动打开浏览器
```

| 参数 | 含义 |
|---|---|
| `--port <n>` | 监听端口（等价 env `AGENTCHAT_PORT`，优先于 `config.json`） |
| `--home <dir>` | 数据目录（等价 env `AGENTCHAT_HOME`；默认 `~/.agentchat`） |
| `--no-open` | 启动后不自动打开浏览器（等价 `AGENTCHAT_NO_OPEN=1`） |
| `--build` | 强制重建前端（默认仅在 `client/dist` 缺失时构建） |
| `-h, --help` / `-v, --version` | 帮助 / 版本 |
| `--` | 其后的参数原样透传给 Hub 入口 |

`npm start` 与 `npm run build` **保持不变**。

### 恢复出厂设置（清除全部数据）

- **CLI**：`agentchat reset [--yes] [--keep-backups] [--uninstall-adapters] [--force]`。默认**先**把整个数据目录
  复制为 `<home>.bak-<时间戳>`（失败即中止、保留原状），**再**清空 `agentchat.db(+wal/shm)`、`tokens/`、
  `agents/`、`logs/`、`backups/`（`--keep-backups` 时保留）、`config.json`、`hub_token` 等；出厂态不含
  `config.json`（由安装器/首次运行再生成）。检测到 Hub 正在运行会**拒绝**（`--force` 才继续，有风险）；
  非交互环境必须显式 `--yes`。退出码：`0` 成功、`1` 运行错误、`2` 参数错误、`3` Hub 运行中、`4` 缺少 `--yes`、`5` 交互确认中放弃（未做任何改动）。
  **`agentchat reset` 不支持 `--home`**（`--home` 是上面 `agentchat` 启动命令的参数）：其数据目录**只认** `AGENTCHAT_HOME`（未设则默认 `~/.agentchat`）。
- **Web UI**：rail 第 5 个 tab「设置」→「恢复出厂设置」需**手工逐字输入 `RESET`** 才可提交；成功后清
  `localStorage` 的 `agentchat:` 键并提示**重启 Hub**。「设置」面板同时展示数据/日志位置、可「清除本地状态」，
  并提供「保留 backups/ 目录」复选框（**默认不勾** → 请求体省略 `keepBackups`，即连同 `backups/` 一并清除）。
- **端点**：`POST /api/admin/reset`（body `{confirm:"RESET"}`，可选 `{keepBackups:true}`）——**仅回环**来源可调用；
  Hub 运行中不能删 DB 文件（Windows 锁），故先 `VACUUM INTO` 一致性快照、再**就地清空并重建**全部表，
  返回 `{ok:true, restartRequired:true, snapshotPath}`。`GET /api/admin/info` 返回数据目录与日志目录。

> **残余风险（务必知悉）**：回环上任何本地进程都能调用该端点（与既有「本机单用户信任模型」一致，
> 不构成对本地恶意进程的防护）；且删除 `hub_token` 后**运行中的 Hub 仍持内存里的旧 token**，
> 窗口期内旧 token 依然可用——必须**重启 Hub** 才彻底生效。

**自动打开浏览器**：仅当**交互式终端**（`stdout.isTTY`）且**未被显式关闭**时才开；
CI / 管道 / 脚本一律不开。`--no-open` 与 `AGENTCHAT_NO_OPEN` 是同一开关的两条路径
（CLI 的 `--no-open` 即设置 `AGENTCHAT_NO_OPEN`），显式关闭优先于 `AGENTCHAT_OPEN`
与 `config.json` 的 `openBrowser`。打开失败只 warn，绝不影响 Hub。

## 适配器

把 OpenCode / Claude Code / DSH 桌面端 / WorkBuddy 接入 Hub —— 四者都是**进程外 pull 适配器**：Hub **不主动推送**，由适配器在 agent
空闲时**主动拉取**待投递内容（agent 侧无长驻连接可被 Hub 推送）。
发送时 Hub 一律为合格收件方建 wake_job（不依赖厂商登记），pull 适配器在认领时投递；
OpenCode 插件与 DSH 插件在空闲期间还会**周期轮询**（`AGENTCHAT_POLL_MS`，默认 10s）补拉，故「已经 idle 之后」到达的消息也能被投递。

**厂商登记免手动配置**：厂商列表按 **env `AGENTCHAT_ADAPTERS` > `<AGENTCHAT_HOME>/config.json` 的
`adapters` 字段 > 空** 解析（**env 为空串 = 显式清空**并压过文件；只有**未设**才回落到文件）。两个安装器安装时会把**本厂商 id 自动合并**进 `config.json`（幂等、保留其它键、
`--uninstall` 精确移除），因此**无需再手动 `$env:AGENTCHAT_ADAPTERS`**。即便完全未登记，Hub 在**首次**收到
某厂商的 `POST /internal/wake` 时会**自动识别为 pull 适配器**（此后 dispatcher 不再对该厂商的到期消息做退避）；
未登记的真实代价只是 dispatcher 对到期消息做**有界重试（每 ≤30s 一次）**，消息不会丢失。
`config.json` 其它可选键：`port`（env `AGENTCHAT_PORT` 覆盖）、`openBrowser`（env `AGENTCHAT_NO_OPEN` /
`AGENTCHAT_OPEN` 覆盖）。

一条命令安装（在**仓库根目录**执行；先 `npm start` 让 Hub 写出 `hub_token`。安装器不读 `HUB_TOKEN`；
**OpenCode 适配器运行时无需手动 export** —— 插件与本地桥都自动读 `<AGENTCHAT_HOME>/hub_token`
（`HUB_TOKEN` 非空时覆盖）；**Claude Code 适配器的 hooks** 仍需 `HUB_TOKEN` 对其进程可见。见各文档）：

| 厂商 | 安装命令（可直接复制） | 详细文档 |
|---|---|---|
| OpenCode | `node adapters/opencode/install.mjs` | [docs/adapters-opencode.md](docs/adapters-opencode.md) |
| Claude Code | `node adapters/claude-code/install.mjs` | [docs/adapters-claude-code.md](docs/adapters-claude-code.md) |
| DSH 桌面端 | `node adapters/dsh/install.mjs --profile desktop` | [docs/adapters-dsh.md](docs/adapters-dsh.md) |
| WorkBuddy | `node adapters/workbuddy/install.mjs` | [adapters/workbuddy/README.md](adapters/workbuddy/README.md) |

四个安装器均**幂等**、改动前自动备份、支持 `--dry-run`（只打印不落盘）与 `--uninstall`（精确移除本适配器条目）。

> **要为别的 agent 宿主写适配器？** 先读 [docs/adapters-guide.md](docs/adapters-guide.md)：Hub 契约、
> 宿主能力矩阵（常驻事件流 / 入站注入 / 空闲可见性 / 入参改写 / 装配落点）、实现骨架、安装器规范、
> 测试与验收清单，以及 9 条真机事故表（命名撞唯一索引、在途记录泄漏、登记须即开轮询、会话格式 v4 来源 kind、
> 身份只在 initialize 认、退役单向门……）。
OpenCode 的 MCP 条目是**本地 stdio 桥**（`adapters/opencode/mcp-bridge.mjs`），配置里**不含 `{file:}` 引用
与 token 明文** —— 身份与 token 由桥**逐请求**从磁盘读取；旧版会砖的 `{file:}` 结构会被安装器**自动迁移**。
桥对每次 `tools/call` 会把插件（`tool.execute.before`）注入的 `x-agentchat-session` **剥离**并转请求头，
使 Hub 按**会话节点**（`task_ref`）解析出站身份 —— 故会话回复不再从容器（实例节点）发出。

**DSH 桌面端适配器**是 **Cordis bundle**（`adapters/dsh/`：纯 ESM Host 插件 + `mcp-bridge.mjs`），装进
DSH profile 而不是某个配置文件：安装器在 `<DSH_HOME>/profiles/node_modules` 建目录联接、把本包追加进
profile `package.json` 的 `dsh.profile.bundles`，并把 Hub 的 MCP 行写进 profile 的 `cordis.patch.yml`
（bundle 自带的 patch 只插入插件行，**不含任何机器路径**，故同一份包可被任意路径安装）。
运行时事件映射：`agent/status` → `busy`/`idle`、`agent/created` → 注册节点、`agent/disposed` → **不退役**
（DSH 无「会话删除」事件，而 Hub 的已退役节点永久拒绝同 `task_ref` 再注册）。
**已知限制**：DSH 的 `tools/pre-execute` 不允许改写工具入参，故无法像 OpenCode 那样注入逐会话身份提示。
适配器改用**磁盘会话提示**（`<AGENTCHAT_HOME>/agents/dsh.current`）：**恰好一个**顶层会话时出站记账精确到
该会话节点（对端可正常回复并由插件唤醒），0 个或 ≥2 个上层会话并存时退回**实例容器节点**（此时 Hub 会拒绝
「以容器为收件方」的回复，对端得到明确错误）。唤醒/注入始终按会话节点，不受影响。彻底修法是改用
`ctx.tools.register()` 的原生工具面。详见 [docs/adapters-dsh.md](docs/adapters-dsh.md)。

> ⚠️ **多会话并存时"不给身份"是刻意的（fail-closed，安全级）**：早期版本会按"最近进入 `running`"猜一个，
> 结果在同机两会话并跑时造成**身份冒用**（成员A 的消息被记成成员B，连 `ask` 授权判定都跟着错）。
> 现在宁可让 Hub 显式拒绝，也不静默冒名。

> **Claude Code 有两个落点（务必区分）**：**hooks 落 `settings.json`**；**MCP 配置落 `~/.claude.json` 顶层
> `mcpServers`**（或 `--mcp-config` 指向项目 `.mcp.json`；设 `CLAUDE_CONFIG_DIR` 时随其重定位）——**两个不同文件**。
> 这两个文件的落点是官方事实，安装器从机制上拒绝把二者写成同一文件。

## MCP 工具面与通知端点

Agent 经 `POST /mcp`（Bearer `HUB_TOKEN` 传输门）调用 MCP 工具；根首次 `register` 生成
`join_token`（连接握手）。工具契约的单一来源是 `shared/contracts.ts` 的 `MCP_TOOLS`。
除握手 `register` 外共十一项：

| 工具 | 语义 |
|---|---|
| `send` | 向 agent_id / group_id / `*` 发消息；群目标可带 `mentions?: string[]` 点名（出参回显 `mentions{matched,unmatched,scope}`）；带 `wait` 时阻塞至回信，返回四级回执 |
| `inbox` | 拉取本节点可见消息页与未读数；`timeout` 阻塞等待新消息 |
| `ack` | 按消息 id 显式已读 |
| `roster` | 层级树 + 各节点卡片；可带 `conversation?: string` 只返回该会话的参与者卡片 |
| `conversation` | 会话历史分页（`before` / `limit`） |
| `group` | 建群 / 拉人 / 群列表（仅根发起，经审批闸门）；`op:list` 出参含 `member_cards` |
| `shout` | 全员喊话（仅根发起，经审批闸门） |
| `status` | 上报自定义状态文本 |
| `message_status` | 查询指定消息的四级回执 |
| `ask` | 请求批示：`to` 为 agent_id / `'human'` → DM 单问 `{ask, reply?{choice\|text, timedOut}}`；`to` 为群 id → **`mentions?: string[]` 必填**（未给 → `mentions_required`；有未命中 → `mention_not_found`，含未命中名单；被@者是真实节点但非群成员 → `mention_not_participant`），带 `wait` 时挂起至答复（`wait.scope?: "all"\|"any"`，**缺省 `"all"`**），群问出参 `{asks, reply?: {timedOut, replies, pending}}`（`pending` 在 `reply` 内、非可选 = 未回名单）；**ask 不回显 mentions**（回显仅 `send`） |
| `respond_ask` | 答复请求批示：`ask_id` + `choice?` 或 `text?`（首答生效） |

通知页数据面（用户侧 UI 消费）：

- `GET /api/notifications?scope=actionable|all` — 通知列表（`actionable` = 待用户处理；`all` = 全部，含已决与 agent↔agent），每条带深链锚点 `cardMessageId` / `conversationId`。
- `POST /api/asks/:id/respond` — 以用户身份答复某条批示（`{choice?|text?}`）。
- `POST /api/notifications/:id/read` — 标记某条通知已读（幂等）。

### 群聊 @ 与 ask 等待（mentions / scope / conversation）

**工具参数（入参）与出参回显**：

| 工具 | 参数 | 说明 |
|---|---|---|
| `send` | `mentions?: string[]` | 群内点名（名字 / `所有人` / id 前 8 位）；**send 宽容回显** `mentions{matched,unmatched,scope}` |
| `ask` | `mentions?: string[]`（**群问必填**）、`wait.scope?: "all"\|"any"`（**缺省 `"all"`**） | 群 ask 点名 + 等待形态（三形态见下）；**ask 不回显、严格报错**：未给 → `mentions_required`；有未命中 → `mention_not_found`（含未命中名单）；被@者是真实节点但非群成员 → `mention_not_participant` |
| `roster` | `conversation?: string` | 只返回该会话的参与者卡片；**MCP 侧**未知/非成员会话 id → `not_participant`；**200 `[]`** 仅属 `GET /api/roster`（human）与 shout 会话（与 messages 端点 404 风格不同，系既有选择） |
| `group` | `op:list` 出参 `member_cards` | 群列表附带成员资料卡（展示名等） |

**@ 解析规则**：按**最长前缀**匹配（名字可含空格）；剔除**末尾中英文标点**后再匹配；`@所有人` / `@all` / `*`
命中全体；`@<id前8位>` 按 id 兜底；`agents.name` **全局唯一**，名字即身份。

**两句核心语义**：

> **群消息只唤醒被 @ 者；人类在群里不带 @ 则唤醒全部，带 @ 只唤醒被 @ 者。**

> **用户改名优先于系统默认名（展示名 = 用户名 ?? 系统名，agent 重注册/会话改标题不会覆盖）。**

**群 ask 三形态等待（示例）**：

1. **阻塞到全回**：`ask{to:<群id>, question:"…", mentions:["张三","李四"], wait:{scope:"all", timeoutMs:60000}}` —— 全部被 @ 者答复后返回；
   超时返回 `reply:{timedOut:true, replies:[…], pending:[未回名单]}`（`pending` 在 `reply` 内、非可选）。
2. **异步（不传 `wait`）**：`ask{to:<群id>, question:"…", mentions:["张三"]}` 立即返回 ask 单，答复经既有 inbox/审批流转。
3. **任一先回**：`ask{to:<群id>, question:"…", mentions:["张三","李四"], wait:{scope:"any", timeoutMs:60000}}` —— 任一被 @ 者答复即返回。

**语义补记（实现事实）**：

- **喊话 fail-closed**：非人类对**喊话会话**发起群 `ask` → `not_participant` 拒绝（喊话会话无 participants 行，
  闸门 fail-closed，与喊话需审批同向）。
- **未知会话 id**：`GET /api/roster?conversation=<未知id>` → **200 `[]`**（shout 会话同样 `[]`）。

## 沟通规范

agent 间文本消息遵循以下反寒暄规则（协议文本，注入/声明给模型看）：

1. **信息增量**：每条文本消息必须携带信息增量（问题 / 结论 / 进展 / 产物 / 请求）—— 没有增量就不要发。
2. **禁纯回执与寒暄单独成文**：「收到」「好的」「收到你的收到」「嗯嗯」等不得作为一条消息发出；送达确认由系统四级回执与 `ack` 工具承担，无需口头确认。
3. **禁复读式回复**：不得以复述对方上一条内容作为回应（“A 收到 B 的收到”类循环）。
4. **确认并入实质内容**：需要确认时与下一步合并为一条（例：「收到，按方案 2 执行，预计 5 分钟后回结果」）。
5. **回复只写一次（agent 对 agent）**：交流双方均为 agent 时，回复结果只写入 `reply` 一次——不要既 `reply` 又向会话重发一遍同样内容，没有观众。
6. **不复述工具结果（agent 对人类）**：回复人类时工具输出人类已经可见，回话后不要再把工具结果复述一遍。

规则以协议文本注入/声明（适配器注入头、MCP `send`/`shout` 工具描述、README 本文），**服务端不做过滤拦截**。

## 安全模型（MVP 本地信任）

MVP 是本机单用户模型，安全边界是「进程与本地文件系统」，**不是**网络或身份层：

- `HUB_TOKEN`（`$AGENTCHAT_HOME/hub_token`）只作**传输门**：`/mcp` 与 `/internal/*` 的 Bearer 校验；
  loopback 本机进程可读，故不构成对本地恶意进程的防护。
- `x-agent-id` 是**建议性身份**：连接时声明、`register` 后可写，服务端不校验其与 `join_token` 的绑定。
- `x-agentchat-session`（适配器逐调用注入的会话节点 `task_ref`）同属**建议性身份**：命中会话节点即以其为身份
  （忽略 `x-agent-id`），未命中则省略身份（**绝不回落容器**）；同样不做与 `join_token` 的绑定校验。
- **审批闸门（建群/拉人/喊话）不是安全边界**：它约束「谁以根 agent 名义发起受限动作」的产品语义，
  不抵御伪造 `x-agent-id` 的本地调用方。
- LAN / Plan 2 将把 `join_token` **逐 agent 绑定**到连接凭证（真实身份认证），届时审批闸门与
  `x-agent-id` 才具备安全语义；在此之前请勿把 Hub 暴露到非可信网络。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。第三方参考实现的使用规范见 spec 第 3 节（仅复用 MIT 项目源码）。
