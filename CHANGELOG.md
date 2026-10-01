# 版本更新日志

本项目遵循语义化版本，重大变更记录于此。首个公开版本基线：`v0.1.0`。

## [0.1.0] - 2026-10-01

首个公开发布：聚合「群聊 @提及」功能主线（12 任务 + 6 项真机反馈修复 + 样式/视觉工程化）与 DSH 桌面端适配器，共 35 个提交（`9877825d..v0.1.0`）。

### 新增

- **群聊 @提及**：`@名字` 单点解析（`shared/mentions.ts` 的 `resolveMentions`/`splitMentions`）、消息唤醒集合 T、按 @目标投递门控；输入栏 `@` 候选下拉（仅群成员，Enter/Tab/点击插入）；正文提及高亮 + `meta.mentions` 补充 chip；会话被@标记。
- **群内批示（ask）**：多目标一卡一目标、`asks[]` 出参三形态等待、三错误码（`mentions_required` / `mention_not_found` / `not_participant`）。
- **roster 会话过滤**：`roster?conversation=` 成员闸门、`op:list` 出 `member_cards`、拉人入群 system 通知（0 唤醒）。
- **成员自定义显示名**：`custom_name` 列与迁移、展示名优先级 `agentDisplayName`、资料卡与群成员行两入口改名（`PATCH /api/agents/:id`）。
- **反寒暄沟通规范**：四条规则写入注入消息头、工具描述与 README（spec §15，防 agent 复读/寒暄）。
- **DSH 桌面端适配器**（`adapters/dsh/`）：Cordis bundle 插件 + stdio MCP 桥 + 安装器（plan/apply/yaml）+ 115 项测试与 `docs/adapters-dsh.md` 文档。
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
