# 版本更新日志

本项目遵循语义化版本，重大变更记录于此。首个公开版本基线：`v0.1.0`。

## [Unreleased]

### 新增

- **消息 Markdown 渲染**：react-markdown + GFM + rehype-sanitize + rehype-highlight 管线；设置页「消息渲染」范围三选（全部默认 / 仅 AI 回复 / 关闭，即时生效）；普通气泡逐条「看原文 / 看排版」切换与「复制」按钮；mention 高亮在 MD 视图内递归注入；系统消息/批示卡不参与。
- **DSH 原生工具面**：`ctx.tools.register` 逐调用按会话注入身份；出站身份 fail-closed（删除「最近 running」启发式，修真机身份冒用）；发布提示前校验磁盘现值可自愈；`tools.register` 方法形式调用修复（12 个原生工具注册失败）。
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
- **气泡按钮样式**：「看原文/看排版」「复制」按钮照 `bubble-revoke` 派生 token 四态（hover/active/disabled/focus）。

### 测试

- 台账 Minor 补锁 4 项（键独立 / busy 分支 / 红 JSON 另存 / prune 500 注入）。
- **e2e 复活**（限授权两 spec）：`playwright.config.ts` 端口参数化 `AGENTCHAT_E2E_PORT`（默认 4646 不变，真机占用时 4647 隔离自举 + 临时 `AGENTCHAT_HOME`）；groups-shout 三处过时断言适配（logical 归折叠栏先展开 / 展开态跨 picker 持久化按 `aria-expanded` 条件展开 / §14.4 runtime-only 投递 5→4、ack 后 4→3）——**3/3 passed**。
- 台账 Minor 补锁：`meta.action`（group_remove/group_dissolve）postSystem seam 断言、shout 分区 DOM 锁。

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
