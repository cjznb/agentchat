# AgentChat — Claude Code 适配器安装与冒烟

把本机 [Claude Code](https://code.claude.com/docs/en/hooks) 接入 AgentChat Hub。安装器
（`adapters/claude-code/install.mjs`）一条命令写入**两个文件**：**hooks** 并入
`settings.json`，**MCP server 条目**并入 MCP 配置（默认用户级 `~/.claude.json`）。本文档同时给出
**手动冒烟清单**（需真实 Claude Code）与**排障表**。

> 适配器组件（`*.mjs`）的事件映射、注入路线与健壮性见 `adapters/claude-code/README.md`。
> 冒烟步骤中标注「**需真实 Claude Code**」的必须真机执行；`install.mjs` 的配置写入由单测覆盖
> （`adapters/claude-code/__tests__/install.test.ts`，真子进程）。

## 两个落点（务必区分；官方事实）

Claude Code 的 **settings schema 没有根级 `mcpServers`**（写在 `settings.json` 会被**静默忽略**、不报错）。
MCP server 的官方 JSON 位置是 `~/.claude.json`、项目 `.mcp.json`、或 `claude mcp add-json`。故：

| 内容 | 落点 | 片段文件 |
|---|---|---|
| **hooks** | `settings.json`（用户级 `~/.claude/settings.json`，或项目 `.claude/settings.json`） | `adapters/claude-code/settings.snippet.json` |
| **MCP server** | MCP 配置：默认 `~/.claude.json`（设 `CLAUDE_CONFIG_DIR` 时为 `$CLAUDE_CONFIG_DIR/.claude.json`）；项目级用 `--mcp-config .mcp.json` | `adapters/claude-code/mcp.snippet.json` |

> 安装器**拒绝**把两处写成同一文件（同一文件 → 报错），从机制上避免 MCP 落在被忽略的位置。

## 前置

- Node ≥ 22；Hub 已能启动（`npm start`）。首次启动 Hub 会在 `<AGENTCHAT_HOME>/hub_token` 写入传输门 token。
- Hub 数据目录默认 `~/.agentchat`；端口默认 `4646`。
- 已安装真实 Claude Code（`claude` 在 `PATH` 上），并已用其用户级配置目录（默认 `~/.claude`）。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `HUB_TOKEN` | **是** | — | Hub 传输门 token，取 `<AGENTCHAT_HOME>/hub_token` 的内容。**hooks 脚本读它**（MCP 头由下面脚本从文件读） |
| `AGENTCHAT_AGENT_ID` | 否 | — | 本节点 agent id；**一般无需设置**——`mcp-headers.mjs` 默认读 `<AGENTCHAT_HOME>/agents/claude-code.id`，此变量仅作环境变量覆盖 |
| `AGENTCHAT_HOME` | 否 | `~/.agentchat` | 数据目录；token/id/日志的落盘根（与 Hub 一致） |
| `AGENTCHAT_URL` | 否 | `http://127.0.0.1:<AGENTCHAT_PORT 或 4646>` | Hub 地址；安装器用它推导 MCP `url` |
| `AGENTCHAT_PORT` | 否 | `4646` | 仅用于推导默认 `AGENTCHAT_URL` |
| `AGENTCHAT_HOOK_TIMEOUT_MS` | 否 | `3000` | hook HTTP 超时覆盖（仅测试用途；生产恒 3s） |
| `AGENTCHAT_ADAPTERS` | 否 | `<home>/config.json` 或空 | **Hub 侧**变量（不是 hook 变量）：厂商登记**覆盖**（逗号分隔）。缺省读 `<AGENTCHAT_HOME>/config.json` 的 `adapters`；两者都空时 Hub 会在**首次**收到 `claude-code` 的 `POST /internal/wake` 时自动识别为 pull 适配器。安装器已自动写入该文件，**通常无需手动设置** |

hook 由 Claude Code 进程派生，故 `HUB_TOKEN` 需出现在**启动 `claude` 的环境**里（`export HUB_TOKEN=…`）。

> **MCP 头为何不写 token、也不用 `${HUB_TOKEN}`**：Claude Code 的 MCP 文档有
> *Credential variables that read as empty* 一节——某些凭据变量会被**静默替换为空**，失败态是难查的 401。
> 故 MCP 条目改用 `headersHelper`（官方支持的「连接时动态产出头」机制）指向 `mcp-headers.mjs`，
> 由该脚本在连接时从 `<AGENTCHAT_HOME>/hub_token` 与 `agents/claude-code.id` 读取并输出头，
> **配置里不出现任何 token**。详见 `mcp.snippet.json`。

## 安装

安装器支持的目标解析（依次）：

- **hooks 目标 `settings.json`**：① `--config <path>` → ② `$CLAUDE_SETTINGS`（AgentChat 约定覆盖）→
  ③ `$CLAUDE_CONFIG_DIR/settings.json`（官方配置目录重定位），否则 `~/.claude/settings.json`。
  默认路径不存在 → **报错并提示用 `--config`**（不自动创建；Claude Code settings 为**严格 JSON**）。
- **MCP 目标**：① `--mcp-config <path>`（如项目 `<repo>/.mcp.json`）→ ② 设了 `CLAUDE_CONFIG_DIR` 时
  `$CLAUDE_CONFIG_DIR/.claude.json`（官方：该变量同时重定位 `.claude.json` 与 `settings.json`，两者同目录）
  → ③ 默认 `~/.claude.json`（不存在则创建，父目录需存在）。

选默认用户级 `.claude.json` 的理由：用户级、跨项目生效、**无需项目工作区信任审批**（项目 `.mcp.json`
在交互会话里要用户逐项目批准）；需要团队共享/版本控制时改用 `--mcp-config <repo>/.mcp.json`。
`CLAUDE_CONFIG_DIR` 与 settings 的解析优先级一致，避免「MCP 写到别处、Claude Code 读不到」的静默不可见。

写入策略：改动前备份 `<file>.bak`，再以**临时文件 + rename 原子替换**；`--dry-run` 只打印三处目标（hooks / MCP / Hub 适配器）、不落盘。
合并语义：`hooks` 下**用户既有条目一律保留**，只追加本适配器条目并按**规范化绝对路径**去重（幂等）；
`mcpServers` 只增/改 `agentchat` 键。**MCP 条目所有权守卫**：写入前对既有 `mcpServers.agentchat` 做结构比对——
仅当结构与本安装器将写入的一致才覆盖；结构不同则**拒绝并给非 0 退出码**（除非 `--force`）。`--uninstall` 仅当结构
匹配本安装器产物时才精确移除该键（否则保留并提示）。**同一文件拒绝**按**规范化真实路径**（`realpath` + win32/darwin
大小写折叠）判定，大小写变体/别名无法绕过。

**顺手登记 Hub 厂商（免手动 env）**：同一次安装还会把 `claude-code` 合并进
**`<AGENTCHAT_HOME>/config.json`**（缺省 `~/.agentchat/config.json`）的 `adapters` 数组——
文件不存在则创建、保留其它键、**幂等**；`--uninstall` 只移除 `claude-code`（保留文件与其它键）；
`--dry-run` 只打印不落盘。Hub 侧优先级为 **env `AGENTCHAT_ADAPTERS` > 该文件 > 空**，
故**无需再手动 `$env:AGENTCHAT_ADAPTERS`**。Hub **只读**该文件（绝不创建），仅安装器/CLI 写。

### PowerShell（Windows）

```powershell
# 1) 运行 Hub，写出 token（另开终端；可保持运行）——厂商登记由安装器自动写入 config.json，无需手动设 env
npm start

# 2) 导出环境变量（当前终端）
$env:AGENTCHAT_HOME = "$HOME\.agentchat"
$env:HUB_TOKEN = (Get-Content "$HOME\.agentchat\hub_token" -Raw).Trim()
$env:AGENTCHAT_URL = "http://127.0.0.1:4646"   # 可选，默认即此

# 3) 预演（打印三处将写入内容：hooks / MCP / Hub 适配器），确认无误后去掉 --dry-run
node adapters/claude-code/install.mjs --config "$HOME\.claude\settings.json" --dry-run
node adapters/claude-code/install.mjs --config "$HOME\.claude\settings.json"
# 项目级 MCP 落 .mcp.json（可选）：加 --mcp-config "$PWD\.mcp.json"
```

### POSIX（macOS / Linux）

```bash
# 启动 Hub（另开终端）——厂商登记由安装器自动写入 config.json
npm start

export AGENTCHAT_HOME="$HOME/.agentchat"
export HUB_TOKEN="$(cat "$AGENTCHAT_HOME/hub_token")"
export AGENTCHAT_URL="http://127.0.0.1:4646"   # 可选

node adapters/claude-code/install.mjs --config ~/.claude/settings.json --dry-run
node adapters/claude-code/install.mjs --config ~/.claude/settings.json
# 项目级 MCP（可选）： --mcp-config "$PWD/.mcp.json"
```

### 默认查找 / 卸载

```bash
node adapters/claude-code/install.mjs            # hooks→$CLAUDE_SETTINGS|$CLAUDE_CONFIG_DIR/settings.json|~/.claude/settings.json；MCP→~/.claude.json
node adapters/claude-code/install.mjs --dry-run  # 打印两处目标与将写内容
node adapters/claude-code/install.mjs --uninstall
node adapters/claude-code/install.mjs --help
```

安装后新增两处（两个片段文件分别与写入结构一致）：

`settings.json`（hooks；见 `settings.snippet.json`）：

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
    "SubagentStop":  [{ "hooks": [{ "type": "command", "command": "node", "args": ["<…>/subagent-stop.mjs"] }] }],
    "PreToolUse":    [{ "hooks": [{ "type": "command", "command": "node", "args": ["<…>/busy.mjs"] }] }],
    "PostToolUse":   [{ "hooks": [{ "type": "command", "command": "node", "args": ["<…>/busy.mjs"] }] }],
    "Stop":          [{ "hooks": [{ "type": "command", "command": "node", "args": ["<…>/idle.mjs"] }] }],
    "Notification":  [{ "matcher": "idle_prompt", "hooks": [{ "type": "command", "command": "node", "args": ["<…>/idle.mjs"] }] }]
  }
}
```

MCP 配置（`~/.claude.json` 顶层；见 `mcp.snippet.json`）：

```jsonc
{
  "mcpServers": {
    "agentchat": {
      "type": "http",
      "url": "http://127.0.0.1:4646/mcp",
      "headersHelper": "node \"<仓库绝对路径>/adapters/claude-code/mcp-headers.mjs\""
    }
  }
}
```

> hooks 片段用 exec form（`"command": "node", "args": ["<abs>.mjs"]`）：Claude Code 在 `args` 存在时
> **不经 shell**、把每个元素原样作为参数，跨平台一致（官方 *Exec form and shell form*）。
> `headersHelper` 的命令则经 shell 执行，故用绝对路径（含空格时已被引号包裹）。请确保 `node` 在 `PATH` 上。

## token / 节点 id 位置与陈旧自愈

| 文件 | 位置 | 作用 |
|---|---|---|
| `hub_token` | `<AGENTCHAT_HOME>/hub_token` | 传输门 token；hooks 读环境变量 `HUB_TOKEN`，`mcp-headers.mjs` 读此文件（环境变量优先） |
| `join_token` | `<AGENTCHAT_HOME>/agents/claude-code.token`（0600 尽力而为） | `SessionStart` 重连认领根节点 |
| 节点 agent id | `<AGENTCHAT_HOME>/agents/claude-code.id` | busy/idle 上报与取件归属；**MCP 头 `x-agent-id` 的取值来源**（由 `mcp-headers.mjs` 读取） |

**陈旧自愈（已实现，无需人工）**：Hub DB 重置/切换后，`register` 返回 `invalid_join_token` →
`session-start.mjs` 清空本地 `claude-code.token` → 按「无 token 首次注册」重新注册为新根 → 写回新 token/id。

**手工兜底**（自愈仍失败时）：删除 `<AGENTCHAT_HOME>/agents/claude-code.token`（可视情况连同 `claude-code.id`）
后重启 `claude`；若 id 变化，`mcp-headers.mjs` 会在下次连接重读，无需改配置。

## 手动冒烟清单（**需真实 Claude Code**）

> 以下 ①–⑤ 均须在**安装了真实 Claude Code 的真机**上执行；括号内为观察点。安装器本身的配置写入由单测覆盖。

1. **[ ] 安装并启动**：完成上一节安装（`settings.json` 含 hooks、MCP 配置含 `mcpServers.agentchat`）后，
   在设置了 `HUB_TOKEN` 的终端启动 `claude`。观察 `claude` 无报错、可正常进入会话。
2. **[ ] 节点现身**：`GET /api/roster`（UI 数据面，无需 Bearer）应出现 `vendor` 为 `claude-code` 的节点。
   ```bash
   curl http://127.0.0.1:4646/api/roster
   ```
   首次启动若 MCP 工具报 `identity_required`（`claude-code.id` 当时尚未生成），**重启一次 `claude`** 即可。
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
- `headersHelper` 在真实连接中的调用时机/工作目录，以及它输出的 `Authorization`/`x-agent-id` 是否被完整采纳
  （含 401/403 后重跑 helper 的行为）。
- `stop_hook_active` 的精确置位时机（官方定义为「already continuing as a result of a stop hook」，宿主另设
  8 连续续跑硬上限；本适配器的链内 block 计数依赖该字段，未在真机核对置位边界）。
- `SubagentStop` 与 `Stop` 共用同一 decision control（官方明示），但其 `hookSpecificOutput{ hookEventName:"SubagentStop" }`
  / `decision:"block"` 的**真机**接受情况、以及 `agent_id` 在 `SubagentStart`/`SubagentStop` 间稳定配对性未实测。
- **子节点退役后的再注册**：退役不可复活、Hub 按 `task_ref` 拒绝复活；依赖「Claude Code 每次派生 `agent_id` 唯一」。
  若同 `agent_id` 复用（文档未承诺），该子代理注册会被拒（保守：不误复活已死节点）。
- `SubagentStart` 载荷是否含父/会话关联字段（当前文档只列 `agent_id`/`agent_type`；适配器按「根回合窗口」兜底）。
- `Notification` 的 matcher / `notification_type` 字段命名（按 `idle_prompt` 匹配）。
- `SessionStart` 的 `additionalContext` 真实渲染（仅用 `additionalContext`）。
- Windows 上 `chmod 0600` 权限位实际生效情况（尽力而为）。

## 日志（适配器不向宿主终端输出）

hooks 的诊断/错误日志落 **`<AGENTCHAT_HOME>/logs/claude-code-adapter.log`**
（行格式 `<ISO 时间> <消息>`），**不向宿主终端输出**（hook 退出码恒 0，失败只进日志）。查看：

```bash
tail -f ~/.agentchat/logs/claude-code-adapter.log                   # macOS / Linux
Get-Content -Wait "$HOME\.agentchat\logs\claude-code-adapter.log"  # PowerShell（AGENTCHAT_HOME 未设时即 ~\.agentchat）
```

- **轮转**：单文件 > 1 MiB 时在下一次写入前整体改名 `claude-code-adapter.log.1`（覆盖旧 `.1`，只保留一份）。
- 排障一律看 `<AGENTCHAT_HOME>/logs/*.log`；日志失败静默（绝不影响宿主），日志行绝不含 token 值。
- 安装器（`install.mjs`）在终端的输出属正常：它是**用户主动执行**的 CLI。

## 排障表

> 排障先看日志文件 `<AGENTCHAT_HOME>/logs/claude-code-adapter.log`——**适配器不向宿主终端输出**
> （安装器 CLI 的终端输出除外）。

| 症状 | 可能原因 | 处理 |
|---|---|---|
| hook 完全未触发（日志无新行） | `node` 不在 `PATH`；settings 未被加载；SessionStart matcher 未命中 | 确认 `node -v ≥ 22`；确认写入的是 `claude` 实际读取的 settings；重启 `claude`；手工以空 stdin 跑 `node <abs>/session-start.mjs` 看是否报错；查 `<AGENTCHAT_HOME>/logs/claude-code-adapter.log` |
| MCP 在 `/mcp` 里不存在 / 连接失败 | `mcpServers` 被误写进 `settings.json`（会被静默忽略） | 确认 MCP 条目在 `~/.claude.json` 顶层（或 `--mcp-config` 指定文件）；用 `claude mcp get agentchat` 检查；重跑安装器会拒绝同一文件 |
| `additionalContext` 未生效 | 该 Claude Code 版本不接受 `Stop` 的 `hookSpecificOutput` 组合 | 注入正文已**同文写入 `reason`**（Stop block 必被采纳字段），通常仍可见；否则用 `SessionStart` 兜底拉取（下次启动注入）；升级 Claude Code 复核 |
| 出现权限提示阻断 hook | 组织策略/权限模式禁止 hook 命令执行 | 在受信任目录运行 `claude`；确认未自定义收紧 hook 权限；hook 本身不产出 `permissionDecision`，不会主动拒绝工具 |
| MCP `401 unauthorized` | `mcp-headers.mjs` 未产出 `Authorization`（`hub_token` 缺失/为空，且 `HUB_TOKEN` 未设） | 确认 Hub 已启动并生成 `<AGENTCHAT_HOME>/hub_token`；在启动 `claude` 的环境设 `HUB_TOKEN`；`/mcp` 面板可 Reconnect 触发 helper 重跑 |
| MCP `400 agent_not_found` / 工具报 `identity_required` | `mcp-headers.mjs` 未产出 `x-agent-id`：`claude-code.id` 尚未生成（首次启动）或已变 | 启动一次让 `SessionStart` 写 id，然后**重启 `claude`**（连接时 helper 会重读）；若仍缺，删 token+id 重注册 |
| MCP 头在配置里看不到 token | 设计如此：头由 `headersHelper` 连接时动态产出 | 需要手工核对时直接运行 `node adapters/claude-code/mcp-headers.mjs`，应输出 `{"Authorization":"Bearer …","x-agent-id":"…"}` |
| 回合未在空闲时注入（`Stop` 未 wake） | 已达**该链**内 block 上限 3（同链续跑不再 block） | 预期防死循环：链内 3 次后放行；**新回合/新链自动重置计数、可再次 block**（修复旧版达上限后永久放行导致的「会话永不再被唤醒」）。`delivered` 后下次 `wake` 为空/仅租约重投的重复消息亦自然终止 |
| 子代理未收到待投递 | `SubagentStop` 未注册，或该子代理未注册（`subs.json` 无映射） | 确认 `settings.json` 含 `SubagentStop → subagent-stop.mjs`；子代理须在**会话匹配**的活跃根窗口内派生方可注册；退役不可复活（重派生即新 `agent_id`/新节点） |
| `Notification(idle_prompt)` 未注入 | 设计如此：`Notification` 无注入通道，仅上报 `idle`（避免认领后无法投递而丢消息） | 注入统一由 `Stop` 承担；核对 `Stop` 是否触发 |
| 搬移适配器目录后重复安装留下旧条目 | 归属按**绝对路径**匹配（**不做 basename 兜底**，以免误删用户同名脚本）；旧路径不再被识别 | 搬移前先 `--uninstall`；或手工删除指向旧路径的 hooks 条目后再安装 |
| 重复安装产生重复 hook 条目 | `args[0]` 路径被手工改动致不再命中本适配器绝对路径 | 归属按规范化绝对路径匹配；勿改动 `args` 里的脚本路径；`--uninstall` 后重装 |
| Windows 权限位无效（`claude-code.token` 非 0600） | Windows 上 `chmod` 调用成功但权限位可能不生效 | 非 bug；与 Hub/OpenCode 同策略（尽力而为），依赖本机文件系统 ACL |

## 约束

- 安装器不改动用户无关配置键；重复安装内容等价；`--uninstall` 精确移除本适配器条目。
- 适配器只经 HTTP 契约与 Hub 通信，不 import Hub 的 server 代码；无新增运行时依赖。
- `settings.snippet.json`（hooks）与 `mcp.snippet.json`（MCP）分别与 `install.mjs` 的对应写入结构**一致**。
