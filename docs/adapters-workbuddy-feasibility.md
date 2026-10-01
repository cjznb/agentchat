# WorkBuddy 接入 AgentChat：适配器插件可行性分析

> 读者：决定"要不要为 WorkBuddy 写第四个适配器"的人。  
> 方法：严格按 [`docs/adapters-guide.md`](./adapters-guide.md) §3 的**五问**逐条取证，答到"文件路径 / 文档 URL"级别；  
> 再映射 §3.1 能力矩阵、§4 实现骨架、§7 事故表、§9 验收表。  
> 结论先行，证据在后，最后给动工前的 spike 清单（指南 §10 第 4 条要求：**不要用文档猜 API**）。



---

## 0. 结论速览

| 维度           | 结论                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **可行性**      | **高**。WorkBuddy 的扩展模型是 **Claude Code 的超集**（插件清单同名、hooks 语义同源、并额外支持 `PreToolUse.modifiedInput` 改写工具入参）                                                                               |
| **在决策树中的位置** | 指南 §3"决策树"**分支 2（只有一次性 hook → hooks + 注入式 hook）**，但落在**该分支天花板的上沿**——`Stop` hook 能"阻止停止并继续对话"、`PreToolUse` 能改写入参，**且宿主另有内建 cron 兜住空窗期**                                              |
| **入站投递**     | ✅ **回合边界**：`Stop` 注入即**继续起一轮**（不等用户下次输入）；✅ **完全空闲期**：`CronCreate` 定时把 prompt 注入会话并起一轮（§1.4 / §3.5）                                                                                  |
| **出站逐会话身份**  | ✅ 可做到**精确**（`PreToolUse.modifiedInput` + 本地桥剥头 → `x-agentchat-session`），与 OpenCode 同档，**优于 DSH**                                                                                    |
| **空闲期唤醒**    | ✅ **可行（关键修正）**：WorkBuddy 内建**会话级 cron 调度器**（`CronCreate` / `CronDelete` / `CronList` / `/loop`），到点会把 `prompt` 经 `enqueuePrompt()` **注入当前会话并起一轮**。故"完全空闲期收消息"**不必依赖 hook 事件**，见 §1.4 |
| **主要代价**     | ⚠️ 轮询唤醒**每次触发都要花一个模型回合**；`CronCreate` 的 recurring 任务**3 天后自动过期**需续订；**会话未加载 / 应用退出时不触发**                                                                                            |
| **工作量**      | 中等。与 `adapters/claude-code/` **同量级**，比 `adapters/opencode/` 略少（无需 JSONC 配置合并），比 `adapters/dsh/` 少很多（无需 bundle/patch/YAML）                                                           |
| **建议**       | **值得做**，但先花半天跑完 §8 的 8 个 spike（否则会在"第三方插件 hooks/cron 在桌面端到底会不会触发"上翻车）                                                                                                               |

一句话：**这不是"能不能"的问题，而是"照 Claude Code 那条路走、用 `CronCreate` 补上空窗、并顺手把 DSH 丢失的逐会话身份补回来"的问题。**

---

## 1. 事实依据：WorkBuddy 的扩展模型

### 1.1 插件模型（与 CodeBuddy / Claude Code 同构）

插件清单固定为 `.codebuddy-plugin/plugin.json`，一个插件可携带的组件：

| 位置                              | 用途                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `.codebuddy-plugin/plugin.json` | 清单（`name` / `version` / `description` / `hooks` / `skills` / `commands` / `agents`） |
| `hooks/hooks.json`              | **事件处理器 ← 本项目的主战场**                                                                 |
| `.mcp.json`                     | MCP 服务器（可声明 stdio 本地进程）                                                             |
| `skills/` `commands/` `agents/` | 技能 / 斜杠命令 / 子代理                                                                     |
| `bin/`                          | 启用后加入 Bash 工具 `PATH` 的可执行文件                                                         |
| `settings.json`                 | 默认设置（目前仅 `agent` 键）                                                                 |
| `.lsp.json`                     | LSP 服务器（长驻进程）                                                                       |

**本机实证**（内置插件就是模板）：

- `D:\Program Files\WorkBuddy\...\workbuddy-builtin\builtin-plugins\tencent-docx\.codebuddy-plugin\plugin.json`  
  → 同时声明了 `"hooks": "./hooks/hooks.json"`、`skills`（8 个）、`agents`（3 个）
- `...\builtin-plugins\sheetagent\.codebuddy-plugin\plugin.json`  
  → `commands` + `skills` + `hooks` + **`mcpServers`（内联 stdio MCP）**
- `...\builtin-plugins\subscription-gate\hooks\hooks.json`  
  → **`PreToolUse`（matcher=`Skill`）+ `UserPromptSubmit` + `UserPromptExpansion`**，实测是**付费技能门控**，说明 pre-hook 在桌面端**真实生效**
