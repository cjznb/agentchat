# AgentChat 全量测试矩阵（T13 / task-13）

> 目标（用户原话）：**把暴露出来的问题 + 正常使用下可能出现的一切情况，全部纳入测试**。
> 本文件是矩阵的**清单与判定口径**；可执行体在同目录的 `matrix-*.test.ts`。

## 0. 怎么跑

```powershell
# 矩阵 + T6 场景（L0/L1，进程内真 Hub + 一次性临时 home）
npx vitest run adapters/test/__tests__

# 交付验收要求的完整两跑
npx vitest run adapters/test/__tests__ tests/integration
node adapters/test/cli.mjs --scenario all --spawn        # 期望 9/9

# N25（容器在 UI）由 client 侧既有用例覆盖，单独跑：
npx vitest run client/src/__tests__/member-picker.test.tsx client/src/__tests__/container-member-add.test.tsx
```

**分层**：L0 = 测试适配器（脱 LLM：真 `createHubClient`/`createIdleFlush`/`IdlePoller` + 真 core，只替换"注入宿主"一步）；
L1 = 单测 / 组件测试（适配器内部、前端）；L2 = 真机 DSH（需真实 LLM 宿主，人工）。
L0 用例的注入录音（`host.deliveries`）与库内原始行（`GET /api/test/dump`）构成**两级断言**。

## 1. 文件分工（单文件 ≤ 250 纯行，CONTRIBUTING.md:80 红线）

| 文件 | 内容 | 纯行 |
|---|---|---|
| `matrix-kit.ts` | 共享夹具：进程内真 Hub + T6 无头假宿主 + MCP SDK 客户端 + dump 强类型视图（非 `.test.ts`，vitest 不收集） | 231 |
| `matrix-1-registration.test.ts` | N01–N04、N27、N28 | 147 |
| `matrix-2-messaging.test.ts` | N05、N06、N07、N08、N10 | 178 |
| `matrix-3-inbox.test.ts` | N12、N15–N18 | 157 |
| `matrix-4-delivery.test.ts` | N09、N13、N14、N30 | 142 |
| `matrix-5-scale.test.ts` | N21、N22、N23 | 104 |
| `matrix-6-ask.test.ts` | N19、N19b、N20、N24 | 199 |
| `matrix-7-defects-a.test.ts` | D01–D06、N29 | 192 |
| `matrix-8-defects-b.test.ts` | D07–D12、D12b、N11、N26 | 194 |

> 42 条最小集塞不进一个 `matrix.test.ts`，故按主题拆分；**运行命令与 ID 清单与单文件方案等价**。
> 所有用例共用同一套夹具口径，没有第二套测试基础设施。

## 2. 判定口径（写断言前必读）

1. **两级断言**：每条至少一条"库内状态"（`wake_jobs`/`messages`/`participants`/`read_states` 原始行）
   + 一条"交付物"（注入录音 / MCP 工具出参）。
2. **时钟容差**：跨进程判"到期"一律用 `lib/scenario-kit.mjs` 的 `isDue`（`retry_at <= now + CLOCK_SKEW_MS`，容差 1s）
   与 `dueEvidence`；**绝不**写裸 `retry_at <= Date.now()`。推过在途租约用 SQL 直接改 `retry_at = now-60s`（≫ 任何偏斜）。
3. **pull 预热**：夹具建会话后调一次 `warmPull`（真 `/internal/wake`），把 vendor 登记为 pull 适配器，
   避免 dispatcher 的 2s tick 改写 `attempts/retry_at` 与断言抢时序。
4. **注入前缀契约**：`assertInjectionPrefix` 把 `flush.formatMessages` 的行前缀
   `- [<id>] 来自 <from>：` 当契约断言 —— 有注入却解析不出 id 即**响亮失败**（防 P4 改坏前缀后静默变 0 导致假绿）。
5. **`it.fails` 语义**：用例断言的是**修好后的正确行为**，当前不满足 → vitest 记为"预期失败"。
   一旦修复落地，它会变成"意外通过"而报红，**强制**下一个人改回普通 `it` 并更新本文件。
   **不使用 `it.skip`**（本任务明令禁止静默跳过）。
6. **不写裸近似**：无法在 L0 直驱的生产行为（DSH 插件）单列"未覆盖/近似"（§5），不假装覆盖。

