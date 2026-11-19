# v0.3.2 · 小版本（上下文体积优化 + 两处真机修复）

> 完整对比：https://github.com/cjznb/agentchat/compare/v0.3.1...v0.3.2
> **建议所有 0.3.x 用户升级**：本版把 MCP 返回体积砍掉 76%–97%，直接减少每轮上下文消耗。
> 升级步骤与 v0.3.0 相同（见 v0.3.0 发布的「更新须知（必须做的事）」），**本次无需数据迁移**；
> 唯一行为变化是 roster 与 inbox/conversation 的默认值（见下「变更」小节）。

### 变更（**返回体积：roster 默认值翻转 + 列表分页/正文预览**）

- **`roster` 默认 `view=compact`**：扁平精简节点（id/name/status/vendor/kind/parent_id/role_tag/unread/depth），**默认不含离线/退役**（祖先链保留），支持 `include_offline`/`include_retired`/`limit`/`cursor`。**真机实测 85.6 KB → 2.5 KB（−97%）**；旧行为用 `view:"tree"`，只要计数用 `view:"summary"`（≈2 KB，含根节点概览）。
- **`inbox` / `conversation` 分页与正文预览**：默认 `limit` 均 20（原 50），新增 `preview_chars`（inbox 200 / conversation 300，`0`=全文），返回 `has_more` + `next_after`/`next_before`；截断条目带 `truncated`/`body_chars`。**真机实测：`conversation` 102.2 KB → 16.1 KB（−84%）；`inbox` 47.9 KB → 11.7 KB（−76%）**。
- **`group{op:list}` 分页**（默认 50 群，`has_more`/`next_cursor`）；**`message_status` 单次上限 50 个 id**。
- **工具描述瘦身**：13 条描述六行 → 三行（保留「何时」「常见错误」「信息增量/禁纯回执」关键词），合计 **10.5 KB → 6.9 KB（−35%）**；`instructions` 指南新增「九、返回体积」小节。

### 变更（**默认值翻转：行为级不兼容**）

- **`inbox` 默认排除自发消息**（DM/群）：`inbox` 返回的是"各会话已读位点之后"的消息，而**自己发出的消息同样落在自己的位点之后**（发消息不推进读位点，只有 `ack` 会）——于是"轮询 `inbox` → 逐条回复"的客户端会形成**自激环路**（回复产生新消息 → 又被轮询到），且 `self_send` 挡不住（它只覆盖 `to=自己`，群回复是对群 id 的正常发送）。
  现在默认排除自发；需要旧行为时传 **`include_self: true`**（additive 参数）。**两类例外仍保留自发可见**：**喊话广播**（发送者需看到自己那条，既有 DoD）与 **`system` 通知**（入群/ask 卡必须达）。
  受影响方：自行轮询 `inbox` 的外部脚本客户端（若坚持 `include_self: true`，请自行按 `fromAgentId ≠ 自己` 过滤）；DSH 适配器不受影响（注入按 `wake_jobs` 走）。配套更新：`inbox` 六行工具描述、`docs/test-plan-dsh.md` §7.1/§7.4。

### 修复

- **MCP 会话失效（404）在同调用内自愈**：Hub 重启、或 MCP 会话**空闲 TTL 30 分钟**淘汰后，客户端缓存的 `mcp-session-id` 失效，`tools/call` 直接吃 404。旧行为要等**下一次**调用才自愈 —— 而空闲 agent 恰恰是**被唤醒要回话**时才调工具，等于每次久闲后第一次回话必失败（写工具下模型可能"重讲一遍内容"→ 重复消息）。
  现在 `adapters/dsh/lib/mcp.js` 检测 404 → 丢弃缓存会话 → **单飞重握手**（并发只握一次、client 原子替换）→ **原样重发同一 payload 一次**（调用方的 `idempotencyKey` 自动复用；依据：`server/routes/mcp.ts` 在转发前查表，404 保证该次调用**未执行**）。重握手本身失败则**原样透出原始错误**，绝不伪装成功；重发仍 404 抛稳定码 **`mcp_session_expired`**（文案写明"该次调用未执行，可原样重试"）。
- **两类失败的可重试性分开告知模型**：`mcp_session_expired` → 可原样重试；transport 类（网络/超时/耗尽）→「**结果未知**，重试请带 `idempotencyKey`」，避免模型对写工具盲重发造成重复消息。
- 回归：新增 `adapters/dsh/__tests__/mcp-session-heal.test.ts`（5 例：重发成功且**身份头不变**、二次 404 稳定码、重握手失败透出原始错、并发 404 单飞、非 404/网络错不重试）。

