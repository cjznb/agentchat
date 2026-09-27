# AgentChat — OpenCode 适配器安装与冒烟

把本机 [OpenCode](https://opencode.ai) 接入 AgentChat Hub。安装器
（`adapters/opencode/install.mjs`）把 **插件条目** 与 **MCP server 条目** 并入用户 OpenCode 配置，
一条命令完成；本文档同时给出**手动冒烟清单**（需真实 OpenCode）与**排障表**。

> 适配器组件（`plugin.ts` 等）的事件映射、健壮性与文件职责见 `adapters/opencode/README.md`。
> 冒烟步骤中标注「需真实 OpenCode」的必须真机执行；`install.mjs` 的配置写入由单测覆盖。

## 前置

- Node ≥ 22；Hub 已能启动（`npm start`）。首次启动 Hub 会在 `<AGENTCHAT_HOME>/hub_token` 写入传输门 token。
- Hub 数据目录默认 `~/.agentchat`；端口默认 `4646`。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `HUB_TOKEN` | **是** | — | Hub 传输门 token，取 `<AGENTCHAT_HOME>/hub_token` 的内容。插件与 OpenCode 的 MCP 身份头都用它 |
| `AGENTCHAT_HOME` | 否 | `~/.agentchat` | 数据目录；`join_token`/节点 id 的落盘根（与 Hub 一致） |
| `AGENTCHAT_URL` | 否 | `http://127.0.0.1:<AGENTCHAT_PORT 或 4646>` | Hub 地址；安装器用它推导 MCP `url` |
| `AGENTCHAT_PORT` | 否 | `4646` | 仅用于推导默认 `AGENTCHAT_URL` |

`HUB_TOKEN` 必须在**启动 OpenCode 的进程环境**里设置（插件读 `process.env`；MCP 头用 `{env:HUB_TOKEN}` 解析）。

## 安装

安装器支持的目标配置解析顺序（依次）：

1. `--config <path>`（显式；父目录缺失/文件不存在 → 明确报错，退出码 1）
2. `$OPENCODE_CONFIG`
3. `$XDG_CONFIG_HOME/opencode/`（未设则 `~/.config/opencode/`）下按序取 `opencode.jsonc` → `opencode.json`
   首个存在者；都没有 → 报错并提示用 `--config`

写入策略：改动前先备份 `<config>.bak`，再以**临时文件 + rename 原子替换**；`--dry-run` 只打印不落盘。
幂等：重复安装内容等价；`--uninstall` 只精确移除本适配器条目，保留用户其它键（含注释安全的 JSONC 解析，
但改写后的活动文件为标准 JSON——原文可在 `.bak` 找回）。
**MCP 条目所有权守卫**：写入前对既有 `mcp.agentchat` 做结构比对——仅当结构与本安装器将写入的一致才覆盖；
结构不同则**拒绝并给非 0 退出码**（除非 `--force`）。`--uninstall` 仅当结构匹配本安装器产物时才移除该键，否则保留并提示。

### PowerShell（Windows）

```powershell
# 1) 运行 Hub，使其写出 token
npm start   # 另开一个终端；启动后 Ctrl+C 或保持运行

# 2) 导出环境变量（当前终端）
$env:AGENTCHAT_HOME = "$HOME\.agentchat"
$env:HUB_TOKEN = (Get-Content "$HOME\.agentchat\hub_token" -Raw).Trim()
$env:AGENTCHAT_URL = "http://127.0.0.1:4646"   # 可选，默认即此

# 3) 预演（只打印将写内容），确认无误后去掉 --dry-run
node adapters/opencode/install.mjs --config "$HOME\.config\opencode\opencode.jsonc" --dry-run
node adapters/opencode/install.mjs --config "$HOME\.config\opencode\opencode.jsonc"
```

### POSIX（macOS / Linux）

```bash
export AGENTCHAT_HOME="$HOME/.agentchat"
export HUB_TOKEN="$(cat "$AGENTCHAT_HOME/hub_token")"
export AGENTCHAT_URL="http://127.0.0.1:4646"   # 可选

node adapters/opencode/install.mjs --config ~/.config/opencode/opencode.jsonc --dry-run
node adapters/opencode/install.mjs --config ~/.config/opencode/opencode.jsonc
```

### 默认查找 / 卸载

```bash
node adapters/opencode/install.mjs            # 自动查 $OPENCODE_CONFIG 或 ~/.config/opencode/opencode.jsonc|json
node adapters/opencode/install.mjs --dry-run
node adapters/opencode/install.mjs --uninstall
node adapters/opencode/install.mjs --help
```

安装后配置里新增两处（键名 `agentchat`）：

```jsonc
{
  "plugin": [ /* 既有插件… */ "<仓库绝对路径>/adapters/opencode" ],
  "mcp": {
    "agentchat": {
      "type": "remote",
      "url": "http://127.0.0.1:4646/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer {env:HUB_TOKEN}",
        "x-agent-id": "{file:~/.agentchat/agents/opencode.id}"
      }
    }
  }
}
```

## 插件导出形态（OpenCode 期望）

OpenCode 1.18.32 的加载器（`packages/opencode/src/plugin/index.ts` + `shared.ts`）**只读模块的
`default` 导出**，要求它是含 `server()` 函数的记录；且**本地路径插件必须带 `id`**。故 `plugin.ts`
默认导出 `PluginModule`：

```ts
export default { id: "agentchat", server: AgentChatPlugin }
```

（`AgentChatPlugin` 命名导出保留；仅加命名 `server` 别名**不足以**被 v1 探测识别，加载器不读命名导出。）

## token / 节点 id 位置与陈旧自愈

| 文件 | 位置 | 作用 |
|---|---|---|
| `join_token` | `<AGENTCHAT_HOME>/agents/opencode.token`（0600 尽力而为） | 重连认领根节点（`register` 的 `join_token`） |
| 节点 agent id | `<AGENTCHAT_HOME>/agents/opencode.id` | OpenCode MCP 的 `x-agent-id` 身份头（`{file:…}` 引用） |

**陈旧自愈（已实现，无需人工）**：Hub DB 重置/切换后，`register` 返回 `invalid_join_token` →
插件清空本地 `opencode.token`（连同 `opencode.id`）→ 按「无 token 首次注册」重新注册为新根 → 写回新 token/id，日志给明确 warn。

**手工兜底**（自愈仍失败时）：删除 `<AGENTCHAT_HOME>/agents/opencode.token`（连同 `opencode.id`）后重启 OpenCode。

## 手动冒烟清单（需真实 OpenCode）

1. **启动 Hub**（`npm start`），确认 `<AGENTCHAT_HOME>/hub_token` 已生成。
2. **启动 OpenCode**（在已设置 `HUB_TOKEN` 的终端）。首个会话建立时插件注册节点并写 `<AGENTCHAT_HOME>/agents/opencode.id`。
   若本次 MCP server 因身份头尚无可解析的 id 而失败（见排障 `agent_not_found`），**重启一次 OpenCode**。
3. **核对节点现身**（`/api/roster` 为 UI 数据面，无需 Bearer）：

   ```bash
   curl http://127.0.0.1:4646/api/roster
   ```

   响应树中应出现 `vendor` 为 `opencode` 的节点。
4. **从 UI 或另一节点发消息/ask**：在 Hub Web UI 选中该节点发送，或用另一 agent 的 MCP `send`/`ask` 指向它。
5. **观察「空闲被唤醒并回信」**：目标空闲（`session.idle`）时插件拉取积压消息并注入会话，节点处理后可
   经 MCP `send` 回信。节点的 `busy`/`idle` 经 **`GET /api/roster`** 观测（`/internal/state` 是适配器→Hub
   的 **POST-only** 上报端点，不能 GET）；消息的**四级回执**为 `queued→sending→delivered→read`
   （契约 `shared/contracts.ts` / spec §6.3；`read` 仅在收件方显式 `ack` 后触发，失败态
   `refused`/`expired`/`cancelled` 回落 `queued`；用 `message_status` 工具或 Web UI 气泡下的回执查看）。

## 排障表

| 症状 | 可能原因 | 处理 |
|---|---|---|
| MCP 连接 `401 unauthorized` | `HUB_TOKEN` 未设置/错误（MCP 头 `Bearer {env:HUB_TOKEN}` 解析为空） | 在启动 OpenCode 的终端 `export HUB_TOKEN="$(cat <AGENTCHAT_HOME>/hub_token)"`（Windows 用 `$env:HUB_TOKEN=(Get-Content …).Trim()`）后重启 |
| MCP `400 agent_not_found` | `x-agent-id` 指向的 id 不存在：`agents/opencode.id` 缺失（首次启动尚未生成）或陈旧 | 启动一次让插件注册并写 id，然后**重启 OpenCode**；仍不行则删 `agents/opencode.token`+`agents/opencode.id` 后重启 |
| `/mcp` `404 session_not_found` | MCP 会话被 30min TTL 淘汰，或 Hub 重启后会话表清空 | 重启 OpenCode 重建会话 |
| 注册 `invalid_join_token` | Hub DB 重置/更换 `AGENTCHAT_HOME`，本地 token 陈旧 | 插件已自愈（清 token 重注册）；若仍失败手工删 `<AGENTCHAT_HOME>/agents/opencode.token` 后重启 |
| 节点不在 `GET /api/roster` | 插件未加载 / 导出形态不符 / 注册网络失败 | 确认 OpenCode 配置 `plugin` 含本目录且 `plugin.ts` 默认导出 `{id,server}`；查 OpenCode 日志中 `[agentchat-opencode]` 前缀行 |
| 空闲未被唤醒（idle 未触发） | 宿主未发 `session.idle`/`session.status`（版本差异） | 核对 `@opencode-ai/plugin` 版本（实测 1.18.32）；`session.idle` 是主要触发，`session.status` 仅补 busy 起点 |
| 回信似乎「开了新回合」 | 注入走 `client.session.promptAsync`，会开启新回合（符合「唤醒即续跑」语义） | 预期行为：busy 期间到达的消息会在**下一次 idle** 才被认领注入 |
| 401/404 无重试 | 确定性错误按设计不重试、记录并降级（仅 5xx/429/网络错误指数退避） | 修正配置后重启；非 bug |
| 子节点在 roster 中长期残留 | 退役依赖宿主发 `session.deleted`（子会话）事件 | 子会话删除时插件调 `/internal/retire`（幂等；`404` 视为已退役、不报错）；若宿主版本不发该事件则节点留待下一次清理（已知限制，见 `adapters/opencode/README.md` 健壮性） |

## 约束

- 安装器不改动用户无关配置键；重复安装内容等价；`--uninstall` 精确移除本适配器条目（`mcp.agentchat` 仅在结构匹配本安装器产物时移除，否则保留用户自有条目并提示）；覆盖结构不同的既有 `mcp.agentchat` 需显式 `--force`。
- 适配器只经 HTTP 契约与 Hub 通信，不 import Hub 的 server 代码；无新增运行时依赖。