## 3. 正常使用矩阵（30 条）

| ID | 层 | 期望（断言口径） | 现状 | 文件 |
|---|---|---|---|---|
| N01 | L0 | 首次根注册 1 行；`join_token` 重注册认领同一 id；裸重名 409 `name_taken` | ✅ 通过 | 1 |
| N02 | L0 | 同 `task_ref` 重连认领同一节点且 `parent_id` 不改写；缺 `task_ref` → `task_ref_required` | ✅ | 1 |
| N03 | L0 | `kind=logical`/落库 `offline`；roster 可见；可入群；不建 job 但能取件 | ✅ | 1 |
| N04 | L0 | online→busy→idle 落库 online；子节点 offline 409 `child_never_offline`；根 offline 200；offline→busy 409 `transition_rejected`（有意裁决） | ✅ | 1 |
| N05 | L0 | queued→sending→delivered→read 逐跳（`message_status` + `wake_jobs` 双证）；租约内不重复认领 | ✅ | 2 |
| N06 | L0 | `to=<agent id>` 自动建 DM（`key=dm:<a>_<b>`）；二次发送复用同一会话；未知收件方 404 | ✅ | 2 |
| N07 | L0 | 建群 owner+成员；human/agent 两种发送者；拉人（+`group_add` 通知）；移除（+`group_remove`）；解散级联清空 | ✅ | 2 |
| N08 | L0 | @ 命中/未命中/`"*"`/名字与 id 混写；无人被 @ 时 human 回落全员、agent 0 job | ✅（**现行规格**，见 §4-D03） | 2 |
| N09 | L0 | 广播会话 `key='shout'` 无 participants；容器排除；logical 不建 job 但可取件；逐节点送达 | ✅ | 4 |
| N10 | L0 | 群 3 人 + shout 多人：每收件方各自注入恰一次、各自回执；未注入方不得假 delivered | ✅（P1 正面验证） | 2 |
| N11 | L0 | busy 期间只能排队（`pending_reason='busy'`）→ 忙时取件即送达；`urgency` 三档写入 `meta.urgency`（`urgent`/`low` 写、`normal`/缺省不写） | ✅（P3 语义 + P6 三档，**已翻转为正向断言**） | 8 |
| N12 | L0 | 离线仍建 `pending_reason=null` job；回 online 的 `makeJobsDue` 才解锁（用远期 `retry_at` 反证） | ✅ | 3 |
| N13 | L0 | refused 不写 seen、不置 accepted、后续重投；达 `REFUSAL_LIMIT=2` 转终态后不再投 | ✅ | 4 |
| N14 | L0 | 认领未回执 → 租约 `CLAIM_TIMEOUT_MS≈30s` 内不重复认领；过期重投且 seen 去重只补回执 | ✅ | 4 |
| N15 | L0 | 同 `(from, idempotencyKey)` 重发同一条消息、不新增行、不重复建 job | ✅ | 3 |
| N16 | L0 | 未投递方绝不注入原文（只投系统提醒，`revoked_at` 落库、job `cancelled`）；已投递副本保留原文 | ✅ | 3 |
| N17 | L0 | purge 清空 messages + wake_jobs，保留会话/成员；**读位点保留**（现状口径） | ✅ | 3 |
| N18 | L0 | ack 推进 `read_states`、未读递减；human 非成员也可读写（超级观察者） | ✅ | 3 |
| N19 | L0 | 选项单落 `approvals(kind=ask)`；非法选项 `invalid_choice`；首答生效 `ask_already_answered`；自由文本；超时 `timedOut` | ✅ | 6 |
| N19b | L0 | 群 ask：mentions 必填（`mentions_required`）、一目标一卡、`scope=any` 任一先回即返回 | ✅（**并发应答须换一条 MCP 会话**，见 §6-①） | 6 |
| N20 | L0 | root agent 喊话落审批单 + 审批卡；批准后执行、拒绝不执行；两种回执（`meta.result`） | ✅ | 6 |
| N21 | L0 | 60 条取空后再发 200 条仍取空（260 次注入无重复、无永久 pending） | ✅（P2 正面验证） | 5 |
| N22 | L0 | 同进程 3+ 会话并发收同一条消息，各自注入一次、无串扰；未轮询方仍 pending | ✅（P1 正面验证） | 5 |
| N23 | L0 | Hub 不可达：flush 报失败、零注入、库内无假 delivered；失败轮次按指数退避；恢复后同一 nodeId 可送达 | ✅ | 5 |
| N24 | L0 | 容器不可入群/拉群/作发送方/作 DM 收件方；`x-agent-id=容器` 无身份；容器仍可心跳上报 | ✅（P5 正面验证） | 6 |
| N25 | **L1** | 成员选择器：容器行**保留层级与可展开**但 checkbox `disabled` + 「容器」徽标 + title/aria；点击不触发 `onToggle`；错误码透出与文案 | ✅ **已由 client 侧用例覆盖**（不重复实现）：`client/src/__tests__/member-picker.test.tsx`、`client/src/__tests__/container-member-add.test.tsx`（提交 `0448700`） | — |
| N26 | L0 | `instructions` 非空含关键约束；12 条工具描述含"何时/常见错误"；`to/mentions/wait/task_ref/parent_ref/group.*/allow_custom` 有参数级 description | ✅（P4/task-10 已落地） | 8 |
| N27 | L0 | 会话头命中即该会话身份；未命中 → `identity_required` 且不回落容器；`register` 免身份 | ✅ | 1 |
| N28 | L0 | 清库后新客户端同 `task_ref` 重注册成功、可继续收发（Hub 侧自愈） | ✅ | 1 |
| N29 | L0→L1 | **部分覆盖**：补注册重试走真 `lib/retry.js`（IdlePoller 指数退避，700ms 内 ≤5 次而非 ≥10 次自旋） | ⚠️ 补注册路径 ✅；**实例根注册路径未覆盖**（见 §5-③） | 7 |
| N30 | L0 | 30 个投递周期：30 次注入无重复、`seen` 无泄漏、轮询器不重叠执行（最小注入间隔 ≥ 15ms） | ✅ | 4 |

