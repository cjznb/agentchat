# AgentChat — Claude Code hooks 适配器（进程外适配器）

把本机运行的 [Claude Code](https://code.claude.com/docs/en/hooks) 会话接入 AgentChat：会话建立时注册节点、
工具调用时上报忙碌、回合结束（空闲）时从 Hub 拉取积压消息并注入回会话。

本适配器**只经 HTTP 契约**与 Hub 通信（不 import 本仓 server 代码），由一组**跨平台 Node 脚本**组成，
每个脚本对应一个 Claude Code hook 事件，直接以 `node <script>.mjs` 运行（无第三方依赖）。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `HUB_TOKEN` | 是 | Hub 传输门 token，取 `<AGENTCHAT_HOME>/hub_token` 内容 |
| `AGENTCHAT_HOME` | 否 | 数据目录，默认 `~/.agentchat`（与 Hub 一致） |
| `AGENTCHAT_URL` | 否 | Hub 地址，默认 `http://127.0.0.1:<AGENTCHAT_PORT 或 4646>` |
| `AGENTCHAT_PORT` | 否 | 仅用于推导默认 `AGENTCHAT_URL` |
| `AGENTCHAT_HOOK_TIMEOUT_MS` | 否 | HTTP 超时覆盖，默认 `3000`（仅测试用途；生产恒 3s） |

hook 由 Claude Code 进程派生，故这些变量需出现在启动 `claude` 的环境里（`export HUB_TOKEN=…`）。

## 安装

1. 复制 `settings.snippet.json` 的内容，把其中 `__AGENTCHAT_ADAPTER_DIR__` 全部替换为
   `adapters/claude-code/` 的**绝对路径**（用正斜杠，Windows 亦可）。
2. 把替换后的 `hooks` 对象并入用户级 `~/.claude/settings.json`（或项目级 `.claude/settings.json`）。
   已存在其它 `hooks` 事件时，按事件名把数组项追加进去，不要整体覆盖。
3. 确保 `HUB_TOKEN`（等环境变量）对 `claude` 进程可见。

> 片段使用 `"command": "node", "args": ["<abs>/x.mjs"]` 形式，避免任何 shell 引用/平台差异；
> 请确保 `node` 在 `PATH` 上（`node >= 22`，与 Hub 一致）。

## 事件映射

| Claude Code 事件 | 脚本 | 动作 |
|---|---|---|
| `SessionStart`（`startup\|resume\|clear\|compact\|fork`） | `session-start.mjs` | 有 token → `register{join_token}` 认领重连；无 token → `register` 根并把 `join_token` 写 `<home>/agents/claude-code.token`(0600)；落盘节点 id 与「根回合窗口」；`/internal/state {online}`；兜底 `wake` 拉取并以 `additionalContext` 注入 |
| `SubagentStart` | `subagent-start.mjs` | `register{parent_ref, task_ref}`（父关联兜底见下）；记录子映射；子节点 `state {busy}` |
| `PreToolUse` / `PostToolUse` | `busy.mjs` | `/internal/state {busy}`（子代理内事件按 `agent_id` 映射到子节点，否则回落根） |
| `Stop` | `idle.mjs` | `/internal/state {idle}` → `wake` → 有消息则输出 `decision:"block"` + `additionalContext` 续跑 → `/internal/result` 回执 |
| `Notification`（matcher `idle_prompt`） | `idle.mjs` | `/internal/state {idle}`；注入交由 Stop（见「注入路线」） |

## 注入路线选择依据（官方文档核实）

**结论：采用 `Stop` hook 输出 `decision:"block"` + `hookSpecificOutput.additionalContext` 作为唯一注入路线；
弃用 `claude -p`；`Notification(idle_prompt)` 降级为仅上报状态。**

依据（Claude Code Hooks reference，https://code.claude.com/docs/en/hooks ，核实日期 2026-09-28）：

1. `additionalContext` 的生效位点明确列出：`SessionStart`/`Setup`/`SubagentStart`、`UserPromptSubmit`/`UserPromptExpansion`、
   `PreToolUse`/`PostToolUse`/`PostToolUseFailure`/`PostToolBatch`、`Stop`/`SubagentStop`。
   `Stop` 被明确标注为「at the end of the turn，conversation continues so Claude can act on the feedback」，
   配合 `Stop decision control` 的 `{"decision":"block","reason":…}` 即可让已结束的回合继续并消费注入内容。
2. `Notification` **不在**上述位点列表内——它没有向模型注入上下文的通道。
3. 更关键的正确性约束：Hub 的 `/internal/wake` 会**认领**积压（job → `accepted`），认领后再次 `wake` 不再返回该消息。
   若在无注入位的 `Notification` 里 `wake`，将导致消息被认领却无法投递而**永久丢失**。
   因此 `idle.mjs` 在 `Notification` 分支**不 wake**，仅上报 `idle`；注入统一由 `Stop` 承担（降级策略，已写入脚本注释）。
4. `claude -p`（print 模式）会**另起**一个 Claude 进程，无法把内容注入到当前活会话，故弃用。

### 未在真机实测（本机未安装真实 Claude Code）

以下项以**官方文档 + 载荷形状**为依据设计，尚未在真机 claude 上端到端验证，待验证清单：

- `Stop` 输出的 `{"decision":"block","reason":…,"hookSpecificOutput":{…}}` 组合字段的**实际接受情况**与 `additionalContext` 生效时机。
- `stop_hook_active` 的精确置位时机；本适配器以「仅当确有消息才 block」自然防死循环，未额外依赖该字段。
- `SubagentStart` 载荷是否加入父/会话关联字段（当前文档只列 `agent_id`/`agent_type`）。
- `Notification` 的 matcher/`notification_type` 字段命名（文档 matcher 表按「notification type」匹配 `idle_prompt`）。
- `SessionStart` 的 `additionalContext` 与 `initialUserMessage` 等字段的真实渲染（本适配器仅用 `additionalContext`）。
- Windows 上 `chmod 0600` 权限位实际生效情况（尽力而为，与 Hub/OpenCode 同策略）。

## 父关联兜底（SubagentStart）

Claude Code 官方文档的 Common input fields 说明：子代理内触发的 hook 载荷新增 `agent_id`（子代理唯一 id）与
`agent_type`（代理类型名），**未提供父引用字段**。故 `subagent-start.mjs` 按控制器裁决 ②「父回合窗口」兜底：
读取 `<home>/agents/claude-code.root.json`（由 `SessionStart` 写入的当前活跃根节点）作为 `parent_ref`，
以载荷 `agent_id` 作为 `task_ref`。无活跃根则**跳过注册**（绝不误挂到错误父节点）。

## 本地文件（`<AGENTCHAT_HOME>/agents/`）

| 文件 | 说明 |
|---|---|
| `claude-code.token` | 根节点 `join_token`（0600 尽力而为；陈旧时自动清除重建） |
| `claude-code.id` | 根节点 Hub agent id（busy/idle 上报与取件归属） |
| `claude-code.root.json` | 当前根回合窗口 `{agentId, sessionId, at}`（SubagentStart 父关联兜底） |
| `claude-code.subs.json` | 子代理映射 `agent_id → {agentId, agentType, sessionId, at}`（PreToolUse/PostToolUse 归属） |
| `logs/claude-code-adapter.log` | 追加式带时间戳日志 |

## 健壮性

- 每次 HTTP 调用 3s 超时；网络错误/超时/服务不可达一律捕获、写日志、**退出码恒 0**——绝不阻塞或非零退出影响宿主。
- 无 `HUB_TOKEN`、Hub 不可达、载荷为空/非法 JSON 时静默继续。
- 陈旧 `join_token`（Hub DB 重置/切换）→ `invalid_join_token`：清空本地 token 后按「无 token 首次注册」
  重新注册为根并写回新 token（此路径不产生重复根）。
- token/id 写失败仅记录、不中断（尽力而为）。
- 防注入死循环：`Stop` 仅在 `wake` 确有消息时 block；`delivered` 后下次 `wake` 为空，自然终止。

## 文件

| 文件 | 职责 |
|---|---|
| `common.mjs` | 共享层：stdin JSON、3s HTTP、MCP `register` 握手、`/internal/*`、hook 包裹 |
| `token.mjs` | 路径解析与本地文件读写、日志追加（失败不抛错） |
| `session-start.mjs` | 注册/重连、token/id/根窗口落盘、online、兜底拉取 |
| `subagent-start.mjs` | 子节点注册（父回合窗口兜底）+ 映射 + busy |
| `busy.mjs` | PreToolUse/PostToolUse → busy |
| `idle.mjs` | Stop/Notification → idle；Stop 取件并注入续跑 |
| `settings.snippet.json` | 可直接并入用户 settings 的 hooks 片段 |
| `__tests__/` | 真子进程 + 假 stdin JSON + mock HTTP 服务端的单测 |

## 测试

`npm test` 会跑 `adapters/claude-code/__tests__/*.test.ts`：每个脚本以真实子进程
（`process.execPath`）运行，喂入假 stdin JSON，对 mock HTTP 服务端断言「请求路径/方法/载荷/鉴权头」
与退出码 0，并覆盖无 token 首注册、有 token 认领、busy 上报、idle→wake→注入输出（含 `additionalContext` JSON）、
超时/服务不可达时静默成功退出。
