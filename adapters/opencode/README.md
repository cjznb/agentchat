# AgentChat — OpenCode 插件（进程外适配器）

把本机运行的 [OpenCode](https://opencode.ai) 会话接入 AgentChat Hub：会话建立时注册节点、
回合始末上报 busy/idle、空闲时从 Hub 拉取积压消息并注入会话。

插件**只经 HTTP 契约**与 Hub 通信（不 import Hub 的 server 代码）。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `HUB_TOKEN` | 是 | Hub 传输门 token，取 `<AGENTCHAT_HOME>/hub_token` 内容 |
| `AGENTCHAT_HOME` | 否 | 数据目录，默认 `~/.agentchat`（与 Hub 一致） |
| `AGENTCHAT_URL` | 否 | Hub 地址，默认 `http://127.0.0.1:<AGENTCHAT_PORT 或 4646>` |
| `AGENTCHAT_PORT` | 否 | 仅用于推导默认 `AGENTCHAT_URL` |

## 事件映射（实测 `@opencode-ai/plugin@1.18.32`）

插件经 `Hooks.event` 收全部事件，本适配器关心的四类：

| OpenCode 事件 | 动作 |
|---|---|
| `session.created`（`info.parentID` 缺失） | MCP `register`（根）：无 token → 首注册并把返回的 `join_token` 写 `<home>/agents/opencode.token`（0600）；有 token → 带 `join_token` 重连认领 |
| `session.created`（`info.parentID` 存在） | MCP `register{parent_ref, task_ref: info.id}`（`parent_ref` = 父会话已映射的节点 id；缺失时按「当前根 = 父回合窗口」兜底） |
| `session.status`（`busy`/`retry`/`idle`） | `POST /internal/state {busy\|idle}`（同态去重） |
| `session.idle` | 报 `idle`（同态去重，兜底宿主只发此事件的情况）→ `POST /internal/wake` → 逐条 `client.session.promptAsync` 注入 → `POST /internal/result {items:[{messageId,result:"delivered"\|"refused"}]}`（注入抛错记 `refused`） |
| `session.deleted`（根）/ `dispose` | `POST /internal/state {offline}`（子节点不报 offline，Hub 侧 409 拒绝） |

依据：`@opencode-ai/sdk@1.18.32` 的类型联合含 `EventSessionCreated`（`info.parentID` 即子会话父引用）、
`EventSessionStatus`、`EventSessionIdle`、`EventSessionDeleted`；注入走 `client.session.promptAsync`
（`POST /session/{id}/prompt_async`，204 立即受理）。本仓插件未引入 `@opencode-ai/plugin` 依赖，
改用 `types.ts` 的最小本地声明（同版本实测），故 `npm run typecheck` 无需安装该重型类型包。

## 健壮性

- 每次 HTTP 调用 3s 超时；5xx/429/网络错误指数退避重试（base 250ms×2ⁿ、上限 30s、含 jitter）；
  401/404 等确定性错误不重试，记录并降级。
- 所有事件处理入队即返回（fire-and-forget，串行保序），网络重试在后台推进，**不阻塞宿主事件循环**。
- token 写失败仅记录、不中断（尽力而为）。
- Windows 上 `chmod 0600` 调用成功但权限位可能不生效（与 Hub 侧 token 同策略）。

## 安装

见 `docs/adapters-opencode.md`（Task 3）与 `adapters/opencode/install.mjs`。

## 文件

| 文件 | 职责 |
|---|---|
| `plugin.ts` | 插件入口（`AgentChatPlugin`）；事件映射与队列调度 |
| `hub.ts` | Hub HTTP 客户端（MCP `register` 握手 + `/internal/*`），超时/退避 |
| `token.ts` | `join_token` 文件读写（0600 尽力而为） |
| `types.ts` | OpenCode 插件 API 最小本地类型声明（实测 1.18.32） |
| `util.ts` | 类型守卫 + 串行任务队列 |