## 4. 暴露问题回归（12 条 + 附加）

| ID | 层 | 期望（修好后的正确行为） | 现状 | 归属 |
|---|---|---|---|---|
| D01 | L0 | 同一消息对两收件方各注入一次；未注入方不得出现 `delivered` | ✅ 通过 | P1/task-7 已修 |
| D02 | L0 | 60 条连续 wake 直到取空，无永久 pending | ✅ | P2/task-8 已修 |
| D03 | L0 | agent 群内非 @ → 0 job、回执集为空；human 同场景回落全员 | ✅ **按现行规格断言**（见下） | 规格 |
| D04 | L0 | 改名后按旧名 @ 不匹配 → 进 `unmatched`、不误唤醒任何人；新名可命中 | ✅ | R6 |
| D05 | L0 | **现状**：`pending_reason=NULL`/`offline` 积压 48h 后仍 pending、`notified_at` 恒 NULL、无 `wake_failed` 通知 | ✅（现状锁） | R7 |
| D05-期望 | L0 | 该积压应最终过期并通知发送方 | 🔴 **`it.fails`（R7 未修）** | 待修（无归属任务，建议独立 R7 任务） |
| D06 | L0 | **现状**：陈旧 nodeId 取件只报失败，不发生任何补注册（L0 近似） | ✅（现状锁） | R8 |
| D06-期望 | L0 | 陈旧 nodeId 应自愈补注册（L0 近似、真机未直驱） | 🔴 **`it.fails`（R8 未修）** | 建议归 task-14（P7）或独立 R8 任务 |
| D07 | L0 | refused×2 终态 + 发送方 `wake_failed` 系统通知（真 Dispatcher 扫描），通知幂等不重发 | ✅ | R9 |
| D08 | L0 | 容器入群 409 `container_not_group_member`、零 participant、零半写通知 | ✅ | P5/task-11 已修 |
| D09 | L0 | 容器 `x-agent-id` → `identity_required`、零容器署名消息/会话；`register` 免身份 | ✅ | P5/task-11 已修 |
| D10 | L0 | busy 下仍可认领并回报 `delivered`，状态全程 busy | ✅（协议层，见 §5-②） | P3/task-9 |
| D11 | L0 | busy 心跳保持 busy（Hub 侧不变量） | ✅（适配器侧见 §5-②） | P3/task-9 |
| D12 | L0 | 注入头含**会话 id** 与「要回复就用 send」指引 | ✅ **已翻转**（`formatMessages` 落地；`- [<id>] 来自 <from>` 前缀保留） | P7/task-14 已修 |
| D12b | L0 | 错误文案 `[code]` 仍在行尾（`lib/mcp.js:64` 解析契约，恒须成立） | ✅ | 契约锁 |

