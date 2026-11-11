# 版本更新日志

本项目遵循语义化版本，重大变更记录于此。首个公开版本基线：`v0.1.0`。

## [Unreleased]

### 变更（**默认值翻转：行为级不兼容**）

- **`inbox` 默认排除自发消息**（DM/群）：`inbox` 返回的是"各会话已读位点之后"的消息，而**自己发出的消息同样落在自己的位点之后**（发消息不推进读位点，只有 `ack` 会）——于是"轮询 `inbox` → 逐条回复"的客户端会形成**自激环路**（回复产生新消息 → 又被轮询到），且 `self_send` 挡不住（它只覆盖 `to=自己`，群回复是对群 id 的正常发送）。
  现在默认排除自发；需要旧行为时传 **`include_self: true`**（additive 参数）。**两类例外仍保留自发可见**：**喊话广播**（发送者需看到自己那条，既有 DoD）与 **`system` 通知**（入群/ask 卡必须达）。
  受影响方：自行轮询 `inbox` 的外部脚本客户端（若坚持 `include_self: true`，请自行按 `fromAgentId ≠ 自己` 过滤）；DSH 适配器不受影响（注入按 `wake_jobs` 走）。配套更新：`inbox` 六行工具描述、`docs/test-plan-dsh.md` §7.1/§7.4。

### 修复

- **MCP 会话失效（404）在同调用内自愈**：Hub 重启、或 MCP 会话**空闲 TTL 30 分钟**淘汰后，客户端缓存的 `mcp-session-id` 失效，`tools/call` 直接吃 404。旧行为要等**下一次**调用才自愈 —— 而空闲 agent 恰恰是**被唤醒要回话**时才调工具，等于每次久闲后第一次回话必失败（写工具下模型可能"重讲一遍内容"→ 重复消息）。
  现在 `adapters/dsh/lib/mcp.js` 检测 404 → 丢弃缓存会话 → **单飞重握手**（并发只握一次、client 原子替换）→ **原样重发同一 payload 一次**（调用方的 `idempotencyKey` 自动复用；依据：`server/routes/mcp.ts` 在转发前查表，404 保证该次调用**未执行**）。重握手本身失败则**原样透出原始错误**，绝不伪装成功；重发仍 404 抛稳定码 **`mcp_session_expired`**（文案写明"该次调用未执行，可原样重试"）。
- **两类失败的可重试性分开告知模型**：`mcp_session_expired` → 可原样重试；transport 类（网络/超时/耗尽）→「**结果未知**，重试请带 `idempotencyKey`」，避免模型对写工具盲重发造成重复消息。
- 回归：新增 `adapters/dsh/__tests__/mcp-session-heal.test.ts`（5 例：重发成功且**身份头不变**、二次 404 稳定码、重握手失败透出原始错、并发 404 单飞、非 404/网络错不重试）。

## [0.3.1] - 2026-11-10

> 补丁版：**建议所有 0.3.0 用户升级**（含 Linux 宿主上的一个真实命名缺陷）。升级步骤与 `v0.3.0`
> 相同，见下方 0.3.0 的「更新须知（必须做的事）」。

### 修复