- `...\mcps\miora-mcp\.codebuddy-plugin\plugin.json` + `.mcp.json`  
  → `${CODEBUDDY_PLUGIN_ROOT}` / `${CODEBUDDY_PLUGIN_DATA}` 占位符证明**插件根目录与数据目录是受支持的一等公民**

### 1.2 Hook 模型（决定性的一节）

**事件与行为**（来自 CodeBuddy Hooks Reference，WorkBuddy 同源）：

| 事件                                                                                                      | 能否阻塞             | 能否注入上下文                                   | 对适配器的价值                                      |
| ------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------- | -------------------------------------------- |
| `SessionStart`                                                                                          | —                | 显示给用户                                     | ✅ 注册实例+会话节点、**补拉**                           |
| `UserPromptSubmit`                                                                                      | ✅ 可拦 prompt      | 显示给用户                                     | ✅ 会话存活心跳 + 补拉                                |
| `PreToolUse`                                                                                            | ✅ allow/deny/ask | `modifiedInput` **改写入参**                  | ⭐ **逐会话出站身份的唯一实现路径**                         |
| `PostToolUse`                                                                                           | ❌（已执行）           | `additionalContext` / `updatedToolOutput` | 兜底注入通道                                       |
| **`Stop`**                                                                                              | ✅ **阻止停止并继续对话**  | **`stopReason` 送达 Agent**                 | ⭐⭐ **入站唤醒的唯一主入口**                            |
| `SubagentStop`                                                                                          | ✅                | 送达子代理                                     | 子代理节点建模                                      |
| `Notification`                                                                                          | ❌                | 仅显示给用户                                    | ✅ `notification_type=idle_prompt` → **空闲信号** |
| `PermissionRequest` / `SessionEnd` / `PreCompact` / `PostCompact` / `Worktree*` / `unstable_Checkpoint` | 部分               | 部分                                        | 生命周期辅助                                       |

**I/O 契约**（关键原文级事实）：

- 输入：stdin JSON，公共字段 `session_id` / `transcript_path` / `cwd` / `hook_event_name`；`Stop` 额外带 `stop_hook_active`；本机脚本  
  `...\sheetagent\hooks\save-on-subagent-stop.mjs` 就按 `payload.hook_event_name` / `payload.stop_hook_active` 取值——**与 Claude Code 完全一致**。
- 输出：stdout JSON
  ```json
  { "continue": false, "stopReason": "注入正文", "systemMessage": "…",
    "hookSpecificOutput": { "hookEventName": "PreToolUse",
                            "permissionDecision": "allow|deny|ask",
                            "modifiedInput": {"…":"…"} } }
  ```
- **两条等价的注入向量**（`Stop`）：
  1. `{"continue": false, "stopReason": "<正文>"}` → 阻止停止、把正文交给 Agent、**继续对话**；
  2. 退出码 `2` + stderr → **stderr 注入到下一条消息**（指南 §4.5 的"正文同时镜像进两个通道"纪律在此适用）。
- 环境变量：`CLAUDE_PROJECT_DIR`、`CODEBUDDY_PROJECT_DIR`（兼容 Claude Code 命名）+ 插件侧 `CODEBUDDY_PLUGIN_ROOT`。
- 配置落点：用户级 `~/.codebuddy/settings.json`、项目级 `<proj>/.codebuddy/settings.json`；**插件 `hooks/hooks.json` 在插件启用时自动合并**，且**不受 `allowUntrustedFrontmatterHooks` 安全闸门约束**（闸门只作用于 Skill/Agent frontmatter 里声明的 hooks）——对安装器是重大利好。

**桌面端真实触发**：第三方探针实测（让 WorkBuddy 在真实工程里改代码，打满整条生命周期）确认  
`SessionStart` ✅ / `UserPromptSubmit` ✅ / `PreToolUse` ✅（100+ 次）/ `PostToolUse` ✅ / `PermissionRequest` ✅ / `Notification` ✅ / **`Stop` ✅**，  
payload 含 `session_id` / `transcript_path` / `tool_name` / `tool_input` / `call_id` / `last_assistant_message`。

> 即：文档列了 26 个事件不代表都会触发，但**适配器真正依赖的 3 个（SessionStart / UserPromptSubmit / Stop）+ 1 个（PreToolUse）已实测触发**。

### 1.3 MCP 与本地落点

- 插件 `.mcp.json` 声明的 stdio MCP **由宿主拉起为长驻子进程**，生命周期≈会话生命周期——这是本方案唯一的"准常驻"组件。
- WorkBuddy 桌面端数据目录（本机实测）：
  ```
  ~/.workbuddy/plugins/cache/<marketplace>/<plugin>/<version>/     ← 安装落地
  ~/.workbuddy/plugins/known_marketplaces.json                     ← 已注册市场（支持 "type":"directory" 本地目录市场）
  ~/.workbuddy/plugins/installed_plugins.json                      ← 已安装清单
  ~/.workbuddy/plugins/marketplaces/<market>/.../.codebuddy-plugin/marketplace.json
  ~/.workbuddy/plugins/configured-plugins.json                     ← 内置市场插件索引
  ~/.workbuddy/settings.json  →  { "enabledPlugins": { "<plugin>@<market>": true } }
  ```
