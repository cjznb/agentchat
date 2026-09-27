# AgentChat — Claude Code 适配器安装与冒烟

把本机 [Claude Code](https://code.claude.com/docs/en/hooks) 接入 AgentChat Hub。安装器
（`adapters/claude-code/install.mjs`）把 **hooks 事件条目** 与 **MCP server 条目** 并入用户
`settings.json`，一条命令完成；本文档同时给出**手动冒烟清单**（需真实 Claude Code）与**排障表**。

> 适配器组件（`*.mjs`）的事件映射、注入路线与健壮性见 `adapters/claude-code/README.md`。
> 冒烟步骤中标注「**需真实 Claude Code**」的必须真机执行；`install.mjs` 的配置写入由单测覆盖
> （`adapters/claude-code/__tests__/install.test.ts`，真子进程）。

## 前置

- Node ≥ 22；Hub 已能启动（`npm start`）。首次启动 Hub 会在 `<AGENTCHAT_HOME>/hub_token` 写入传输门 token。
- Hub 数据目录默认 `~/.agentchat`；端口默认 `4646`。
- 已安装真实 Claude Code（`claude` 在 `PATH` 上），并已用其用户级配置目录（默认 `~/.claude`）。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `HUB_TOKEN` | **是** | — | Hub 传输门 token，取 `<AGENTCHAT_HOME>/hub_token` 的内容。hooks 脚本与 MCP 头都用它 |
| `AGENTCHAT_AGENT_ID` | 是（MCP 用） | — | 本节点 agent id，取 `<AGENTCHAT_HOME>/agents/claude-code.id` 的内容（**首次 SessionStart 后生成**，见下） |
| `AGENTCHAT_HOME` | 否 | `~/.agentchat` | 数据目录；token/id/日志的落盘根（与 Hub 一致） |
| `AGENTCHAT_URL` | 否 | `http://127.0.0.1:<AGENTCHAT_PORT 或 4646>` | Hub 地址；安装器用它推导 MCP `url` |
| `AGENTCHAT_PORT` | 否 | `4646` | 仅用于推导默认 `AGENTCHAT_URL` |
| `AGENTCHAT_HOOK_TIMEOUT_MS` | 否 | `3000` | hook HTTP 超时覆盖（仅测试用途；生产恒 3s） |

hook 由 Claude Code 进程派生，故这些变量需出现在**启动 `claude` 的环境**里（`export HUB_TOKEN=…`）。

> **为何用 `AGENTCHAT_AGENT_ID` 而不是文件引用**：OpenCode 的 MCP 配置支持 `{file:…}` 直接引用 id 文件；
> Claude Code 的 `settings.json` **不支持文件引用**，只支持 `${VAR}` 环境变量展开（官方文档 *Environment
> variable expansion in `.mcp.json`*）。故 `x-agent-id` 用 `${AGENTCHAT_AGENT_ID}` 变量承载，值即 id 文件内容。

## 安装

安装器支持的目标 settings 解析顺序（依次）：

1. `--config <path>`（显式；父目录缺失/文件不存在 → 明确报错，退出码 1）
2. `$CLAUDE_SETTINGS`（AgentChat 约定覆盖；同上校验）
3. `$CLAUDE_CONFIG_DIR/settings.json`（Claude Code 官方配置目录重定位），否则 `~/.claude/settings.json`

若第 3 步默认路径不存在，安装器**报错并提示用 `--config`**（不自动创建 settings——避免写出未知 schema 的文件）。
Claude Code 的 settings 为**严格 JSON**（无注释/尾逗号）。

写入策略：改动前先备份 `<config>.bak`，再以**临时文件 + rename 原子替换**；`--dry-run` 只打印不落盘。
合并语义：`hooks` 下**用户既有条目一律保留**，只追加本适配器条目并按脚本路径去重（幂等）；`mcpServers`
只增/改 `agentchat` 键。`--uninstall` 精确移除本适配器条目（事件数组清空后删该键）。

### PowerShell（Windows）

```powershell
# 1) 运行 Hub，使其写出 token（另开终端；可保持运行）
npm start

# 2) 导出环境变量（当前终端）
$env:AGENTCHAT_HOME = "$HOME\.agentchat"
$env:HUB_TOKEN = (Get-Content "$HOME\.agentchat\hub_token" -Raw).Trim()
$env:AGENTCHAT_URL = "http://127.0.0.1:4646"   # 可选，默认即此

# 3) 预演（只打印将写入的内容），确认无误后去掉 --dry-run
node adapters/claude-code/install.mjs --config "$HOME\.claude\settings.json" --dry-run
node adapters/claude-code/install.mjs --config "$HOME\.claude\settings.json"
```

### POSIX（macOS / Linux）

```bash
export AGENTCHAT_HOME="$HOME/.agentchat"
export HUB_TOKEN="$(cat "$AGENTCHAT_HOME/hub_token")"
export AGENTCHAT_URL="http://127.0.0.1:4646"   # 可选

node adapters/claude-code/install.mjs --config ~/.claude/settings.json --dry-run
node adapters/claude-code/install.mjs --config ~/.claude/settings.json
```

### 默认查找 / 卸载

```bash
node adapters/claude-code/install.mjs            # 自动查 $CLAUDE_SETTINGS 或 $CLAUDE_CONFIG_DIR/settings.json 或 ~/.claude/settings.json
node adapters/claude-code/install.mjs --dry-run
node adapters/claude-code/install.mjs --uninstall
node adapters/claude-code/install.mjs --help
```

安装后 settings 里新增两处（`settings.snippet.json` 与写入结构一致）：

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact|fork",
        "hooks": [{ "type": "command", "command": "node", "args": ["<仓库绝对路径>/adapters/claude-code/session-start.mjs"] }]
      }
    ],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "node", "args": ["<…>/subagent-start.mjs"] }] }],
    "PreToolUse":    [{ "hooks": [{ "type": "command", "command": "node", "args": ["<…>/busy.mjs"] }] }],
    "PostToolUse":   [{ "hooks": [{ "type": "command", "command": "node", "args": ["<…>/busy.mjs"] }] }],
    "Stop":          [{ "hooks": [{ "type": "command", "command": "node", "args": ["<…>/idle.mjs"] }] }],
    "Notification":  [{ "matcher": "idle_prompt", "hooks": [{ "type": "command", "command": "node", "args": ["<…>/idle.mjs"] }] }]
  },
  "mcpServers": {
    "agentchat": {
      "type": "http",
      "url": "http://127.0.0.1:4646/mcp",
      "headers": {
        "Authorization": "Bearer ${HUB_TOKEN}",
        "x-agent-id": "${AGENTCHAT_AGENT_ID}"
      }
    }
  }
}
```

> 片段使用 exec form（`"command": "node", "args": ["<abs>.mjs"]`）：Claude Code 在 `args` 存在时
> **不经 shell**、把每个 `args` 元素原样作为参数，跨平台一致（官方文档 *Exec form and shell form*）。
> 请确保 `node` 在 `PATH` 上（`node >= 22`）。

## token / 节点 id 位置与陈旧自愈

| 文件 | 位置 | 作用 |
|---|---|---|
| `join_token` | `<AGENTCHAT_HOME>/agents/claude-code.token`（0600 尽力而为） | `SessionStart` 重连认领根节点 |
| 节点 agent id | `<AGENTCHAT_HOME>/agents/claude-code.id` | busy/idle 上报与取件归属；**MCP 头 `x-agent-id` 的取值来源**（经 `AGENTCHAT_AGENT_ID`） |

**陈旧自愈（已实现，无需人工）**：Hub DB 重置/切换后，`register` 返回 `invalid_join_token` →
`session-start.mjs` 清空本地 `claude-code.token` → 按「无 token 首次注册」重新注册为新根 → 写回新 token/id。

**手工兜底**（自愈仍失败时）：删除 `<AGENTCHAT_HOME>/agents/claude-code.token`（可视情况连同 `claude-code.id`）
后重启 `claude`。

**首次启动的 id 滞后**：`AGENTCHAT_AGENT_ID` 需要 `claude-code.id` 的内容，而该文件在**首次 `SessionStart`
注册后**才生成。故首次流程为：① 启动 `claude`（hook 注册并写 id）→ ② 读取 id 设为 `AGENTCHAT_AGENT_ID`
→ ③ 重启 `claude`，MCP 即带身份连接。这与 OpenCode 适配器首次 `agent_not_found` 后「重启一次」是同一模式。

## 手动冒烟清单（**需真实 Claude Code**）

> 以下 ①–⑤ 均须在**安装了真实 Claude Code 的真机**上执行；括号内为观察点。安装器本身的配置写入由单测覆盖。

1. **[ ] 安装并启动**：完成上一节安装（`settings.json` 已含 hooks + `mcpServers.agentchat`）后，在设置了
   `HUB_TOKEN`/`AGENTCHAT_AGENT_ID` 的终端启动 `claude`。观察 `claude` 无报错、可正常进入会话。
2. **[ ] 节点现身**：`GET /api/roster`（UI 数据面，无需 Bearer）应出现 `vendor` 为 `claude-code` 的节点。
   ```bash
   curl http://127.0.0.1:4646/api/roster
   ```
3. **[ ] 发消息/ask**：从 Hub Web UI 选中该节点发送，或用另一节点的 MCP `send`/`ask` 指向它。
4. **[ ] 目标空闲时被注入**：目标回合结束时（`Stop` hook），适配器取件并以 `Stop` 的
   `{"decision":"block","reason":…}` + `hookSpecificOutput.additionalContext` 注入续跑；**正文同时写入
   `reason`（保底）与 `additionalContext`**。观察到该会话出现 AgentChat 注入文本并据此继续工作。
5. **[ ] 四级回执与状态**：消息回执按 `queued→sending→delivered→read` 演进（`read` 仅在收件方显式 `ack` 后；
   失败态 `refused`/`expired`/`cancelled` 回落 `queued`），用 `message_status` 工具或 Web UI 气泡回执查看；
   节点 `busy`/`idle` 经 **`GET /api/roster`** 观察（`/internal/state` 是适配器→Hub 的 **POST-only** 上报端点）。

### 已标注未实测项（需真实 Claude Code）

以下以官方文档 + 载荷形状为依据设计，**尚未在真机 claude 上端到端验证**（与 `adapters/claude-code/README.md`
的「未在真机实测」清单一致）：

- `Stop` 输出 `{"decision":"block","reason":…,"hookSpecificOutput":{…}}` 组合字段的实际接受情况与
  `additionalContext` 生效时机；本适配器以 `reason` 同文镜像保底。
- `stop_hook_active` 的精确置位时机（本适配器仅在确有消息时 block，未额外依赖该字段）。
- `SubagentStart` 载荷是否含父/会话关联字段（当前文档只列 `agent_id`/`agent_type`；适配器按「根回合窗口」兜底）。
- `Notification` 的 matcher / `notification_type` 字段命名（按 `idle_prompt` 匹配）。
- `SessionStart` 的 `additionalContext` 真实渲染（仅用 `additionalContext`）。
- Claude Code 对 `${HUB_TOKEN}`/`${AGENTCHAT_AGENT_ID}` 在 `headers` 中的展开（含 `HUB_TOKEN` 是否被
  当作「凭据变量读作空」；见排障表对应行）。
- Windows 上 `chmod 0600` 权限位实际生效情况（尽力而为）。

## 排障表

| 症状 | 可能原因 | 处理 |
|---|---|---|
| hook 完全未触发（日志无新行） | `node` 不在 `PATH`；settings 未被加载；SessionStart matcher 未命中 | 确认 `node -v ≥ 22`；确认写入的是 `claude` 实际读取的 settings（用户级/项目级）；重启 `claude`；手工以空 stdin 跑 `node <abs>/session-start.mjs` 看是否报错；查 `<AGENTCHAT_HOME>/logs/claude-code-adapter.log` |
| `additionalContext` 未生效 | 该 Claude Code 版本不接受 `Stop` 的 `hookSpecificOutput` 组合 | 注入正文已**同文写入 `reason`**（Stop block 必被采纳字段），通常仍可见；否则用 `SessionStart` 兜底拉取路径（下次启动时注入）；升级 Claude Code 复核 |
| 出现权限提示阻断 hook | 组织策略/权限模式禁止 hook 命令执行 | 在受信任目录运行 `claude`；确认未自定义收紧 hook 权限；hook 本身不产出 `permissionDecision`，不会主动拒绝工具 |
| MCP `401 unauthorized` | `HUB_TOKEN` 未对 `claude` 进程可见，或 `headers` 里 `${HUB_TOKEN}` 被当作「凭据变量读作空」 | 在启动 `claude` 的终端 `export HUB_TOKEN=…` 后重启；若确认被读空，把 token 复制到一个**不以 TOKEN/SECRET/KEY/AUTH 命名**的变量（如 `AGENTCHAT_TT`）并改用 `${AGENTCHAT_TT}` |
| MCP `400 agent_not_found` | `AGENTCHAT_AGENT_ID` 未设/陈旧：`claude-code.id` 尚未生成或已变 | 启动一次让 `SessionStart` 写 id，读取后设为 `AGENTCHAT_AGENT_ID`（或删 token+id 重注册拿新 id），**重启 `claude`** |
| MCP 工具报 `identity_required` | MCP 会话无 `x-agent-id`（`AGENTCHAT_AGENT_ID` 为空/未展开） | 同上，确保 `AGENTCHAT_AGENT_ID` 已设置为 id 文件内容并重启 |
| 回合未在空闲时注入（`Stop` 未 wake） | `stop_hook_active===true` 时放行；或每会话连续 block 已达上限 3 | 预期防死循环行为：放行、不 wake；下个正常回合或重启后再试。`delivered` 后下次 `wake` 为空亦自然终止 |
| `Notification(idle_prompt)` 未注入 | 设计如此：`Notification` 无注入通道，仅上报 `idle`（避免认领后无法投递而丢消息） | 注入统一由 `Stop` 承担；核对 `Stop` 是否触发（见上） |
| 节点不在 `GET /api/roster` | hooks 未安装/未生效，或 `HUB_TOKEN` 缺失致注册跳过 | 重跑 `install.mjs` 确认两处已写入；导出 `HUB_TOKEN` 后重启；查适配器日志 |
| Windows 权限位无效（`claude-code.token` 非 0600） | Windows 上 `chmod` 调用成功但权限位可能不生效 | 非 bug；与 Hub/OpenCode 同策略（尽力而为），依赖本机文件系统 ACL |
| 重复安装产生重复 hook 条目 | 手工编辑过 `args` 路径致脚本 basename 无法识别 | 条目按 `args[0]` 的 **basename** 识别归属；避免改动 `args` 里的脚本名；`--uninstall` 后再重装 |

## 约束

- 安装器不改动用户无关配置键；重复安装内容等价；`--uninstall` 精确移除本适配器条目。
- 适配器只经 HTTP 契约与 Hub 通信，不 import Hub 的 server 代码；无新增运行时依赖。
- `settings.snippet.json` 与 `install.mjs` 的写入结构保持**一致**（hooks 事件集合、exec form、MCP 条目）。
