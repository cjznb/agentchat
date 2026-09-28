# AgentChat — OpenCode 插件（进程外适配器）

把本机运行的 [OpenCode](https://opencode.ai) 会话接入 AgentChat Hub：会话建立时注册节点、
回合始末上报 busy/idle、空闲时从 Hub 拉取积压消息并注入会话。

插件**只经 HTTP 契约**与 Hub 通信（不 import Hub 的 server 代码）。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `HUB_TOKEN` | 否 | 传输门 token **覆盖**（非空优先）。缺省时**插件与 MCP 桥都自动读** `<AGENTCHAT_HOME>/hub_token`（trim），通常无需设置 |
| `AGENTCHAT_HOME` | 否 | 数据目录，默认 `~/.agentchat`（与 Hub 一致） |
| `AGENTCHAT_URL` | 否 | Hub 地址，默认 `http://127.0.0.1:<AGENTCHAT_PORT 或 4646>` |
| `AGENTCHAT_PORT` | 否 | 仅用于推导默认 `AGENTCHAT_URL` |
| `AGENTCHAT_MCP_TIMEOUT_MS` | 否 | MCP 桥单次上游请求超时，默认 `30000`（钳制到 `[100, 600000]`） |

## 事件映射（实测 `@opencode-ai/plugin@1.18.32`）

插件经 `Hooks.event` 收全部事件，本适配器关心的几类：

| OpenCode 事件 | 动作 |
|---|---|
| `session.created`（`info.parentID` 缺失） | MCP `register`（根）：无 token → 首注册并把返回的 `join_token` 写 `<home>/agents/opencode.token`（0600）；有 token → 带 `join_token` 重连认领 |
| `session.created`（`info.parentID` 存在） | MCP `register{parent_ref, task_ref: info.id}`（`parent_ref` = 父会话已映射的节点 id；缺失时按「当前根 = 父回合窗口」兜底） |
| `session.status`（`busy`/`retry`/`idle`） | `POST /internal/state {busy\|idle}`（同态去重） |
| `session.idle` | 报 `idle`（同态去重，兜底宿主只发此事件的情况）→ `POST /internal/wake` → 逐条 `client.session.promptAsync` 注入（**按 `messageId` 有界去重**，租约重投不重复注入）→ `POST /internal/result {items:[{messageId,result:"delivered"\|"refused"}]}`（注入抛错记 `refused`） |
| `session.deleted`（根） | `POST /internal/state {offline}`（根保持 offline 语义） |
| `session.deleted`（子）/ `dispose` | `POST /internal/retire {agentId:<子节点>}` 退役子节点（**幂等**；`404` 视为已退役，不重试）；子节点不报 `offline`（Hub 侧 409 拒绝） |

依据：`@opencode-ai/sdk@1.18.32` 的类型联合含 `EventSessionCreated`（`info.parentID` 即子会话父引用）、
`EventSessionStatus`、`EventSessionIdle`、`EventSessionDeleted`；注入走 `client.session.promptAsync`
（`POST /session/{id}/prompt_async`，204 立即受理）。本仓插件未引入 `@opencode-ai/plugin` 依赖，
改用 `types.ts` 的最小本地声明（同版本实测），故 `npm run typecheck` 无需安装该重型类型包。

## 健壮性

- 每次 HTTP 调用 3s 超时；5xx/429/网络错误指数退避重试（base 250ms×2ⁿ、上限 30s、含 jitter）；
  401/404 等确定性错误不重试，记录并降级。
- **传输门 token 解析**：`env.HUB_TOKEN`（非空优先）→ `<AGENTCHAT_HOME>/hub_token`（trim）→ 空；
  两处皆空时打明确 warn、调用按既有 401 路径失败（无需手动 `export HUB_TOKEN`）。
- 所有事件处理入队即返回（fire-and-forget，串行保序），网络重试在后台推进，**不阻塞宿主事件循环**。
- token 写失败仅记录、不中断（尽力而为）。
- 根注册成功后把**节点 agent id** 落盘 `<home>/agents/opencode.id`（供本地 MCP 桥**逐请求**读作
  `x-agent-id`）。陈旧 token 自愈**只清 token、保留该 id 文件**：曾因连删该文件（而旧配置以 `{file:…}`
  引用它）导致 OpenCode 下次启动直接无法解析配置（被砖），详见 `docs/adapters-opencode.md`。
- 陈旧 `join_token`（Hub DB 重置/切换后）→ `invalid_join_token`：清空本地 token 后按「无 token 首次注册」
  重新注册为根并写回新 token（此路径不可能产生重复根），日志给明确 warn。
- 未映射会话（自身尚未注册的子会话）的 `session.status`/`session.idle` 一律跳过并 warn，
  **不回落根节点**（避免「给根取件、往子会话注入」错配）；该子会话注册后自然恢复。
- **在途租约去重**：Hub 的 `/internal/wake` 认领即 job → `sending` + 30s 在途租约（**非** `accepted`/`delivered`），
  未回执则租约到期后重投；故插件按 `messageId` **有界去重**（上限 256，FIFO 淘汰），已注入者**绝不重复注入**、仅补回执。
- **运行期子节点退役**：子会话 `session.deleted` → `POST /internal/retire`（幂等，`404` 视为已退役不重试；失败只记日志、
  不阻塞主流程），避免名单残留与向已死参与者投递。退役**不可复活**：同一 `task_ref`（=`session.id`）再注册被 Hub 拒绝；
  OpenCode 子会话 id 唯一，重派生即新节点。**根节点保持 `offline` 语义，不退役**。
- Windows 上 `chmod 0600` 调用成功但权限位可能不生效（与 Hub 侧 token 同策略）。

## 安装

见 `docs/adapters-opencode.md` 与 `adapters/opencode/install.mjs`。
安装器对既有 `mcp.agentchat` 条目做**结构比对**：结构一致则幂等无改动；识别为**本适配器旧产物**
（`remote` + `{file:…opencode.id}` 身份头，或本地桥条目）则**无需 `--force`** 就地迁移/移除；
结构不同的**用户自有**同名条目则**拒绝并给非 0 退出码**（除非 `--force`）。
`--uninstall` 能移除新旧两种结构，同时保留用户其它键。

## MCP 接入：本地 stdio 桥

`mcp-bridge.mjs` 是被 OpenCode 直接 spawn 的本地 stdio MCP server，把 JSON-RPC 透明转发到 Hub `/mcp`
（streamable-HTTP 有状态会话，响应支持 `application/json` 与 `text/event-stream`）。设计动因与取舍见
`docs/adapters-opencode.md`：

- **逐请求读盘**：`Authorization: Bearer <home>/hub_token`、`x-agent-id: <home>/agents/opencode.id`
  （文件不存在则省略该头，绝不因环境缺失而拒绝启动）。
- 会话 id 取自 initialize 响应头并在后续请求回带；`404 session_not_found` → 自动重新 initialize 一次重试。
- 每次上游请求带显式超时（默认 30s，`AGENTCHAT_MCP_TIMEOUT_MS` 覆盖）：Hub 卡住时以 JSON-RPC error 返回，
  不让严格串行链无限阻塞。
- 失败只在首次工具调用时以清晰 JSON-RPC error 回给宿主，桥进程保持存活。
- 配置里**不含任何 `{file:}` 引用与机密**（这正是旧结构让 OpenCode 无法启动的根因）。

`plugin.ts` 默认导出 OpenCode 期望的 `PluginModule` 形态 `{ id: "agentchat", server }`
（加载器 `readV1Plugin` 只读 `default`，且本地路径插件必须带 `id`），命名导出 `AgentChatPlugin`
保留供测试/复用。

## 文件

| 文件 | 职责 |
|---|---|
| `plugin.ts` | 插件入口（`AgentChatPlugin`）；事件映射与队列调度 |
| `mcp-bridge.mjs` | 本地 stdio MCP 桥：逐请求读盘身份/token，透明转发到 Hub `/mcp` |
| `hub.ts` | 客户端门面：组合传输层与 MCP，暴露 `register` + `/internal/*` |
| `transport.ts` | 传输层：HTTP POST、3s 超时、指数退避重试、`HubError` |
| `mcp.ts` | MCP `register` 握手与 SSE/工具结果解析、`HubToolError` |
| `token.ts` | `join_token` 与节点 agent id 文件读写/清除（0600 尽力而为） |
| `types.ts` | OpenCode 插件 API 最小本地类型声明（实测 1.18.32） |
| `util.ts` | 类型守卫 + 串行任务队列 |