- 市场清单格式（`marketplace.json`）：`{ name, owner, plugins: [{ name, source, version, description }] }`；  
  `known_marketplaces.json` 里 `workbuddy-builtin` 的 `"type": "directory"` 证明**本地目录型市场受支持**。
- 既有 agentchat 适配器**无需 import `server/**`** 的前提在这里同样成立：插件只经 **HTTP `/internal/*` + MCP `/mcp`** 与 Hub 通信。

### 1.4 ⭐ 空闲期唤醒：内建会话级 cron（本方案的关键一环）

这&#x662F;**"不能主动推送"这一前提的正面反例**。WorkBuddy 的 agent 运行时里有一个会话级 cron 调度器，源码级证据（`cli/dist/codebuddy-lite-wb.mjs`）：

```js
// 每个会话创建一个 cron 调度器；到点 → 把 prompt 塞进当前会话
createCronScheduler({
  sessionId,
  onFire:      t => { enqueuePrompt(t) },              // ← 注入并起一轮
  onFireTask:  (t, i) => enqueuePrompt(t.prompt, t, i),
  isLoading:   () => state === AGENT_RUNNING | MODEL_REQUESTING | MODEL_STREAMING | MODEL_DONE,
  isKilled:    () => session.aborted,
  lockIdentity:{ sessionId, pid },                      // 跨进程文件锁，多进程只跑一个
})
```

**`CronCreate` 工具契约**（源码 zod schema 原文）：

| 字段          | 说明                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `cron`      | 标准 **5 字段 cron**，**本地时间**，如 `"*/5 * * * *"`（每 5 分钟）、`"30 14 28 2 *"`                                                              |
| `prompt`    | **"The prompt to enqueue at each fire time."** ← 这就是唤醒载荷                                                                          |
| `recurring` | 默认 `true`：每次匹配都触发，直到删除或**3 天后自动过期**；`false`：下次匹配触发一次后自删                                                                           |
| `durable`   | `true` = 落到 `{project}/.codebuddy/scheduled_tasks.json` 并**跨重启存活**；`false`（默认）= 仅内存，会话结束即失效（注：工具面对外 `.omit({durable})`，即该键由运行时决定） |

配套：`CronDelete {id}`、`CronList`，以及用户侧斜杠命令 **`/loop [interval] <prompt>`**（例：`/loop 1m check the AgentChat inbox`）。  
权威性佐证：运行时的权限白名单里明确写着 *"WorkBuddy Scheduling: Using `CronCreate`, `CronDelete`, or `CronList` to schedule or manage WorkBuddy tasks within the current session."* —— 属**默认允许**的操作。

**调度器还有为"不可靠唤醒"准备的三件套**：`isLoading()`（agent 忙则推迟）、`checkMissedTasks()` / `onMissed`（会话恢复时**补跑错过的触发**）、`lockIdentity{sessionId,pid}`（跨进程只有一个 owner 执行）。

**结论**：适配器可以在 `SessionStart` 时用 `CronCreate` 装一条会话级轮询任务，**此后即使会话完全空闲，Host 也会自己把 prompt 注入会话并起一轮** —— 这是真正的"定期轮询推送"，且**不依赖任何 hook 事件**。代价是每次触发都消耗一个模型回合。

---

## 2. 五问能力矩阵（指南 §3 要求答到"文件:行"级）

