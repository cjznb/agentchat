# 贡献指南（Contributing）

AgentChat 是聊天软件式的多 Agent 聊天中枢：Hub 后端 + Web UI + 厂商适配器（OpenCode / Claude Code）。
本指南面向**在本仓提交改动**的贡献者：先读懂架构地图与硬约束，再按工作流实现与提交。

> 用户视角的安装与用法见 [README.md](README.md)；设计规格在 `docs/superpowers/specs/`（**内部文档，不入库**）。

## 架构地图

```
server/        Hub（后端）：HTTP + WebSocket + MCP，唯一权威
client/        Web UI：React 三栏界面（Vite 构建）
shared/        契约单一来源（前后端/Hub 共享）
adapters/      进程外 pull 适配器 + 一键安装器（opencode / claude-code）
bin/           `agentchat` CLI 启动器 / reset
tests/         integration / unit / e2e
```

### `server/` — Hub

- **入口**：`main.ts`（生产入口 `bootstrap()`：开库 → 起 `Dispatcher` → 监听 → 优雅关停）；`index.ts` 的 `createApp()` / `start()` 供测试单独使用（**不在其中启动 dispatcher**，否则反复调用会把 interval/备份打进临时库）。
- **核心**：`core/`（`messaging`、`dispatcher`、`publish`、`roster`、`ask`、`respond`、`permissions`、`revoke`、`wait`、`agents`、`ui-queries`）；`ws.ts` 负责 WebSocket 帧。
- **存储**：`store/`（`messages`、`conversations`、`agents`、`approvals`、`notifications`、`read_states`、`wake`、`wake-claims`）+ `schema.sql`（SQLite / better-sqlite3）。
- **路由**：`routes/`（`ui` = `/api/*`、`mcp` = `/mcp`、`internal` = `/internal/*`、`notifications`、`admin`）。
- **MCP 工具实现**：`mcp/`（`tools`、`read-tools`、`ask-tools`、`context`）。
- **配置**：`config.ts`（env > `<AGENTCHAT_HOME>/config.json` > 默认）。

### `client/` — React 三栏 UI

图标 rail ｜ 会话列表（折叠层级 + 双层未读）｜ 右视图（聊天流 + 四级回执 + 审批/批示卡、组织树、通知中心、喊话、设置）。
`src/reducers/` 汇总 WS 帧到状态；`src/ws.ts` 连接与重连；组件在 `src/components/`。构建产物 `client/dist/` 由 Hub 托管。

### `shared/contracts.ts` — **契约的单一来源**

任何跨边界类型都从这里派生，**不得在别处另起枚举**：

- **WS 四事件封套**：`WS_EVENT_TYPES = ["message", "receipt", "agent", "approval"]`（另有 `resync` 服务端重同步帧）。
- **四级回执**：`RECEIPT_STAGES = ["queued", "sending", "delivered", "read"]`。
- **MCP 12 工具**：`MCP_TOOLS`（`register` + 十一个业务工具），配 zod schema（入参/出参）。

### `adapters/` — 进程外适配器

Hub **不主动推送**；适配器在 agent 空闲时**主动拉取**（pull）。`opencode/`（插件 + 本地 stdio MCP 桥）与 `claude-code/`（hooks + MCP 配置）各含**幂等一键安装器** `install.mjs`。

### `tests/`

`unit/`（纯逻辑）、`integration/`（真库/真 HTTP/真子进程）、`e2e/`（Playwright 端到端）。适配器单测贴在被测目录的 `__tests__/`。

## 本地开发

```bash
npm install
npm start      # Hub（tsx server/main.ts，http://localhost:4646）
npm run dev    # 终端 B：Vite 开发服务器（前端热更，/api /mcp /internal 代理到 Hub）
npm run build  # 构建前端到 client/dist（npm start 从该目录托管静态页）
```

一行命令（可选）：`npm link` 后可用 `agentchat`（缺产物时自动构建 → 起 Hub → 交互式终端开浏览器）；
`agentchat reset [--yes]` 恢复出厂设置（详见 README）。数据目录默认 `~/.agentchat`，可用 `--home` / `AGENTCHAT_HOME` 隔离。

## 质量门（提交前**必须全绿**）

| 命令 | 作用 | 备注 |
|---|---|---|
| `npm test` | 全部单测/集成测（vitest） | 0 失败 |
| `npm run typecheck` | `tsc --noEmit`（server + adapters）+ client | 0 错误 |
| `npm run build` | 前端生产构建 | 0 错误 |
| `npx playwright test` | E2E（本机手跑 / 可选） | 见下 |

**E2E**：`npx playwright test` 需要 **4646 端口空闲**，并会**自举一个临时 `AGENTCHAT_HOME`**（`playwright.config.ts` 用 `os.tmpdir()` 下的隔离目录，**绝不触碰真实 `~/.agentchat`**）。CI 不跑 E2E（见 `.github/workflows/ci.yml` 注释）。

## 硬约束（本仓红线）

- **单文件 ≤ 250 纯行**（非空、非注释）；超限先拆分再合并。
- **禁** `as any` / `@ts-ignore` / `@ts-expect-error`；不许用宽泛类型掩盖契约。
- **`MCP_TOOLS` 恒为 12**：**不新增 MCP 工具**（扩围走独立设计评审）。
- **WS 四事件封套与四级回执不改枚举**：新增语义用载荷字段/新事件类型需先讨论；改 `shared/contracts.ts` 一律先评审。
- **无新依赖需先讨论**：默认不加运行时依赖（CI 只用官方 actions）。
- **文案**：统一用「聊天软件式」；**不得出现任何第三方即时通讯品牌名**（评审 checklist 明确列出禁用词，本文档不复述以免误用）。
- **一任务一提交**：提交描述写清「做了什么 / 为什么」。
- **安装器**：必须**幂等**，且支持 `--dry-run` 与 `--uninstall`。

## 工作流

1. 从 `master` 切分支 → 实现（先写失败测试）→ 本地跑质量门 → 提交。
2. **改适配器**：同步更新对应 `docs/adapters-opencode.md` / `docs/adapters-claude-code.md`（token 位置、自愈、日志、排障等都在这两份文档）。
3. **改契约**（`shared/contracts.ts`）：确认契约测试同步，并复核 UI/适配器消费方。
4. PR 目标分支 `master`；CI（Node 22 / 24 矩阵）必须全绿。

## 安全模型（务必知悉）

本仓是**本机单用户、loopback 信任边界**的 MVP，安全的信任根是「进程与本地文件系统」，**不是**网络或身份层：

- `HUB_TOKEN` 只是 `/mcp` 与 `/internal/*` 的**传输门**；loopback 本地进程可读。
- `x-agent-id` 是**建议性身份**，服务端不校验其与 `join_token` 的绑定；审批闸门**不是安全边界**。
- **请勿把 Hub 暴露到非可信网络**（LAN 认证在后续计划中）。
- **`~/.agentchat` 是本地数据目录，绝不提交任何 token / 密钥 / 数据库**（`.gitignore` 已覆盖 `*.db`、`logs/`、`.env` 等）。

## 许可与参考实现

MIT（见 [LICENSE](LICENSE)）。借鉴第三方实现须遵守 spec 第 3 节（仅复用有明确许可的项目源码）。