- **DSH 会话节点名跨平台取 basename（修 ubuntu CI 自该用例落地起全红）**：`adapters/dsh/lib/session-hint.js` 原先用 `node:path` 的 `basename()` 从会话头 `cwd` 取目录名，而 **POSIX 上反斜杠不是分隔符** —— `basename("C:\work\proj-sess-1")` 会**整串返回**，节点名因此变成一整条 Windows 路径（如 `C:\work\proj-sess-1-243b8c`），既不可读也影响展示名唯一性。现改用新增并导出的 `basenameAny()`（同时认 `\` 与 `/`，支持混合分隔符、尾随分隔符与空值回退），`sessionName()` 不再依赖 `node:path`。
- **回归测试跨平台化**：`adapters/dsh/__tests__/naming.test.ts` 新增 Windows 反斜杠 / POSIX / 混合 / 尾随 / 空值 / 端到端节点名用例——此前这类「本机 Windows 绿、Linux CI 红」的失败在本地发现不了，现在能被拦住。
- **CI 恢复绿灯**：GitHub Actions（ubuntu-latest，Node 22 与 24 双腿）由 `failure` → `success`；本次之前的所有运行（含 v0.2.0 发布）均为 failure，根因即上述命名缺陷。

## [0.3.0] - 2026-11-10

> **升级前必读**：本版含**身份修复**与**工具面切换**（并移除 claude-code 适配器）。请按文末
> 「更新须知（必须做的事）」逐步执行；跳过会出现「agent 收得到消息却没有工具可回复」
> 「历史消息署名是容器」「消息一直排队中」等现象。

### 新增

- **Web UI 全面重做（六组）**：① **可辨识与反馈**——容器行压暗 45% + 横杠勾选 + 虚线提示「分组容器，不可作为成员」（子节点不再被误压暗）、状态图例（在线/忙碌/离线/退役）、禁用主按钮统一为灰底描边；② **信息层级**——会话列表搜索框、行首头像/分级时间/未读、群聊计数徽标、回执前置（`✓✓ 已送达 22:58` / `⏳ 排队中`）、消息操作收进 `⋯` 菜单（看原文/复制/撤回）；③ **交互可用性**——添加成员弹窗加搜索、已选 N 名、「已在群」标记（不可选），会话/通讯录/通知三处搜索与空态引导；④ **响应式与一致性**——窄屏底部 tab 单字化（消息区可见高度增加）、中栏分区 hairline 与头部对齐、只读批示选项按钮化；⑤ **设置页**——数据/日志路径与 POSIX、PowerShell 两条命令各带一键复制，「清理离线历史会话」改为 danger 红系；⑥ **「版本与更新」卡片**——Hub 版本与更新源、逐适配器「内置 vX · 上报 vY」（`有更新` 标红 / `未上报` 不猜）、「检查更新」→ 最新版本 + 差异对比链接 + 检查时间，且**不提供一键升级**，只给 3 步手动指引。
- **消息紧急度 `urgency`（`low` / `normal` / `urgent`）**：`send` / `shout` / `ask` 均可携带；`normal`（缺省）**不写 `meta`**（保持既有金样例），`urgent` 承诺「下一个 step 边界前可见」并被适配器优先领走；`message_status` 与取件出参都能看到档位。**限制**：无法抢占正在执行的工具；开启抢占开关（默认关）才会打断整回合。
- **`whoami` 工具（第 13 个 MCP 工具）**：agent 终于能查到「我是谁」——返回 `agent_id`、机器名 `name`、**展示名 `display_name`**（人类在 UI 里看到并修改的昵称）、`vendor`/`kind`/`status`/`role_tag`/`parent_id`/`unread`。
- **版本面与更新检查**：`GET /api/version`；`POST /api/version/check`（GitHub releases→tags 回退、5s 超时、512KB 上限、10 分钟缓存；**失败返回 HTTP 200 + 错误码**，不是 500）；CLI `--check-update`（退出码 0/1/2）；设置页版本卡。
- **`/api/test/*` 测试面（21 组端点）**：会话/群/成员/消息的增删改查、改名、解散、清空、全库快照 `dump`、种子数据等，供真机自动化测试驱动。**默认关闭**（`AGENTCHAT_TEST_API=1` 开启）且**仅回环地址可用**——不要在真实数据目录长期开启。
- **身份遗留数据修复脚本 `bin/repair-identity.mjs`**：默认 dry-run；`--apply` 前自动 `VACUUM INTO` 快照；幂等；`--check` 以退出码报告。清理「容器作为收件方 / 唤醒目标」的脏数据，并给容器署名的历史消息打 `meta.legacy_identity="container"` 标注（**只报告不删数据**）。
- **无头测试适配器 `adapters/test` + 45 例测试矩阵**：脱离 LLM 驱动完整闭环（建会话 / 状态上报 / 收发 / 回执 / 唤醒），9 个场景 66 项检查。配套文档 7 篇：`docs/test-api.md`、`docs/test-plan-dsh.md`、`docs/test-matrix.md`、`docs/urgency.md`、`docs/versioning.md`、`docs/repair-identity.md`、`docs/upgrade-runbook.md`。

### 变更

- **DSH 原生工具面成为默认**（`config.nativeTools`，可置 `false` 关闭）：身份绑定到**每次调用**（`x-agentchat-session`），不再依赖共享文件；安装器默认**摘除 MCP 桥工具行**（避免模型同时看到两套工具），确需桥接时用 `--with-mcp-bridge` 重装。
- **原生工具面注册失败会自愈**：Hub 未启动也能恢复——失败后按 5s→10s→20s→40s→60s（±10% 抖动）退避重试，成功后停止；同原因日志节流，并提示 `--with-mcp-bridge` 补救路径。
- **`inbox` 改为「只看未读」**：按**每会话已读位点**取件（无位点 = 全部未读），`after` 仍可叠加翻页；要读已读历史用 `conversation`。旧行为取的是「全部可见历史的最旧一页」，会出现「未读 3 条却一条也看不到」。
- **会话标题同步不再覆盖手动改名**：同步前先读 Hub 上的当前展示名，与「上次写入值」不一致即判定用户改过名，该会话**永久停用**自动同步（状态持久化在 `<hub-home>/agents/dsh.titles.json`，插件重启后仍生效）；读不到当前名时降级为旧行为，不因可观测故障阻断同步。
- **工具可发现性**：13 个工具全部六行描述（作用 / 何时用 / 何时不用 / 邻接区别 / 示例 / 常见错误）、参数级 `description`、MCP `instructions` 使用指南、`register` 出参附一份指南、错误码统一带「下一步」。
- **容器语义收紧**：容器不可入群、不可发送、不可作为 DM 收件方（稳定错误码 `container_not_group_member` / `container_cannot_send` / `container_not_chat_target`）；前端保留容器以显示层级，但**不可勾选**。

### 修复

- **「显示已送达但对方其实没收到」**：投递去重 `seen` 从「每个插件实例一份」改为**每个收件方各一份**——同一实例内两个会话同收一条群消息时，第二个会话此前只补回执、不注入正文（静默丢消息）。
- **「消息一直排队中 / 永久 pending」**：`/internal/wake` 认领页在收件方累计可见消息 >50 后**永不前进**（先取最旧 50 条再在 JS 里跳过）→ 候选集改到 SQL 层与认领判据逐条对齐，每页都能吃满。60 条压测：`50/0/0` → `50/10/0`。
- **「会话完全空闲才送达」**：忙时也取件（心跳状态修正 + 忙时轮询 5s），消息在**下一个 step 边界**交付；每忙回合默认注入 1 次，避免打扰。
- **身份冒用（严重）**：桥在 `agents/dsh.current` 缺失时会回落到实例容器，造成「群聊里所有人用父节点身份发言」；现在**逐调用身份**为准、桥 **fail-closed**（无身份即 `identity_required`），子代理不再冒用父身份。
- **`inbox` 看不到未读**（见「变更」）。
- **会话标题同步覆盖用户改名**（见「变更」）。
- **Hub 不可达导致工具面永久缺失、只能重启 DSH**（见「变更」）。
- **真机运维陷阱**：从 DSH 会话里启动的 Hub 会被 DSH 退出带走（表现为「明明 health 200，一退就连接被拒」）——手册记入用计划任务/独立终端常驻的方法（`docs/upgrade-runbook.md` §6.1）。

### 移除

- **Claude Code 适配器**：宿主无常驻扩展点、静置期无法原生唤醒（见 `docs/adapters-guide.md` 能力矩阵，历史可查 git），目录 / 文档 / 安装器 / 测试整体移除。⚠️ **已装用户须在升级前**用旧版本执行 `node adapters/claude-code/install.mjs --uninstall` 回退（或手动移除 `settings.json` 的 hooks 与 `~/.claude.json` 的 mcp 条目——删除后无卸载入口）。存量 claude-code 节点的厂商徽标样式保留以便渲染。

### 更新须知（必须做的事）

1. **升级前（装过 claude-code 适配器者）**：用**旧版本**执行 `node adapters/claude-code/install.mjs --uninstall`；或手动清掉 `settings.json` 的 hooks 与 `~/.claude.json` 的 mcp 条目。本版已不含卸载入口。
2. **让 Hub 先常驻**：不要从 DSH 会话里启动 Hub（DSH 退出会连带杀掉它）。用独立终端或 Windows 计划任务常驻，确认 `GET /api/health` 返回 200。
3. **升级 Hub**：`git pull`（或切到 `v0.3.0`）→ `npm install` → `npm run build` → 重启 Hub。
4. **重装 DSH 适配器并重启 DSH**：`node adapters/dsh/install.mjs`（默认摘除旧 MCP 桥工具行、启用原生工具面），然后**完全退出并重启 DSH**。日志应出现「原生工具面自动注册成功…」；模型侧工具名为 `agentchat_*`（不再是 `mcp__agentchat__*`），其中包含新的 `whoami`。
5. **修复身份遗留数据（需先停 Hub）**：`node bin/repair-identity.mjs --home <数据目录>` 预演 → 确认后 `--apply`（自动快照）→ `--check` 应为「干净」。这一步清掉「容器作为收件方」的脏数据，并标注容器署名的历史消息（不删数据）。
6. **自检**：UI「设置 → 版本与更新 → 检查更新」应显示最新 `v0.3.0`；让任意会话在群里发言，署名应为**该会话自己的节点**，而不是 `dsh@<主机>`。

## [0.2.0] - 2026-10-04

### 新增

- **消息 Markdown 渲染**：react-markdown + GFM + rehype-sanitize + rehype-highlight 管线；设置页「消息渲染」范围三选（全部默认 / 仅 AI 回复 / 关闭，即时生效）；普通气泡逐条「看原文 / 看排版」切换与「复制」按钮；mention 高亮在 MD 视图内递归注入；系统消息/批示卡不参与。
- **DSH 原生工具面**：`ctx.tools.register` 逐调用按会话注入身份；出站身份 fail-closed（删除「最近 running」启发式，修真机身份冒用）；发布提示前校验磁盘现值可自愈；`tools.register` 方法形式调用修复（12 个原生工具注册失败）；`hub.mcp()` 传裸 `send` 致原生工具面整体失效亦已修复。
- **反寒暄规则 R1/R2**（沟通规范第 5/6 条，五落点同步）：agent 对 agent 回复只写一次 `reply`、不重发会话（「没有观众」）；agent 对人类答复不复述工具输出（人类已可见）。
- **群聊删除成员**：`POST /api/groups/:id/members/remove`——守卫链 400/404/400/404/409（`cannot_remove_last_member` 保底留 1 人），成功向余下成员发 `kind=system` 通知（0 wake）；群成员行悬停「移出」两步确认。
- **解散群聊**：`POST /api/groups/:id/dissolve`——先广播「群已解散」（复用 `message` 封套，四事件红线不动）再事务级联删 `wake_jobs→messages→read_states→participants→conversations`；资料卡 danger 区按钮 + alertdialog 显式确认，取消零副作用。
- **添加成员弹窗多选**：GroupInfo 内联选择器改为遮罩弹窗，内嵌 MemberPicker（多选树/搜索/离线折叠栏原样），确认走既有 `addGroupMember`；取消/Esc/遮罩不提交。
- **会话列表「群聊」分组头**：静态分组头（仅箭头可交互）默认收起、`agentchat:groupSectionExpanded` 持久化，群会话整体置顶于普通会话之上；喊话行保持首位。
- **双 agent 私聊**：发起方消息居左（发起方=首条非系统消息 sender）、对向居右、头像随侧；标题 =「{发起方}和{对方}的私聊」；含人类的 DM 与群聊规则零变化。

### 修复

- **自发消息优雅拒绝**：`self_send` 稳定错误码 + 干净 JSON 载荷 + 服务端日志（HTTP 409 / MCP 映射），不再把驱动层 `SqliteError` 原样透出。
- **MCP 错误映射审计**：`AgentNotFoundError` / `SqliteError` / `ZodError` 归一映射（`mcp/context.ts` errorResult），杜绝 raw 错误泄漏。
- **MCP `group` 工具入参 schema 空壳**（agent「难一次成功、提示也救不了」的根因）：`z.discriminatedUnion` 在 Zod→JSON Schema 转换中降级为 `properties:{}`，广告面撒谎；拍平为单 `z.object`（`op` 枚举三值 + `name/member_ids/group/member` 全字段）+ `superRefine` 按 op 必填（稳定可读错误文案）；`group` 描述改三签名、`ask` 补 `mentions` 群问必填与 `wait.scope` 缺省 `all`；契约测试锁 12 工具 `properties` 非空 + `op` 枚举，真端点实测空壳数 0。
- **@ 提及配色**：`mention-hit`/chip/badge 全面 token 化（jade 同族，对比度 4.69/5.35 过 AA），去除浅黄/绿/白混用与裸 hex。
- **气泡按钮样式**：「看原文/看排版」「复制」按钮照 `bubble-revoke` 派生 token 四态（hover/active/disabled/focus）；解散 danger 按钮同批 token 化。

### 样式

- **P2 美观批次（六项）**：群资料面板密度收紧一档（`.group-info` padding `space-5→space-4`）；气泡 max-width 加宽至 `min(36rem, 80%)`；窄视口 45rem rail 指示条负 inset 收敛为 0（不越界，radius/height 微调保观感）；行内滚动条改细窄 overlay（`scrollbar-width: thin` + hairline token + WebKit 3px 定制，全仓无残留 `none`）；rail 指示条纯 CSS 贴 rail 右缘（方案 A，`right: calc(space-2 * -1)`，几何断言锁 ≤1px）；`.member-rename-input` 补 token 描边与焦点环（与后载规则视觉等价，断言锁定）。
- **P2-fix（真机验收两修）**：群资料成员行按钮错位修复——flex 换行判定根因（`.member-name` 基准 `1 1 auto → 1 1 0`，长名内容宽不再触发换行挤掉尾部按钮；图标/状态点/按钮 `flex-shrink: 0`；编辑态表单整行换行保留）；聊天栏边界加深——新 `--color-hairline-strong` token 用于气泡边框、视图头底边、输入条顶边（范围限聊天栏，设置/资料面板不动）；选中会话态——jade 9% 浅底 + 左缘 inset accent 竖条（照喊话行视觉语言）。

### 测试

- 台账 Minor 补锁 4 项（键独立 / busy 分支 / 红 JSON 另存 / prune 500 注入）。
- **e2e 复活**（限授权两 spec）：`playwright.config.ts` 端口参数化 `AGENTCHAT_E2E_PORT`（默认 4646 不变，真机占用时 4647 隔离自举 + 临时 `AGENTCHAT_HOME`）；groups-shout 三处过时断言适配（logical 归折叠栏先展开 / 展开态跨 picker 持久化按 `aria-expanded` 条件展开 / §14.4 runtime-only 投递 5→4、ack 后 4→3）——**3/3 passed**。
- 台账 Minor 补锁：`meta.action`（group_remove/group_dissolve）postSystem seam 断言、shout 分区 DOM 锁。
- **V1.1 视觉仪器前置**：X 轴豁免加 `textOverflow: ellipsis && clientWidth > 0` 双门槛（零宽不豁）；`.member-name` 回退 `overflow:hidden`；X 轴豁免白名单最小化（仅 P2-5 方案 A 的两类有意延伸元素）。
- **V1 视觉场景 +7**：添加成员弹窗、解散确认、移出确认（各 full+region）、45rem 窄视口（bottom=0 断言）、桌面贴边几何（≤1px）、选中会话计算样式（g4：jade tint≠纯白 + boxShadow 含 inset + 对照行反证）—— `npm run visual` 5 → **12 passed**。
- 新增样式单测 `p2-style.test.ts`（六项规则，首跑 8/8 红→绿）与 `p2-fix.test.ts`（边界/选中态规则锁）。

## [0.1.0] - 2026-10-01

首个公开发布：聚合「群聊 @提及」功能主线（12 任务 + 6 项真机反馈修复 + 样式/视觉工程化）与 DSH 桌面端适配器，共 37 个提交（`9877825d..v0.1.0`）。

### 新增

- **群聊 @提及**：`@名字` 单点解析（`shared/mentions.ts` 的 `resolveMentions`/`splitMentions`）、消息唤醒集合 T、按 @目标投递门控；输入栏 `@` 候选下拉（仅群成员，Enter/Tab/点击插入）；正文提及高亮 + `meta.mentions` 补充 chip；会话被@标记。
- **群内批示（ask）**：多目标一卡一目标、`asks[]` 出参三形态等待、三错误码（`mentions_required` / `mention_not_found` / `not_participant`）。
- **roster 会话过滤**：`roster?conversation=` 成员闸门、`op:list` 出 `member_cards`、拉人入群 system 通知（0 唤醒）。
- **成员自定义显示名**：`custom_name` 列与迁移、展示名优先级 `agentDisplayName`、资料卡与群成员行两入口改名（`PATCH /api/agents/:id`）。
- **反寒暄沟通规范**：四条规则写入注入消息头、工具描述与 README（spec §15，防 agent 复读/寒暄）。
- **DSH 桌面端适配器**（`adapters/dsh/`）：Cordis bundle 插件 + stdio MCP 桥 + 安装器（plan/apply/yaml）+ 115 项测试与 `docs/adapters-dsh.md` 文档；节点展示名采用 DSH 会话标题（机器唯一名不变）。
- **《编写 AgentChat 适配器》指南**（`docs/adapters-guide.md`）：Hub 契约、宿主能力矩阵、9 条真机事故表、验收清单。
- **视觉测试仪器 V1**：`playwright.visual.config.ts` + `tests/visual/`（路由 mock、层 1 按轴溢出断言、层 2 区域截图），`npm run visual` 5 场景。
- **离线死节点清理**：`POST /api/admin/prune-sessions`（预览-确认-执行）+ 设置页「清理离线历史会话」按钮。
- **workbuddy 适配器可行性分析**（`docs/adapters-workbuddy-feasibility.md`）：按指南五问法逐条取证的第四个适配器评估。

### 修复

- **P1** 收养成功即开空闲轮询，新会话无需先跑回合即可被唤醒（spec §14.1）。
- **P2** 回执收件人集合收敛为该消息 `wake_jobs` 集合，被@群聊不再永卡「排队中」（§14.2）。
- **P3** 传输门 token 轮换后 401 一次性自愈，日志不再刷屏（§14.3）。
- **P6** `@` 闸门落到投递层：jobs 即投递台账，runtime 无行不投递、T 全员发送即建行（§14.4）。
- **P4** 批示卡答复控件按 target 渲染门槛——非我对象只读。
- 人类@错字唤醒全员锁定用例；群 ask 成员资格闸门 `not_participant`（human 豁免）。
- 私聊显示发送者身份行，`[子·根名]` 徽标仅群聊渲染（BUG-1）。
- 选人树二级展开不再收起一级（`toggleIndependent`）。
- rename 500/502 回落通用 `rename_failed` 码；@ 候选失败态不出下拉；候选源改为该群成员 roster。
- 删除陈旧「数据接入将在后续任务完成」占位文案。

### 样式

- 原生 rename 表单控件与 `.group-add-select` 箭头拉入设计 token 体系（含禁用态与渐变盒修正）。
- 层 1 溢出 offender **43 → 0**（rail / node-dot / member 行纯 CSS 根因修复）。
- 群资料「添加成员」超宽、选人器「离线/历史会话」折叠栏、✎/X 占位跳位三修 + 层 1 按轴豁免仪器（V1.1）。

### 工程化

- 测试 833 → **948**（79 文件）全绿；typecheck / build 0 错；`npm run visual` 5/5。
- `server/routes/mcp.ts` 错误映射审计与 `formatMessages` 反寒暄断言。

<!--
本文件按 Keep a Changelog 风格组织；范围：自 master@9877825d 起至 v0.1.0 打点。
-->