| #      | 问题                              | WorkBuddy 答案                                                                                                                                                   | 证据                                                                                                                                        | 对形态的决定                                                                |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Q1** | 有没有常驻扩展点（插件/长期进程）？还是只有一次性 hook？ | **hook 只有一次性进程**（每次事件 fork 一个短进程）；`bin/` 只是 PATH 注入，`.lsp.json`/`.mcp.json` 是**会话级**长驻子进程，均**不含"后台守护 + 主动推送"语义**。**但宿主运行时另有会话级 cron 调度器**（§1.4），可在空闲期注入 prompt | 本机三个内置插件的 `hooks/hooks.json` 都是 `type:"command"` 一次性调用；cron 见 `codebuddy-lite-wb.mjs` 的 `createCronScheduler`                             | → hook 侧走**分支 2**（Claude Code 路线）；**空窗期交给 cron**，两条腿并用                |
| **Q2** | 能否主动注入一条消息并启动一轮？                | **能**。`Stop` hook 返回 `{"continue":false,"stopReason":…}` → 阻止停止、**继续对话**；或退出码 2 把 stderr 注入下一条消息                                                               | Hooks Reference「Stop: Blocks the stop action, surfaces message to Agent and continues conversation」；`stop_hook_active` 字段与 Claude Code 同名 | → 入站唤醒**成立**，主入口 = `Stop`                                             |
| **Q3** | 空闲/回合边界可见吗？                     | **可见且丰富**。`Stop`=回合结束、`UserPromptSubmit`=新回合开始、`SessionStart`=会话开始、`Notification(idle_prompt)`=空闲信号、`SubagentStop`=子代理结束                                       | 探针实测 `Notification` 的 `notification_type` 含 `idle_prompt`；`Stop` payload 含 `last_assistant_message`                                       | → 无需轮询也能拿到"投递时机"；节点状态机可精确映射 `busy`/`idle`                             |
| **Q4** | 能否改写工具入参？                       | **能**。`PreToolUse.hookSpecificOutput.modifiedInput`（"partial field override"）；SDK 侧叫 `updatedInput`                                                            | Hooks Reference「modifiedInput – Mutate tool arguments before execution」；matcher 支持 `mcp__.*`                                              | ⭐ → **逐会话出站身份可精确实现**（这条 DSH 做不到，Claude Code 也没有）                      |
| **Q5** | 配置/装配落点在哪？卸载信号是什么？              | 落点 = **插件目录**（`hooks/hooks.json` + `.mcp.json`）+ 市场注册 + `enabledPlugins`。卸载 = 禁用/移除插件；**无"会话被删除"事件**，只有 `SessionEnd(reason)`                                   | 本机 `settings.json.enabledPlugins`、`known_marketplaces.json`；Hooks Reference 的 `SessionEnd: reason`                                        | → 安装器写**插件**而非 settings.json；`SessionEnd` **只停跟踪、绝不 `retire`**（§6 铁律） |

### 2.1 与三个既有宿主对照（延续指南 §3.1）

| 能力      | OpenCode                | Claude Code                    | DSH                  | **WorkBuddy**                                                |
| ------- | ----------------------- | ------------------------------ | -------------------- | ------------------------------------------------------------ |
| 常驻事件流   | ✅ 插件钩子                  | ❌ 一次性 hook                     | ✅ 进程内 Cordis 插件      | ❌ 一次性 hook                                                   |
| 注入并唤醒   | `promptAsync`           | Stop hook block                | `agent.followup`     | **`Stop` + `continue:false`/退出码 2**                          |
| 空闲检测    | `session.idle`          | `Notification(idle_prompt)`    | `agent/status`       | **`Stop` + `Notification(idle_prompt)`**                     |
| 空窗补拉    | 空闲轮询 10s                | ❌ 只能边界拉                        | 空闲轮询 10s             | ⭐ **✅ 宿主内建会话级 cron**（`CronCreate`/`/loop`），空闲期亦可起一轮（每次花一个回合） |
| 逐会话出站身份 | ✅ 改入参+桥剥头               | ❌ 容器身份                         | ❌ 禁改写→磁盘提示           | ⭐ **✅ 改入参+桥剥头（同 OpenCode）**                                  |
| 生命周期    | dispose/session.deleted | session_end                    | agent/disposed       | **SessionEnd → 只停跟踪**                                        |
| 装配落点    | OpenCode JSONC          | settings.json + ~/.claude.json | bundle+profile patch | **插件目录 + 市场注册**                                              |

**结论**：WorkBuddy 落在 **Claude Code 的生态位，但能力更强**——多出 `PreToolUse.modifiedInput`（精确逐会话身份），  
且**空窗补拉有宿主内建 cron**（Claude Code 完全没有）。因此适配器应**以 `adapters/claude-code/` 为蓝本**，  
把"逐会话身份"按 `adapters/opencode/` 的"改入参 + 桥剥头"补齐，把"空窗轮询"交给 `CronCreate`。

---

## 3. 推荐架构

### 3.1 目录骨架（对齐指南 §4 的最小集合）

```
adapters/workbuddy/
  .codebuddy-plugin/plugin.json     # 清单：name/version + hooks 指针
  hooks/hooks.json                  # 事件 → 命令 映射（唯一装配面）
  hooks/
    session-start.mjs               # 注册实例+会话节点 → 补拉 → 注入（可选）
    user-prompt-submit.mjs          # 心跳(会话+容器) → 补拉
    stop.mjs                        # ★主注入点：补拉 → 有件则 continue:false + stopReason
    notification.mjs                # idle_prompt → 上报 idle（心跳）
    session-end.mjs                 # 停跟踪 + 停定时器；★不 retire
    pre-tool-use.mjs                # ★向 mcp__agentchat__* 入参注入 __agentchat_session
  lib/
    hub.mjs                         # 地址/token/超时/退避 + /internal/*
    token.mjs                       # join_token / 节点 id 落盘（<HOME>/agents/workbuddy.{token,id}）
    log.mjs                         # 1 MiB 轮转；★绝不写宿主 stdout
    poll.mjs                        # 无重叠 + 指数退避（hook 生命周期内）
    flush.mjs                       # 心跳→wake→去重→注入→result（宿主侧用回调注入）
    session-hint.mjs                # 节点命名 + 逐会话身份提示
  mcp-bridge.mjs                    # stdio ↔ HTTP /mcp；逐请求身份；剥 __agentchat_session
  install.mjs                       # 幂等安装器：--dry-run/--uninstall/备份/原子替换
  __tests__/                        # 假宿主 + 假 Hub，不联网
  README.md                         # 安装/验证/排障/已知边界
```