### 4.1 `it.fails` 清单（2 条，全部待修、非静默跳过）

| 用例 | 失败根因（当前实测） | 翻转条件 |
|---|---|---|
| `D05-期望` | 48h 后 job 仍 `pending`（`NULL`/`offline` 两类 `pending_reason` 都没有 TTL；dispatcher 只对 `busy` 做 24h 过期） | 给 `offline`/`NULL` 积压加 TTL + 失败通知后改回普通 `it` |
| `D06-期望` | 陈旧 nodeId 下真 flush 返回 false，库内零 agents（无任何补注册） | DSH 适配器实现 404 自愈补注册后改回普通 `it`（并补真机 L2 证据） |

> **D12 已于 P7/task-14 翻转**（原第 3 条 `it.fails`）：`adapters/dsh/lib/flush.js` 的 `formatMessages`
> 现在在 `- [<id>] 来自 <from>` 前缀后追加 `（会话 <conversationId>）`，并补三条沟通规则与
> 「要回复就用 send」指引。前缀本身仍是**解析契约**（`host.mjs:injectedIds` 与
> `assertInjectionPrefix`），故会话 id 只能追加在其后。

### 4.2 规格 vs 现状（不要误判为 bug）

- **D03 / R5（agent 群内非 @ → 0 job）**：**这是现行规格**（`core/messaging.routeWake`：命中集为空时 human 回落全员、agent 回落 ∅）。
  若要改成"agent 也全员投递"，**必须先改规格**（spec §2/§14.4）再改实现与矩阵。
- **N04 的 `offline→busy` 409 `transition_rejected`**：有意裁决（展示态离线后必须先用 online/idle 重激活）。
- **N17 读位点**：purge 只删 `messages` + `wake_jobs`，**保留** `read_states`/会话/成员（现状口径，非缺陷）。
- **N11 `/ urgency`**：P6（task-12）Hub 侧**已落地**（`meta.urgency` 会写库，`normal` 不写）；
  该用例已**翻转为正向断言**（urgent/low 写、normal 不写）。适配器侧的三档映射（`prepend` 插队 /
  `busyUrgentMax` 护栏 / `low` 忙时不投）属 **P6-适配器阶段**，尚未落地，届时在 `adapters/dsh/__tests__`
  补断言（本矩阵只锁 Hub 契约面）。

## 5. 未覆盖 / 近似（如实列出，勿当成已覆盖）

1. **N25（容器在 UI）**：由 client 侧既有用例覆盖（见 §3），本矩阵**不重复实现**（`client/**` 不在 T13 写域）。
2. **D10/D11 的适配器侧**：L0 假宿主的心跳模型恒发 `idle`（`adapters/test/lib/host.mjs` 的 `createIdleFlush` 依赖注入），
   因此 L0 **不能**验证"真适配器忙时发 busy / 忙时继续轮询"。本矩阵只锁 Hub 侧不变量（busy 下可认领、状态保持 busy）；
   适配器侧由 task-9（P3）在 `adapters/dsh/__tests__` 覆盖，本任务不修改该目录。
3. **N29 的实例根注册路径**：`createRegistrationRetry`（补注册）已有真模块断言；但"每个 `agent/created` 都尝试一次根注册、
   无跨会话抑制"这半句未覆盖 —— L0 无法驱动 DSH 插件，真机行为未直驱。建议作为独立 R10 任务在 `adapters/dsh/__tests__` 补。
4. **D06 的 L0 近似**：用"真 flush 闭环在 404 下返回 false、库内零 agents"表达"陈旧 nodeId 不自愈"；
   **真机适配器行为未直驱**，归属 task-14（P7）或独立 R8 任务。
5. **L2 真机 DSH 端到端**（真实 LLM 是否收到、注入是否进模型、agent 是否会用工具）不在本矩阵；
   问答清单见 `docs/test-plan-dsh.md` §S12。
