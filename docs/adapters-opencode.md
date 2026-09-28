# AgentChat — OpenCode 适配器安装与冒烟

把本机 [OpenCode](https://opencode.ai) 接入 AgentChat Hub。安装器
（`adapters/opencode/install.mjs`）把 **插件条目** 与 **MCP server 条目** 并入用户 OpenCode 配置，
一条命令完成；本文档同时给出**手动冒烟清单**（需真实 OpenCode）与**排障表**。

> 适配器组件（`plugin.ts`、`mcp-bridge.mjs` 等）的事件映射、健壮性与文件职责见
> `adapters/opencode/README.md`。冒烟步骤中标注「需真实 OpenCode」的必须真机执行；
> 安装器的配置写入、桥 ↔ Hub 往返与「真实 OpenCode 能解析新条目」均由测试覆盖。

## 前置

- Node ≥ 22；Hub 已能启动（`npm start`）。首次启动 Hub 会在 `<AGENTCHAT_HOME>/hub_token` 写入传输门 token。
- Hub 数据目录默认 `~/.agentchat`；端口默认 `4646`。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `HUB_TOKEN` | 否 | 自动读磁盘 | 传输门 token **覆盖**：非空时优先。缺省时**插件与 MCP 桥都自动读** `<AGENTCHAT_HOME>/hub_token` —— 通常无需设置 |
| `AGENTCHAT_HOME` | 否 | `~/.agentchat` | 数据目录；`hub_token` 与节点 id 的落盘根（与 Hub 一致） |
| `AGENTCHAT_URL` | 否 | `http://127.0.0.1:<AGENTCHAT_PORT 或 4646>` | Hub 地址；桥与插件据此定位 `/mcp` 与 `/internal/*` |
| `AGENTCHAT_PORT` | 否 | `4646` | 仅用于推导默认 `AGENTCHAT_URL` |
| `AGENTCHAT_MCP_TIMEOUT_MS` | 否 | `30000` | MCP 桥单次上游请求超时（钳制到 `[100, 600000]`，非法值回落默认） |

**token 解析顺序（插件与 MCP 桥一致）**：`env.HUB_TOKEN`（非空优先）→ `<AGENTCHAT_HOME>/hub_token`（trim）
→ 空。安装器不写任何 token，**安装步骤无需 `export HUB_TOKEN`**；两处都拿不到时插件会打明确 warn，调用按
既有 401 路径失败（启动 Hub 会自动写出 `hub_token`）。OpenCode 配置里**不含** `{env:HUB_TOKEN}`，也绝不含 token 明文。

## MCP 接入：本地 stdio 桥（为什么不再是 `remote` + `{file:}`）

旧版安装器把 MCP 写成 `remote`，身份头用 `x-agent-id: {file:…/agents/opencode.id}`，token 用
`{env:HUB_TOKEN}`。这是一个**死锁缺陷**：

- OpenCode 的变量替换在**解析配置前对整份文件原文**执行（`{file:}` 默认缺失即致命）；而
  `opencode.id` **只在插件首次注册成功后**才生成 —— 于是「起不来 → 注册不了 → 文件永不生成」。
  报错形如：`Configuration is invalid … bad file reference … opencode.id does not exist`。
- 更糟：插件对陈旧 token 的自愈曾连同删除该 id 文件，令下次启动再次被砖。
- 调研结论：`{file:}` **不存在**可选/容错语法；`enabled:false` 也**不能**豁免替换（文本级、整文件）；
  插件 `config` hook 同样来不及（替换发生在插件之前）。**唯一彻底解法 = 配置里不再引用任何生成文件。**

因此 MCP 条目改为**本地 stdio 桥**（`adapters/opencode/mcp-bridge.mjs`，由 OpenCode 直接 spawn）：

- 桥把 JSON-RPC 透明转发到 Hub 的 `/mcp`（streamable-HTTP 有状态会话），响应同时支持
  `application/json` 与 `text/event-stream`（SSE）。
- **逐请求从磁盘读取**身份与 token：`Authorization: Bearer <home>/hub_token`；
  `x-agent-id: <home>/agents/opencode.id`（**文件不存在则省略该头**，不报错、不拒绝启动）。
- 会话 id 取自 initialize 响应头 `Mcp-Session-Id` 并在后续请求回带；`404 session_not_found`
  （30min TTL 淘汰 / Hub 重启）→ 自动**重新 initialize 一次**并重试。
- 每次上游请求带**显式超时**（默认 30s，`AGENTCHAT_MCP_TIMEOUT_MS` 覆盖）：Hub「收下却不回」时以
  清晰的 JSON-RPC error 返回，而非让严格的串行链无限阻塞；桥进程保持存活，后续请求照常。
- 环境缺失（Hub 未启动 / token 缺失 / 401 / `400 agent_not_found`）只在**首次工具调用**时以
  清晰的 JSON-RPC error 回给宿主，**桥进程不崩溃、不影响 OpenCode 启动**。

## 安装

安装器支持的目标配置解析顺序（依次）：

1. `--config <path>`（显式；父目录缺失/文件不存在 → 明确报错，退出码 1）
2. `$OPENCODE_CONFIG`
3. `$XDG_CONFIG_HOME/opencode/`（未设则 `~/.config/opencode/`）下按序取 `opencode.jsonc` → `opencode.json`
   首个存在者；都没有 → 报错并提示用 `--config`

写入策略：改动前先备份 `<config>.bak`，再以**临时文件 + rename 原子替换**；`--dry-run` 只打印不落盘。
幂等：重复安装内容等价；`--uninstall` 只精确移除本适配器条目，保留用户其它键（含注释安全的 JSONC 解析，
但改写后的活动文件为标准 JSON——原文可在 `.bak` 找回）。

**MCP 条目所有权守卫**：写入前对既有 `mcp.agentchat` 做结构比对：

- 结构与本安装器将写入的一致 → 幂等无改动；
- 是本适配器**旧产物**（`remote` + `/mcp` + `x-agent-id` 为 `{file:…agents/opencode.id}`，或本地桥条目）
  → **无需 `--force`** 就地替换/移除，并在 stdout 提示「已从会砖的旧结构迁移」；
- 结构不同的**用户自有**同名条目 → **拒绝并给非 0 退出码**（除非 `--force`）。

### PowerShell（Windows）

```powershell
# 1) 运行 Hub，使其写出 token
npm start   # 另开一个终端；启动后 Ctrl+C 或保持运行

# 2) 安装（安装器不需要 HUB_TOKEN；--dry-run 先预演）
node adapters/opencode/install.mjs --config "$HOME\.config\opencode\opencode.jsonc" --dry-run
node adapters/opencode/install.mjs --config "$HOME\.config\opencode\opencode.jsonc"
```

### POSIX（macOS / Linux）

```bash
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
      "type": "local",
      "command": ["<安装时的 node 绝对路径>", "<仓库绝对路径>/adapters/opencode/mcp-bridge.mjs"],
      "enabled": true
      // environment 仅在设置了非默认的 AGENTCHAT_HOME/AGENTCHAT_URL/AGENTCHAT_PORT 时写入（只放非机密值）
    }
  }
}
```

> `command[0]` 用安装时的 `process.execPath` 绝对路径。**换 node / 升级 node 后需重跑安装器**
> 以刷新该路径，否则 OpenCode 可能 spawn 失败。

## 从旧结构迁移

若配置里曾是旧版产物（`remote` + `{file:…opencode.id}`），直接重跑安装器即可，**无需 `--force`**：

```bash
node adapters/opencode/install.mjs          # stdout: 已从会砖的旧结构…迁移为本地 stdio 桥
node adapters/opencode/install.mjs --uninstall   # 旧结构同样可被精确移除
```

安装器按「url 以 `/mcp` 结尾 + `headers.x-agent-id` 为 `{file:…agents/opencode.id}`」识别旧结构，
从而把用户从「无法卸载、无法启动」中解放出来。

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
| `hub_token` | `<AGENTCHAT_HOME>/hub_token` | Hub 传输门 token：**插件与 MCP 桥都自动读盘**（`HUB_TOKEN` 非空时覆盖插件侧） |
| `join_token` | `<AGENTCHAT_HOME>/agents/opencode.token`（0600 尽力而为） | 重连认领根节点（`register` 的 `join_token`） |
| 节点 agent id | `<AGENTCHAT_HOME>/agents/opencode.id` | 桥逐请求读作 `x-agent-id`（文件缺失仅省略该头，不影响启动） |

**陈旧自愈（已实现，无需人工）**：Hub DB 重置/切换后，`register` 返回 `invalid_join_token` →
插件清空本地 `opencode.token` 后按「无 token 首次注册」重新注册为新根 → 写回新 token/id，日志给明确 warn。
**自愈不再删除 `opencode.id`**（注册成功后会覆盖为正确 id；保留它以打断「删除→下次启动被砖」的连锁）。

**手工兜底**（自愈仍失败时）：删除 `<AGENTCHAT_HOME>/agents/opencode.token` 后重启 OpenCode（勿删 id 亦可）。

## 手动冒烟清单（需真实 OpenCode）

1. **启动 Hub**（`npm start`），确认 `<AGENTCHAT_HOME>/hub_token` 已生成。
2. **启动 OpenCode**（进程环境里带 `HUB_TOKEN`，供**插件**注册/唤醒用）。首个会话建立时插件注册节点并写
   `<AGENTCHAT_HOME>/agents/opencode.id`。MCP 桥下次调用即读到该 id，**无需重启**。
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
| MCP 工具调用报「读不到 Hub 传输门 token（…hub_token）」 | Hub 还没写过 `hub_token`（未启动或 `AGENTCHAT_HOME` 不一致） | 先 `npm start` 启动 Hub；确认 `AGENTCHAT_HOME` 与 Hub 一致（桥会逐请求重读，启动 Hub 后重试即可，无需重启 OpenCode） |
| 插件注册 `401` / 节点始终不出现 | `HUB_TOKEN` 与 `<AGENTCHAT_HOME>/hub_token` 都缺失或与 Hub 不一致 | 确认 `AGENTCHAT_HOME` 与 Hub 一致并先启动 Hub 写出 `hub_token`；插件按 `env.HUB_TOKEN` → `<home>/hub_token` 解析，两者皆空时日志会打明确 warn |
| MCP 工具调用报「401 unauthorized」 | 磁盘 `hub_token` 与 Hub 的 token 不一致（换了 `AGENTCHAT_HOME`/重置过 Hub） | 用 Hub 当前 `<AGENTCHAT_HOME>/hub_token` 覆盖；桥逐请求读盘，改对后重试即可 |
| MCP 工具调用报「请求 Hub 超时」 | Hub 收下请求却不回（卡住） | 默认 30s 超时并回 JSON-RPC error（不阻塞后续请求）；可用 `AGENTCHAT_MCP_TIMEOUT_MS` 调大 |
| MCP `400 agent_not_found` | `agents/opencode.id` 陈旧或尚未注册 | 删除 `agents/opencode.id`，让插件重新注册写入；桥逐请求读盘，无需重启 |
| MCP 会话 `session_not_found` | 30min TTL 淘汰 / Hub 重启清空会话表 | **桥会自动重新 initialize 并重试一次**；一般无需人工干预 |
| MCP 命令找不到 / 启动失败 | 换过 node 或升级后旧 `command[0]` 失效 | **重跑安装器**刷新 node 绝对路径 |
| 插件未注册 / 节点不在 `GET /api/roster` | 插件未加载 / 导出形态不符 / token 未解析到 | 确认 `plugin` 含本目录且默认导出 `{id,server}`；确认 `AGENTCHAT_HOME` 与 Hub 一致（插件自动读 `<home>/hub_token`，也可用 `HUB_TOKEN` 覆盖）；查 OpenCode 日志中 `[agentchat-opencode]` 前缀行 |
| 空闲未被唤醒（idle 未触发） | 宿主未发 `session.idle`/`session.status`（版本差异） | 核对 `@opencode-ai/plugin` 版本（实测 1.18.32）；`session.idle` 是主要触发，`session.status` 仅补 busy 起点 |
| 回信似乎「开了新回合」 | 注入走 `client.session.promptAsync`，会开启新回合（符合「唤醒即续跑」语义） | 预期行为：busy 期间到达的消息会在**下一次 idle** 才被认领注入 |
| 子节点在 roster 中长期残留 | 退役依赖宿主发 `session.deleted`（子会话）事件 | 子会话删除时插件调 `/internal/retire`（幂等；`404` 视为已退役）；若宿主版本不发该事件则节点留待下一次清理（已知限制，见 `adapters/opencode/README.md` 健壮性） |

## 约束

- 安装器不改动用户无关配置键；重复安装内容等价；`--uninstall` 精确移除本适配器条目（含旧结构），
  仅在结构匹配本安装器产物或可识别为本适配器旧产物时才移除，否则保留用户自有条目并提示；
  覆盖结构不同的**用户自有** `mcp.agentchat` 需显式 `--force`。
- 配置里**不含任何 `{file:}` 引用与机密**；token 由桥逐请求从磁盘读取。
- 适配器只经 HTTP 契约与 Hub 通信，不 import Hub 的 server 代码；无新增运行时依赖。