> 对照指南骨架：`hub` / `token` / `log` / `poll` / `flush` / `session-hint` / `mcp-bridge` / `install` **八件套齐全**。
> 唯一形状差异：宿主侧入口从"一个 plugin.ts"变成"**一组 hook 脚本**"——这正是 Claude Code 适配器的形状，可直接参考 `adapters/claude-code/session-start.mjs`、`busy.mjs`、`idle.mjs`。

### 3.2 消息注入（指南 §4.5 的"差异最大一步"）

```js
// hooks/stop.mjs 骨架
const { session_id, stop_hook_active } = JSON.parse(stdin);
if (stop_hook_active) process.exit(0);          // 防注入自激循环（对齐 Claude Code）
const injected = await flush({ sessionId: session_id });   // 心跳→wake→去重→注入
if (!injected) process.exit(0);                 // 无新件 → 正常停止
process.stdout.write(JSON.stringify({
  continue: false,
  stopReason: injected.text,                    // 主通道
  hookSpecificOutput: { hookEventName: "Stop", additionalContext: injected.text } // 镜像兜底
}));
```

- 注入文本统一前缀 `[AgentChat] …` 并携带 `messageId`（指南 §4.4）。
- **任何失败只记日志、绝不抛**，退出码一律 0（除刻意的 Stop 注入）。
- `stop_hook_active` 是天然的防重入开关，直接复用。

### 3.3 逐会话出站身份（指南 §5 第 1 条，最可靠方案）

```
PreToolUse(matcher="mcp__agentchat__.*")
  → modifiedInput 追加 __agentchat_session = <session_id>
  → mcp-bridge 剥离该键 → 请求头 x-agentchat-session: <task_ref>
  → Hub 按 task_ref 解析出站身份（命中会话节点；未命中则无身份，绝不回落容器）
```
红线照抄指南 §5：**只原地改**、写入失败只记日志、值变化时**丢弃 `mcp-session-id` 重新 initialize**。

### 3.4 节点模型

```
workbuddy@<host>                    根，role_tag=container，join_token 落盘认领
└─ <目录名>-<session_id 短标识>      会话节点，task_ref = WorkBuddy session_id（重启/续聊稳定）
   └─ 子代理节点（可选）              SubagentStop 可给出父子关联；首版可不做
```
命名纪律（指南 §7 坑 1）：**先剥已知前缀再截断**，撞 `name_taken` 时追加短哈希**重试一次**。

### 3.5 空闲期轮询：三条可选形态（成本 / 实时性权衡）

> 前提：宿主内建会话级 cron（§1.4）。三种形态**不互斥**，建议 1 为主、2 为优化、3 为最小可用版。

| 形态 | 机制 | 每次触发的开销 | 实时性 | 备注 |
|---|---|---|---|---|
| **① cron + MCP 取件**（推荐） | `SessionStart` 时 `CronCreate({cron:"*/1 * * * *", prompt:"[AgentChat] poll", recurring:true})`；到点会话被唤醒 → agent 调 MCP `inbox` 取件 | 一个完整回合（含一次建模） | ≈轮询间隔 | 只用文档化能力，最稳；无件时回合极短 |
| **② cron 哨兵 + `UserPromptSubmit` hook**（优化） | cron 只发哨兵 prompt；`UserPromptSubmit` hook 拦截 → 秒级轮询 Hub → 把待投内容与指令写进 hook 输出；无件时让本轮快速空跑 | 一个"空回合" | ≈轮询间隔 | 拉取逻辑留在 hook（可离线/可测），比①把逻辑写在 prompt 里更可控；**需实测** cron prompt 是否触发 `UserPromptSubmit` |
| **③ `/loop` 手动** | 用户敲 `/loop 1m [AgentChat] poll` | 同① | ≈轮询间隔 | 零实现成本，适合演示与个人自用 |

**必须写进 README 的约束**：

1. **每次轮询 = 一个模型回合** → 轮询间隔是 token 成本与实时性的**直接 trade-off**；默认建议 **60s**，并提供 `AGENTCHAT_CRON_MS` 开关（设 0 = 关轮询，退回纯边界投递）。
2. **recurring 任务 3 天后自动过期** → 适配器必须在过期前**续订**（`CronList` 查 + `CronDelete`/`CronCreate` 重建），建议挂在 `SessionStart`。
3. **会话作用域**：应用退出 / 会话未加载时**不触发**；`durable` 版在会话恢复时**补跑错过的触发**（`onMissed` / `checkMissedTasks`）——但补跑是"补"，不是"准点"，实时性会退化。
4. **与边界投递并存不冲突**：`Stop` hook 负责"回合内到达即时投递"，cron 负责"完全空闲期唤醒"，两者共用同一套 `flush` 与去重集合（按 `messageId`），**不会重复注入**。
5. **身份注意**：cron 唤醒的回合里，出站身份仍靠 `PreToolUse.modifiedInput`（§3.3）保证，与唤醒来源无关。

