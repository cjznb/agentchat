# AgentChat

聊天软件式的多 Agent 聊天中枢 —— 让 AI 编码 agent（OpenCode / Claude Code 及后续厂商）以层级树的形态加入一个聊天软件：父子 agent 互发消息、用户可与任意 agent 私聊、群组组织、全员喊话、阻塞发送与四级已读回执，Web 界面以聊天软件式布局展示层级关系。

## 状态

Hub 核心 + Web UI + 两个厂商适配器（OpenCode / Claude Code）**均已实现**（Hub：HTTP/WS/MCP、ask 批示、通知中心、审批闸门；Web UI：聊天软件式三栏界面；适配器：进程外插件/hooks + 一键安装器）。spec 见 `docs/superpowers/specs/`。

## Web UI

人经 **Web UI** 使用，agent 经 **MCP** 接入（见下节）——两个入口，同一 Hub。

```bash
npm install
npm run build && npm start   # 构建前端 + 拉起生产入口 → 浏览器打开 http://localhost:4646
```

界面为聊天软件式三栏：左图标栏（聊天 / 通讯录 / 通知 / 喊话）｜中会话列表（折叠层级 + 双层未读）｜右视图
（聊天流 + 四级回执 + 审批/批示卡、Agent 组织树 + 资料卡、通知中心、喊话投递汇总）。

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

## 适配器

把 OpenCode / Claude Code 接入 Hub —— 两者都是**进程外 pull 适配器**：Hub **不主动推送**，由适配器在 agent
空闲时**主动拉取**待投递内容（agent 侧无长驻连接可被 Hub 推送）。Hub 侧登记的厂商列表由 `AGENTCHAT_ADAPTERS`
控制（逗号分隔，**启动 Hub 时请显式登记**，如 `AGENTCHAT_ADAPTERS=opencode,claude-code npm start`；空/未设 = 不登记）。
发送时 Hub 一律为合格收件方建 wake_job（不再依赖厂商登记），pull 适配器在认领时投递；
OpenCode 插件在空闲期间还会**周期轮询**（`AGENTCHAT_POLL_MS`，默认 10s）补拉，故「已经 idle 之后」到达的消息也能被投递。

一条命令安装（在**仓库根目录**执行；先 `npm start` 让 Hub 写出 `hub_token`。安装器不读 `HUB_TOKEN`；
**OpenCode 适配器运行时无需手动 export** —— 插件与本地桥都自动读 `<AGENTCHAT_HOME>/hub_token`
（`HUB_TOKEN` 非空时覆盖）；**Claude Code 适配器的 hooks** 仍需 `HUB_TOKEN` 对其进程可见。见各文档）：

| 厂商 | 安装命令（可直接复制） | 详细文档 |
|---|---|---|
| OpenCode | `node adapters/opencode/install.mjs` | [docs/adapters-opencode.md](docs/adapters-opencode.md) |
| Claude Code | `node adapters/claude-code/install.mjs` | [docs/adapters-claude-code.md](docs/adapters-claude-code.md) |

两安装器均**幂等**、改动前自动备份、支持 `--dry-run`（只打印不落盘）与 `--uninstall`（精确移除本适配器条目）。
OpenCode 的 MCP 条目是**本地 stdio 桥**（`adapters/opencode/mcp-bridge.mjs`），配置里**不含 `{file:}` 引用
与 token 明文** —— 身份与 token 由桥**逐请求**从磁盘读取；旧版会砖的 `{file:}` 结构会被安装器**自动迁移**。

> **Claude Code 有两个落点（务必区分）**：**hooks 落 `settings.json`**；**MCP 配置落 `~/.claude.json` 顶层
> `mcpServers`**（或 `--mcp-config` 指向项目 `.mcp.json`；设 `CLAUDE_CONFIG_DIR` 时随其重定位）——**两个不同文件**。
> 这两个文件的落点是官方事实，安装器从机制上拒绝把二者写成同一文件。

## MCP 工具面与通知端点

Agent 经 `POST /mcp`（Bearer `HUB_TOKEN` 传输门）调用 MCP 工具；根首次 `register` 生成
`join_token`（连接握手）。工具契约的单一来源是 `shared/contracts.ts` 的 `MCP_TOOLS`。
除握手 `register` 外共十一项：

| 工具 | 语义 |
|---|---|
| `send` | 向 agent_id / group_id / `*` 发消息；带 `wait` 时阻塞至回信，返回四级回执 |
| `inbox` | 拉取本节点可见消息页与未读数；`timeout` 阻塞等待新消息 |
| `ack` | 按消息 id 显式已读 |
| `roster` | 层级树 + 各节点卡片 |
| `conversation` | 会话历史分页（`before` / `limit`） |
| `group` | 建群 / 拉人 / 群列表（仅根发起，经审批闸门） |
| `shout` | 全员喊话（仅根发起，经审批闸门） |
| `status` | 上报自定义状态文本 |
| `message_status` | 查询指定消息的四级回执 |
| `ask` | 请求批示：`to` 为 agent_id 或 `'human'`，带 `question`/`options`/`allow_custom`；带 `wait` 时挂起至答复，返回批示单 + `reply?{choice\|text, timedOut}` |
| `respond_ask` | 答复请求批示：`ask_id` + `choice?` 或 `text?`（首答生效） |

通知页数据面（用户侧 UI 消费）：

- `GET /api/notifications?scope=actionable|all` — 通知列表（`actionable` = 待用户处理；`all` = 全部，含已决与 agent↔agent），每条带深链锚点 `cardMessageId` / `conversationId`。
- `POST /api/asks/:id/respond` — 以用户身份答复某条批示（`{choice?|text?}`）。
- `POST /api/notifications/:id/read` — 标记某条通知已读（幂等）。

## 安全模型（MVP 本地信任）

MVP 是本机单用户模型，安全边界是「进程与本地文件系统」，**不是**网络或身份层：

- `HUB_TOKEN`（`$AGENTCHAT_HOME/hub_token`）只作**传输门**：`/mcp` 与 `/internal/*` 的 Bearer 校验；
  loopback 本机进程可读，故不构成对本地恶意进程的防护。
- `x-agent-id` 是**建议性身份**：连接时声明、`register` 后可写，服务端不校验其与 `join_token` 的绑定。
- **审批闸门（建群/拉人/喊话）不是安全边界**：它约束「谁以根 agent 名义发起受限动作」的产品语义，
  不抵御伪造 `x-agent-id` 的本地调用方。
- LAN / Plan 2 将把 `join_token` **逐 agent 绑定**到连接凭证（真实身份认证），届时审批闸门与
  `x-agent-id` 才具备安全语义；在此之前请勿把 Hub 暴露到非可信网络。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。第三方参考实现的使用规范见 spec 第 3 节（仅复用 MIT 项目源码）。
