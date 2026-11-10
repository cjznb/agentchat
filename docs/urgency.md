# 消息紧急度（urgency）语义与限制

> 状态：**Hub 侧已落地**（P6 / task-12）；**DSH 适配器映射待 P6-适配器阶段**（本文 §5 是它的接入契约）。
> 相关：`shared/contracts.ts`（`MESSAGE_URGENCIES` / `messageUrgencySchema` / `urgencyOf` / `urgencyMeta`）、
> `server/core/messaging.ts`（`sendMessage`/`shout`）、`server/core/ask.ts`、`server/routes/internal.ts`（`POST /internal/wake`）、
> `server/mcp/tools.ts`（`send`/`message_status`）、`server/core/permissions.ts`（`shoutPayloadSchema`）。

## 1. 三档语义

| 档位 | Hub 侧含义 | 期望的 DSH 适配器行为（§5） |
|---|---|---|
| `low` | 可等待：不紧急，忙时不投 | 仅对方 **idle** 时 `followup`；running 期间**不投**（不注入、不占忙时配额），留到回合结束由空闲取件送达 |
| `normal`（缺省） | 与今天完全一致 | idle → `followup`；running → `steer`（P3 现有路径），**计入**忙时配额 |
| `urgent` | 优先：下一个 step 边界前可见 | running 时 `inbox.prepend('next-step', msg)` **插队**；不占 `busyInjectMax`，另受 `busyUrgentMax` 洪泛护栏约束（§5.2） |

**Hub 不排序**：Hub 侧没有优先级队列，`urgency` 只是随消息与回执传递的**元数据**；
真正决定"何时注入"的是适配器（`/internal/wake` 出参已带 `urgency`）。

## 2. 默认值与字段位置

- 入参：`send` / `shout` / `ask` 的可选 `urgency`，取值 `"low" | "normal" | "urgent"`，**缺省 `normal`**。
- 落库：`messages.meta.urgency` —— **不新增 DB 列**（无迁移）。
  - `normal`（含显式传 `"normal"`）→ **不写**该字段（省体积；未带 urgency 的消息 meta 与既有 golden **逐字节一致**）；
  - `low` / `urgent` → 写 `meta.urgency`；
  - 与既有 meta **浅合并**：群消息的 `mentions`/`mentionScope`、ask 卡的 `askId`/`kind`/`question`/`options`/`allowCustom` 一律保留。
- 读取：**单源** `urgencyOf(meta)`（`shared/contracts.ts`）——非法值/缺省 → `"normal"`；
  `/internal/wake`、`message_status` 与适配器**都调它**，禁止各处再写 `meta.urgency ?? "normal"`。
- 写入：**单源** `urgencyMeta(urgency)`（`low`/`urgent` → `{urgency}`；否则 `undefined`）。

## 3. Hub 接口面（全部 additive）

| 位置 | 变化 |
|---|---|
| MCP `send{urgency?}` | 落 `meta.urgency`；出参 `message.meta.urgency` 可直接读 |
| MCP `shout{urgency?}` | 同上；**走审批时 urgency 随 payload 保留**，批准后仍按原档投递 |
| MCP `ask{urgency?}` | **只影响卡消息的投递**（落卡 `meta.urgency`），**不影响答复链路**（答复走 `respond_ask`，与紧急度无关） |
| `POST /internal/wake` | `messages[]` 每项新增 `urgency`（既有字段与 `meta` 形状不变；老适配器忽略即可） |
| MCP `message_status` | 每项新增 `urgency`（便于区分三档与矩阵断言） |
| `shoutPayloadSchema` | 新增 optional `urgency`；**历史审批单缺该字段 → 缺省 `normal`，不报错** |

未改动：四级回执枚举与语义、`wait.until` 三模式、`receipts` 形状、`group_create`/`group_add` 的 payload（它们不产生消息，**不加** urgency）。

## 4. 限制（必须写进对使用者的说明）

1. **无法抢占正在执行的工具**：DSH 没有 step 级打断；`urgent` 的承诺是「**下一个 step 边界前可见**」，不是「立刻停下」。
2. **`cancel` 的边界**：`Agent.cancel` 必须带 `{keepInbox:true}`（默认会清空在途消息）；`cancel` 之后紧接 `steer` 会被 DSH 降级为 next-turn（`wakingAfterAbort`）——因此"打断+插队"只能写成 `cancel({keepInbox:true})` 后**等 `agent/status → idle` 再 steer**，或直接 `cancel + followup`。**默认不抢占**（显式开关，默认关）。
3. **Hub 不保证投递顺序**：`urgency` 不改变 Hub 侧的认领顺序（认领仍按 seq 推进）；同回合多档消息的先后由适配器的注入策略决定。
4. **`low` 不加速只减速**：`low` 的语义是"忙时不打扰"，在对方空闲时与 `normal` 无差别。

## 5. 适配器接入指引（P6-适配器阶段）

### 5.1 读字段
`POST /internal/wake` 的 `messages[]` 已带 `urgency`（缺省 `normal`）。适配器按档分流：

```js
for (const message of claimed.messages) {
  const urgency = message.urgency ?? "normal"   // 老 Hub 无此字段时回落 normal
  // low    + 忙 → 不注入，放回队列（下次空闲取件再送）
  // normal + 忙 → steer（现状）
  // urgent + 忙 → inbox.prepend('next-step', msg)
}
```

### 5.2 与 P3 忙时配额（`busyInject` / `busyInjectMax`）的交互

| 档 | 忙时是否注入 | 计 `busyInjectMax`（缺省 1/忙回合） | 计 `busyUrgentMax`（缺省 3/忙回合） |
|---|---|---|---|
| `low` | 否（留到回合结束） | 否 | 否 |
| `normal` | 是（`busyInject=false` 时整体回退为"忙时不投"） | **是** | 否 |
| `urgent` | 是（插队） | **否** | **是** |

- `urgent` 不占 `busyInjectMax`：否则 `busyInjectMax=1` 时一条普通消息就能把紧急消息挤掉，紧急度形同虚设。
- `busyUrgentMax`（**新增护栏，缺省 3**）：单忙回合紧急消息的注入上限，防止紧急洪泛把一个忙回合切成很多段；用尽后紧急消息与普通消息一样排队到回合结束。
- 三者都受 `busyInject=false` 总开关约束（关闭 → 忙时一律不取件）。

### 5.3 可观测
- 适配器日志应打印 `urgency` 与所选投递手段（`followup` / `steer` / `prepend`）。
- 发送方可经 `message_status` 看 `urgency` + 四级回执（是否 delivered/read）。

## 6. 兼容性

- **老适配器**：不读 `urgency` 即完全不受影响（新增字段被忽略）。
- **老 Hub + 新适配器**：`message.urgency` 缺失 → 适配器回落 `normal`（§5.1）。
- **历史审批单**：payload 无 `urgency` → `normal`，批准执行不报错。
- **既有 golden**：`normal`/缺省不写 `meta.urgency`，未传 urgency 的消息 meta 与改动前逐字节一致。

## 7. 验证

```
npx vitest run tests/integration/urgency.test.ts tests/integration/mcp.test.ts
npx vitest run tests/unit
npm run typecheck
```

`urgent` 的真实"插队"效果需 L2 真机（DSH）验证：忙时发一条 `urgent`，观察是否在 ≤1 个 step 边界内可见、且日志显示走 `prepend`；`low` 应等到回合结束才出现。