---

## 4. 安装器与落点策略

指南 §8 要求：`--dry-run` / `--uninstall`（字节级还原）/ 备份 / 原子替换。三条候选路线：

| 方案 | 做法 | 优点 | 风险 | 建议 |
|---|---|---|---|---|
| **A. 本地目录市场 + 启用**（推荐） | 把插件包放固定目录 → 在 `known_marketplaces.json` 注册 `type:"directory"` 市场 → 在 `settings.json.enabledPlugins` 置 `true` | 一次装好，用户零操作；与内置插件同路径 | 需要写 `installed_plugins.json` / `configured-plugins.json` 等**内部 schema**，版本升级可能变 | **首选**，但对内部文件必须"受管块 + 备份 + 原子替换 + 字节级还原" |
| **B. 发布为市场插件，用户手动安装** | 打包成 marketplace，用户在插件管理 UI 里点安装 | 走官方受支持路径，最稳 | 多一步人工；无法 CI 自动化 | 分发形态，配合 A 使用 |
| **C. `.codebuddy/settings.json` + `--plugin-dir`** | 直接把 hooks 写进用户/项目级 settings，或用 `codebuddy --plugin-dir` 加载 | 无需插件机制 | **桌面端是否读该路径未经证实**；且写 settings 会与用户既有 hooks 冲突 | 仅作 CLI 场景兜底 |

**关键约束**（照抄指南 §8 第 2 条）：**包内不含机器绝对路径**——`node` 路径、`mcp-bridge.mjs` 绝对路径由安装器写进用户层；随包发布的只有相对引用与 `${CODEBUDDY_PLUGIN_ROOT}` 占位符。

---

## 5. 指南 §7 事故表映射（9 条逐条判定）

| # | 事故 | 在 WorkBuddy 上是否适用 | 处置 |
|---|---|---|---|
| 1 | 会话短标识撞名（`session-<uuid>` 前缀陷阱） | **适用**（`session_id` 亦为 uuid 形态） | 剥前缀再截断 + `name_taken` 重试一次；写回归测试 |
| 2 | 注册失败一次后永久静默（在途 promise 泄漏） | **适用**（hook 每次都是新进程，但 MCP 桥与长驻 lib 有同构风险） | 整个任务体放进 `try/finally` |
| 3 | 重启后不对话时消息一直排队 | **适用且更严重**（无轮询器） | **登记成功即拉一次**；并把"补拉"挂到 `SessionStart`/`UserPromptSubmit`/`Stop` 三处 |
| 4 | 错过事件后不再枚举 | **适用** | 每轮 `SessionStart` 重新枚举/补注册 |
| 5 | 注入报 `format v4 … source kind`（DSH 专有） | **不适用** | WorkBuddy 注入走 hook stdout JSON，**不经过宿主消息构造器** → 少一个大坑 |
| 6 | 陈旧身份提示文件未清 | 适用（若采用磁盘提示兜底） | 启动读真值作基线 |
| 7 | 身份已写盘但 Hub 报 `identity_required` | **适用**（身份只在 MCP `initialize` 认） | 值变化 → 重建 MCP 会话；`400` 清缓存只重试一次 |
| 8 | 对端无法回复（`container_not_chat_target`） | **可规避**（有 `modifiedInput`，能精确到会话节点） | 不做"磁盘提示"降级；直接精确身份 |
| 9 | 阻塞式 `ask` 总超时 | **适用** | 文档化"用异步 ask"；桥与宿主 MCP 超时需实测后写进 README |

**净收益**：9 条里 8 条适用但**都有现成修法**，1 条（坑 5）因架构不同**天然不存在**。

---

## 6. 已知边界与天花板（如实记录，指南 §10）

1. **✅ 空闲期唤醒已解决，但代价是"常态化回合开销"。**（本条为修正后的结论）
   - hook 本身确实是一次性进程 → 纯 hook 方案只能"回合边界投递"；
   - **但宿主内建会话级 cron（§1.4）补上了这一环**：`CronCreate` 到点会把 prompt 注入会话并起一轮，**空窗期也能唤醒**；
   - 因此真实边界不是"能不能"，而是 **"愿意付多少轮询成本"**：轮询间隔 ↓ → 实时性 ↑、token 成本 ↑。默认 60s 且可关闭（§3.5）。
   - 仍存在的硬约束：**应用退出 / 会话未加载时不触发**（`durable` 版仅在会话恢复时补跑）；recurring **3 天过期**需续订；
   - 附：`.mcp.json` 的 MCP 子进程**只能被调用、不能推送**，故 MCP 本身**不能**作为推送通道——cron 才是。