6. **并发 ask 阻塞**：`scope=any` 的等待场景必须用**第二条 MCP 会话**应答（见 §6-①），否则会撞 JSON-RPC id；
   同一会话上"阻塞调用 + 并发调用"的行为未纳入矩阵（属 `adapters/dsh/lib/mcp.js` 的已知限制）。

## 6. 矩阵运行中发现的额外问题（只报告，未改生产码）

1. **`adapters/dsh/lib/mcp.js` 的 `rpc()` 每条调用硬编码 JSON-RPC `id: 2`** → 同一条 MCP 会话上的**并发** `tools/call`
   会撞 id：实测"阻塞 `ask` + 并发 `respond_ask`"时，应答被错投/阻塞，`ask` 直到超时才返回（`timedOut=true`）。
   ✅ **P7/task-14 已修**：`rpc()` 改为**每 client 自增 id**（`initialize` 恒为 1），并加并发 id 唯一性用例
   （`adapters/dsh/__tests__/lib.test.ts` 的 `createMcpClient`）。
2. **D05 的观察**：dispatcher 的 `deferWakeJob` 会把 `pending_reason=NULL` 改写成 `offline`（`offline` 同样无 TTL），
   所以 R7 的准确表述是"**NULL 与 offline 两类积压都没有超时/通知**"，而不只是 NULL。

## 7. 运行摘要（task-13 定稿时实测原始结果）

| 项 | 数值 / 结果 |
|---|---|
| 矩阵用例总数 | **45**（普通 `it` 42 条 + `it.fails` 3 条）→ **P7/task-14 翻转 D12 后：43 普通 + 2 `it.fails`** |
| 矩阵（L0/L1） | `npx vitest run adapters/test/__tests__` → **9 文件全绿 / 58 passed + 3 expected fail**（含 T6 `host.test.ts` 16 条） |
| 交付验收两跑 ① | `npx vitest run adapters/test/__tests__ tests/integration` → **EXIT=0，40 文件全绿，508 passed + 3 expected fail**（原始日志：`.artifacts/t13-full-vitest.log`） |
| 交付验收两跑 ② | `node adapters/test/cli.mjs --scenario all --spawn` → **9/9 场景 PASS，EXIT=0**（dm 11/11、group 8/8、busy 7/7、refused 6/6、lease 9/9、offline 6/6、shout 6/6、logical 6/6、states 5/5；日志 `.artifacts/t13-cli-all.log`） |
| N25（client 侧） | `npx vitest run client/src/__tests__/member-picker.test.tsx client/src/__tests__/container-member-add.test.tsx` → **2 文件 / 16 tests 全绿** |
| 类型检查 | `npm run typecheck` → **全绿（exit 0）** |
| 单文件纯行 | 全部 ≤ 250（最大 `matrix-kit.ts` 231） |
| 生产码改动 | **零**（本任务只新增 `adapters/test/__tests__/matrix-*` 与 `docs/test-matrix.md`） |
| 未覆盖 | N25（client 侧覆盖）、N29 实例根注册半句、D10/D11 适配器侧、L2 真机（见 §5） |
| `it.fails`（待修） | D05-期望（R7）、D06-期望（R8）—— 见 §4.1（**D12 已由 P7/task-14 翻转**，从 3 条降到 2 条） |

> 定稿时（2026-11-10 10:30 前后）P3（task-9）与 P4（task-10）正在并发落地：
> D10/D11/N26 已可断言"正确行为"且通过。
> **D12 已落地（P7/task-14）**：注入头补齐会话 id + 三条沟通规则 + 「要回复就用 send」指引，
> 故 `it.fails` 中的 D12 已改回普通 `it`（见 §4.1 的说明）。
> **N11 已翻转（P6/task-12 Hub 侧）**：`urgency` 三档现在会写 `meta.urgency`（`normal`/缺省不写，
> 保既有 golden），故该用例已从"库内无 urgency 痕迹"的现状锁改为**正向三档断言**（urgent/low 写、
> normal 不写）。适配器侧的插队/打断映射仍属 **P6-适配器阶段**（`prepend` 插队 / `busyUrgentMax` 护栏 /
> `low` 忙时不投），本矩阵覆盖的是 Hub 契约面。