2. **退役单向门**：WorkBuddy 无"会话被删除"事件，只有 `SessionEnd(reason)`。→ `SessionEnd` **只停跟踪、停轮询**，节点交给 `last_seen` 自然过期；**绝不 `retire`**。遗留 pending 需运维清理（Hub 已有批量退役端点）。
3. **阻塞式 ask**：受桥 30s + 宿主 MCP `toolCallTimeoutMs` 双重限制 → 用异步 ask，答复经 wake 回投。
4. **子代理建模**：`SubagentStop` 可用，但"父关联"是否稳定携带父会话 id **未证实**（§9 spike 4）。首版可只建实例+会话两级，子代理延后。
5. **桌面端 vs CLI 差异**：本分析基于**桌面端**（探针实测）。CLI（`codebuddy`）与桌面端是否共用同一 hook 配置路径**未证实**，安装器需按宿主探测分流。

---

## 7. 测试与验收（映射指南 §9）

**单测（假宿主 + 假 Hub，不联网）**——直接复用 §9.1 全部条目，另加 WorkBuddy 专有：
- `stop.mjs` 在 `stop_hook_active=true` 时**必须**静默退出 0（防自激）；
- `stop.mjs` 无新件时输出为空且退出 0；
- 注入正文**同时**写 `stopReason` 与 `hookSpecificOutput.additionalContext`；
- `pre-tool-use.mjs` 只对 `mcp__agentchat__.*` 生效，`modifiedInput` **原地改**且不破坏其它字段；
- **纪律检查**：hook 脚本对宿主 stdout 只允许"合法 hook JSON"，其余一律走 stderr / 文件日志。

**集成测试（真 Hub + 假宿主）**——§9.2 六条照抄，重点是：
- 对端经真 MCP `send` → 假宿主触发 `Stop` → 断言注入**恰好一条**、`wake_jobs` 落 `accepted`、再取**不重投**；
- `SessionEnd` 后**不退役**、同 `task_ref` 可再次注册（同一 Hub id）。

**真机手动清单**——§9.3 六条照抄，且必须在 README **如实标注**：
- ✅ 已实测：`Stop` 在真实任务结束时触发（第三方探针）
- ⚠️ 未实测：第三方（非内置）插件的 hooks 在桌面端是否无条件加载

---

## 8. 动工前的 spike 清单（指南 §10 第 4 条：**不要用文档猜 API**）

建议一个下午跑完这 8 个，任一失败都要回头改设计（**6–8 号是本轮新增的 cron 系列，直接决定"空闲期唤醒"能不能落地**）：

| # | Spike | 判据 | 失败后果 |
|---|---|---|---|
| 1 | 造一个 `hello-hook` 插件（只挂 `Stop` + `PreToolUse`，把 payload 原样写文件），装进桌面端并启用 | 文件里出现**真实** payload，含 `session_id`/`tool_name` | 若第三方插件 hooks 不加载 → 退回方案 C 或改用 `~/.codebuddy/settings.json` |
| 2 | 在 `stop.mjs` 里 `{"continue":false,"stopReason":"[AgentChat] ping"}` | 会话**不结束**、Agent 收到 `[AgentChat] ping` 并**继续输出** | 若只显示给用户不送达 Agent → 改用退出码 2 + stderr 通道 |
| 3 | 在 `pre-tool-use.mjs` 对 `mcp__agentchat__*` 注入 `__agentchat_session` | 桥能读到该键 | 若 `modifiedInput` 对 MCP 工具无效 → 降级为"磁盘会话提示"（DSH 折中方案） |
| 4 | 触发一次子代理任务，看 `SubagentStop` 是否带父会话 id | 有稳定父子关联 | 无则首版只做两级节点 |
| 5 | 记录 `Stop` 到"控制权交还用户"的实际延迟、`session_id` 在**续聊/重启**后是否不变 | `task_ref` 稳定 | 不稳定则需换 `task_ref` 取值源 |
| **6** | **`CronCreate({cron:"*/1 * * * *", prompt:"[AgentChat] poll", recurring:true})` 后静置 3–5 分钟、完全不动会话** | 会话**自行起轮**（transcript 里出现该 prompt 引发的一轮） | ⛔ 若不起轮 → **空闲期唤醒不成立**，退回"仅边界投递"+ Stop 长轮询 |
| **7** | 观察 cron 触发的 prompt 是否走 `UserPromptSubmit` hook | 该 hook 被触发 | 不触发 → 形态② 作废，只能用形态①（把取件逻辑写进 prompt） |
| **8** | 连续观察 recurring 任务的 **3 天过期**行为与"会话恢复时补跑"（`onMissed`） | 过期前可续订；恢复后有补跑 | 若不续订即失效 → 必须把"续订"做成 `SessionStart` 的固定动作 |

---

## 9. 工作量、风险与建议路线

| 项 | 评估 |
|---|---|
| 新增代码 | ≈ `adapters/claude-code/` 量级：6 个 hook 脚本 + 8 个 lib + 1 个桥 + 1 个安装器 + cron 轮询器 + 测试 |
| 可复用 | `adapters/claude-code/` 的整体形状与 `common.mjs`、`token.mjs`；`adapters/opencode/` 的 `mcp-bridge.mjs`（改身份头来源）、`flush.ts`、`poll.ts`、`transport.ts` |
| 主要风险 | ① 第三方插件 hooks / cron 在桌面端的加载与触发行为（spike 1、6）② cron 轮询的回合成本与 3 天过期（spike 8）③ 桌面端内部 JSON schema 漂移（方案 A） |
| 评级 | 风险 **中低**、收益 **高**（补上"WorkBuddy 用户进群聊"这一整块能力，且能空闲唤醒） |

**建议路线**：spike（0.5–1d，**含 cron 三连**）→ 骨架 + 注册/状态/取件闭环（1–1.5d）→ 逐会话身份（0.5d）→ cron 轮询与续订（0.5d）→ 安装器（0.5d）→ 测试与真机清单（1d）→ README 与已知边界。
**首个里程碑**定义：对端经 Hub 发一条消息，WorkBuddy 会话在**回合结束时**自动收到并继续起一轮，回执变 `delivered`，且**出站身份落在会话节点**（对端可回复）。
**第二个里程碑**：会话**完全静置**（不碰键盘）时，对端发消息 → `CronCreate` 触发 → 会话自行起轮处理 → 回执 `delivered`。

---

## 附：证据索引

**文档**
- `docs/adapters-guide.md`（本仓，五问/骨架/事故表/验收表）
- Hooks Reference：`https://www.workbuddy.cn/docs/cli/hooks`（事件行为、JSON 输出、退出码、配置落点、env）
- Hook 使用文档（IDE）：`https://www.codebuddy.cn/docs/ide/Features/Hooks`（输入/输出字段、matcher 语义）
- 创建插件：`https://www.workbuddy.cn/docs/cli/plugins`（`.codebuddy-plugin/plugin.json` + 组件目录 + 装配）
- SDK Hook 系统：`https://www.workbuddy.cn/docs/cli/sdk-hooks`（`decision:"block"`、`updatedInput`、`additionalContext`）
- 第三方实测探针报告（桌面端 hook 生命周期 + `Notification(idle_prompt)` + `Stop`）

**本机实证**
- **`D:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\dist\codebuddy-lite-wb.mjs`**
  —— agent 运行时。本报告的**决定性证据**均出于此：
  `createCronScheduler({sessionId, onFire: t=>enqueuePrompt(t), isLoading, lockIdentity})`、
  `CronCreate` 工具 zod schema（`cron` / `prompt` / `recurring`（3 天过期）/ `durable` → `{project}/.codebuddy/scheduled_tasks.json`）、
  `CronDelete` / `CronList` / `/loop` 用法文本、`ScheduledTasks` 服务（`sessionCronTasksMap` / `durableCronTasks` / `CronStorage`）、
  `executeHooks()`（`timeout ?? 60` 秒默认）、`Notification` 类型枚举（含 `IDLE_PROMPT`）、
  以及 idle 通知的 **60s 一次性定时器**（`setTimeout(..., 6e4)` + `resetIdleTimer`）。
- `D:\Program Files\WorkBuddy\resources\app.asar.unpacked\resources\plugins\workbuddy-builtin\builtin-plugins\tencent-docx\.codebuddy-plugin\plugin.json`（hooks + skills + agents）
- `...\builtin-plugins\sheetagent\.codebuddy-plugin\plugin.json` 与 `...\sheetagent\hooks\hooks.json`（内联 mcpServers + `SubagentStop`）
- `...\builtin-plugins\subscription-gate\hooks\hooks.json`（`PreToolUse` 实测生效）
- `...\builtin-plugins\sheetagent\hooks\save-on-subagent-stop.mjs`（stdin `hook_event_name` / `stop_hook_active` 取值）
- `...\mcps\miora-mcp\.mcp.json`（`${CODEBUDDY_PLUGIN_ROOT}` / `${CODEBUDDY_PLUGIN_DATA}` 占位符）
- `C:\Users\cjz\.workbuddy\settings.json`（`enabledPlugins`）
- `C:\Users\cjz\.workbuddy\plugins\{known_marketplaces,installed_plugins,configured-plugins}.json`、`plugins\marketplaces\*\...\.codebuddy-plugin\marketplace.json`

**参考实现**
- `adapters/claude-code/`（hook 形状蓝本：`session-start.mjs` / `busy.mjs` / `idle.mjs` / `common.mjs`）
- `adapters/opencode/`（逐会话身份蓝本：`plugin.ts` 改入参 + `mcp-bridge.mjs` 剥头）
