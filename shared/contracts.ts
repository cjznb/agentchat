/**
 * 共享契约 —— 各任务唯一导入源。
 *
 * 值以 spec（`docs/superpowers/specs/2026-09-25-agentchat-design.md`）为准，
 * 顺序即 spec 表述顺序，**禁止改动已有取值**；zod schema 由锁定枚举派生，
 * 供边界校验与 `z.infer` 复用（zod v4 语法）。
 */
import { z } from "zod"

// ── 锁定枚举（as const） ────────────────────────────────────────────

/** 节点状态（spec §5.1 四态） */
export const AGENT_STATUS = ["online", "busy", "offline", "retired"] as const
export type AgentStatus = (typeof AGENT_STATUS)[number]

/** 节点种类（spec §5.1：真实运行时 / 手动逻辑节点） */
export const AGENT_KIND = ["runtime", "logical"] as const
export type AgentKind = (typeof AGENT_KIND)[number]

/** 阻塞发送等待模式（spec §6.2，默认 `either`） */
export const WAIT_UNTIL = ["received", "message", "either"] as const
export type WaitUntil = (typeof WAIT_UNTIL)[number]

/** 四级投递回执（spec §6.3，按流转顺序） */
export const RECEIPT_STAGES = ["queued", "sending", "delivered", "read"] as const
export type ReceiptStage = (typeof RECEIPT_STAGES)[number]

/** WebSocket 事件封套 type（spec §Global Constraints） */
export const WS_EVENT_TYPES = ["message", "receipt", "agent", "approval"] as const
export type WsEventType = (typeof WS_EVENT_TYPES)[number]

/** MCP 工具名（spec §9 十一个工具，顺序即表序；`ask`/`respond_ask` 为 2026-09-27 追加） */
export const MCP_TOOLS = [
  "register",
  "send",
  "inbox",
  "ack",
  "roster",
  "conversation",
  "group",
  "shout",
  "status",
  "message_status",
  "ask",
  "respond_ask",
] as const
export type McpToolName = (typeof MCP_TOOLS)[number]

// ── zod v4 schema（由锁定枚举派生） ─────────────────────────────────

export const agentStatusSchema = z.enum(AGENT_STATUS)
export const agentKindSchema = z.enum(AGENT_KIND)
export const waitUntilSchema = z.enum(WAIT_UNTIL)
export const receiptStageSchema = z.enum(RECEIPT_STAGES)
export const wsEventTypeSchema = z.enum(WS_EVENT_TYPES)
export const mcpToolNameSchema = z.enum(MCP_TOOLS)

// ── WS 事件封套（spec §Global：`{type, seq, payload}`，连接参数 `?since=<seq>`） ──
// payload 的具体形状由各事件任务在自身模块内细化，契约层只锁定信封。

export const wsEventSchema = z.object({
  type: wsEventTypeSchema,
  seq: z.number().int().nonnegative(),
  payload: z.unknown(),
})

export type WsEvent = z.infer<typeof wsEventSchema>

// ── 审批枚举与快照（spec §8；Task 9 自 store/approvals 上移，供 REST/WS/前端共用） ──

/** 受限动作（spec §8 三入口，与 messaging 三入口一一对应）。 */
export const APPROVAL_ACTIONS = ["shout", "group_create", "group_add"] as const
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number]

/** 审批单状态（schema.sql `approvals.status` 的 CHECK 镜像；`answered` = §17 批示首答落定）。 */
export const APPROVAL_STATUS = ["pending", "approved", "rejected", "expired", "answered"] as const
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number]

export const approvalActionSchema = z.enum(APPROVAL_ACTIONS)
export const approvalStatusSchema = z.enum(APPROVAL_STATUS)

/** 单据种类（spec §17.2 决策②：一套 `approvals` 状态机两用；WS `approval` 事件的判别字段）。 */
export const APPROVAL_KINDS = ["action", "ask"] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]
export const approvalKindSchema = z.enum(APPROVAL_KINDS)

/**
 * ask 单的 `action` 占位（spec §17.2；`approvals.action` 列 NOT NULL）。
 * `approvalActionSchema` 仍锁定三值审批动作；本值域 = 三值 ∪ `'ask'`，
 * 供快照/出参容纳两种 kind（R1）。
 */
export const ASK_ACTION = "ask" as const
export const approvalActionValueSchema = z.union([approvalActionSchema, z.literal(ASK_ACTION)])
export type ApprovalActionValue = z.infer<typeof approvalActionValueSchema>

/** 审批单快照（`approval` WS 事件 payload / `GET /api/approvals` 元素线格式）。 */
export const approvalSnapshotSchema = z.object({
  id: z.string(),
  requesterAgentId: z.string(),
  action: approvalActionValueSchema,
  payload: z.record(z.string(), z.unknown()),
  status: approvalStatusSchema,
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().nullable(),
})
export type ApprovalSnapshot = z.infer<typeof approvalSnapshotSchema>

// ── 通知页线格式（spec §11.5/§17.3；Task 4 数据面，Plan 3 UI 消费） ──

/**
 * 通知条目（`GET /api/notifications` 元素）：单据全量 + 深链锚点。
 * `cardMessageId`/`conversationId` 由卡消息（`meta.askId`/`meta.approvalId`）反查得到，
 * 供 UI 深链 `?conversation=<id>&msg=<cardMessageId>` 滚动定位；卡缺失时为 `null`（理论不出现）。
 * `readAt` 缺省 = 未读（单用户 MVP：全局已读）。
 */
export const notificationEntrySchema = z.object({
  id: z.string(),
  kind: approvalKindSchema,
  target: z.string(),
  action: approvalActionValueSchema,
  payload: z.record(z.string(), z.unknown()),
  status: approvalStatusSchema,
  result: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().optional(),
  readAt: z.number().int().nonnegative().optional(),
  cardMessageId: z.string().nullable(),
  conversationId: z.string().nullable(),
})
export type NotificationEntry = z.infer<typeof notificationEntrySchema>

/** `GET /api/notifications` 响应体（按 `scope` 过滤后的条目数组，最新在前）。 */
export const notificationListSchema = z.array(notificationEntrySchema)

// ── roster 线格式（spec §5.1/§9；Task 9 自 core/agents 上移，供 REST/WS/前端共用） ──

/** roster 节点卡（字段名对齐 spec 的 snake_case）。 */
export interface RosterNode {
  readonly id: string
  readonly name: string
  readonly kind: AgentKind
  readonly parent_id: string | null
  readonly vendor: string
  readonly model: string
  readonly status: AgentStatus
  readonly status_text: string | null
  readonly purpose: string | null
  readonly role_tag: string | null
  readonly remark: string | null
  readonly unread: number
  readonly children: readonly RosterNode[]
}

const rosterNodeSchema: z.ZodType<RosterNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    kind: agentKindSchema,
    parent_id: z.string().nullable(),
    vendor: z.string(),
    model: z.string(),
    status: agentStatusSchema,
    status_text: z.string().nullable(),
    purpose: z.string().nullable(),
    role_tag: z.string().nullable(),
    remark: z.string().nullable(),
    unread: z.number().int().nonnegative(),
    children: z.array(rosterNodeSchema),
  }),
)

/** `GET /api/roster` 响应体（森林根数组）。 */
export const rosterTreeSchema = z.array(rosterNodeSchema)

// ── WS 事件 payload（spec §Global：`{type, seq, payload}`；Task 9） ──

/** `message`：新消息（会话 id + 消息短 id + 全局 seq）。 */
export const wsMessagePayloadSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  seq: z.number().int().nonnegative(),
  from: z.string(),
  body: z.string(),
  kind: z.enum(["text", "system"]),
  createdAt: z.number().int().nonnegative(),
})
export type WsMessagePayload = z.infer<typeof wsMessagePayloadSchema>

/** `receipt`：回执变化（消息 id + 各收件方当前 stage）。 */
export const wsReceiptPayloadSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  seq: z.number().int().nonnegative(),
  receipts: z.array(z.object({ agentId: z.string(), stage: receiptStageSchema })),
})
export type WsReceiptPayload = z.infer<typeof wsReceiptPayloadSchema>

/** `agent`：节点变化（roster 全树快照；节点数小，整树最简单可用）。 */
export const wsAgentPayloadSchema = z.object({ tree: rosterTreeSchema })
export type WsAgentPayload = z.infer<typeof wsAgentPayloadSchema>

/**
 * `approval`：审批/批示单变化（单据快照 + `kind` 判别）。
 * `kind` 置顶为**判别字段**（spec §17.2 决策②）：WS 消费者无需窥探 `approval.action`
 * 即可区分审批单（`action`）与批示单（`ask`）；不新增第五类事件（`WS_EVENT_TYPES` 锁定四类）。
 */
export const wsApprovalPayloadSchema = z.object({
  kind: approvalKindSchema,
  approval: approvalSnapshotSchema,
})
export type WsApprovalPayload = z.infer<typeof wsApprovalPayloadSchema>

/** 四类事件 payload schema（键恰为 WS_EVENT_TYPES，Plan 2 前端复用）。 */
export const WS_PAYLOAD_SCHEMAS = {
  message: wsMessagePayloadSchema,
  receipt: wsReceiptPayloadSchema,
  agent: wsAgentPayloadSchema,
  approval: wsApprovalPayloadSchema,
} as const satisfies Record<WsEventType, z.ZodType>

export type WsEventPayload<T extends WsEventType> = z.infer<(typeof WS_PAYLOAD_SCHEMAS)[T]>

/**
 * `resync` 首帧（独立于信封，`type` 不在锁集 `WS_EVENT_TYPES`）：客户端收到即
 * **丢弃本地状态、整页重拉 REST** —— 触发条件为 `?since` 早于环形缓冲最老事件，
 * 或进程重启后计数不匹配（`since` 大于当前计数）。
 */
export const WS_RESYNC_TYPE = "resync" as const
export const wsResyncSchema = z.object({
  type: z.literal(WS_RESYNC_TYPE),
  seq: z.number().int().nonnegative(),
  payload: z.object({}),
})
export type WsResync = z.infer<typeof wsResyncSchema>

/** 服务端出帧：信封事件 ∪ `resync` 首帧。 */
export const wsServerFrameSchema = z.union([wsEventSchema, wsResyncSchema])
export type WsServerFrame = z.infer<typeof wsServerFrameSchema>

// ── MCP 十工具 input schema（spec §9；Task 8） ──────────────────────
// 路由层零手写类型：server/routes/mcp.ts 全部经 `MCP_TOOL_INPUTS[name]`
// 校验入参后 `z.infer` 派生类型调 core。金样例见 tests/integration/mcp.test.ts。

/** `wait` 入参（spec §6.2；缺省锁定 285000/either，经 zod 校验后原样透传字面量）。 */
export const mcpWaitSchema = z.object({
  until: waitUntilSchema.default("either"),
  timeoutMs: z.number().int().positive().default(285000),
})
export type McpWait = z.infer<typeof mcpWaitSchema>

const mcpRegisterInput = z.object({
  join_token: z.string().optional(),
  parent_ref: z.string().optional(),
  task_ref: z.string().optional(),
  kind: agentKindSchema.optional(),
  name: z.string().optional(),
  vendor: z.string().optional(),
  model: z.string().optional(),
  purpose: z.string().optional(),
  skills: z.array(z.string()).optional(),
  role_tag: z.string().optional(),
  remark: z.string().optional(),
})

const mcpSendInput = z.object({
  to: z.string().min(1),
  body: z.string(),
  wait: mcpWaitSchema.optional(),
  idempotencyKey: z.string().optional(),
})

const mcpInboxInput = z.object({
  conversation: z.string().optional(),
  after: z.number().int().nonnegative().optional(),
  ack: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
})

const mcpAckInput = z.object({
  message_ids: z.array(z.string().min(1)).min(1),
})

const mcpRosterInput = z.object({
  filter: z.string().optional(),
  online_only: z.boolean().optional(),
})

const mcpConversationInput = z.object({
  id: z.string().min(1),
  before: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
})

const mcpGroupInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name: z.string().min(1), member_ids: z.array(z.string()).optional() }),
  z.object({ op: z.literal("add"), group: z.string().min(1), member: z.string().min(1) }),
  z.object({ op: z.literal("list") }),
])

const mcpShoutInput = z.object({
  body: z.string(),
  wait: mcpWaitSchema.optional(),
})

const mcpStatusInput = z.object({
  text: z.string(),
})

const mcpMessageStatusInput = z.object({
  ids: z.array(z.string().min(1)).min(1),
})

/** `ask` 入参（spec §9/§17：`to` = `'human'` 或目标 agent id；`wait?` 同 §6.2 阻塞语义）。 */
const mcpAskInput = z.object({
  to: z.string().min(1),
  question: z.string(),
  options: z.array(z.string()),
  allow_custom: z.boolean().optional(),
  wait: mcpWaitSchema.optional(),
})

/** `respond_ask` 入参（spec §9/§17：`choice` ∈ options 或 `text` 自由答复，二者择一）。 */
const mcpRespondAskInput = z.object({
  ask_id: z.string().min(1),
  choice: z.string().optional(),
  text: z.string().optional(),
})

/** 十一工具入参（键恰为 MCP_TOOLS；spec §9 参数列的 zod 化）。 */
export const MCP_TOOL_INPUTS = {
  register: mcpRegisterInput,
  send: mcpSendInput,
  inbox: mcpInboxInput,
  ack: mcpAckInput,
  roster: mcpRosterInput,
  conversation: mcpConversationInput,
  group: mcpGroupInput,
  shout: mcpShoutInput,
  status: mcpStatusInput,
  message_status: mcpMessageStatusInput,
  ask: mcpAskInput,
  respond_ask: mcpRespondAskInput,
} as const satisfies Record<McpToolName, z.ZodType>

export type McpToolInput<N extends McpToolName> = z.infer<(typeof MCP_TOOL_INPUTS)[N]>

// ── MCP 十工具 output schema（spec §13.5：契约防漂移；金样例见 tests/integration/mcp.test.ts） ──
// 处理器侧不强制二次校验（保持轻）：本组 schema 供契约测试校验金样例出参形状，
// 字段为「实际出参的子集」（zod object 默认 strip 未列字段），避免与内部域对象逐字耦合。

const mcpAgentOutput = z.object({
  id: z.string(),
  name: z.string(),
  kind: agentKindSchema,
  vendor: z.string(),
  model: z.string(),
  status: agentStatusSchema,
})

const mcpMessageOutput = z.object({
  seq: z.number().int().nonnegative(),
  id: z.string(),
  conversationId: z.string(),
  fromAgentId: z.string(),
  body: z.string(),
  kind: z.enum(["text", "system"]),
})

const mcpReceiptOutput = z.object({ agentId: z.string(), stage: receiptStageSchema })

const mcpConversationOutput = z.object({
  id: z.string(),
  kind: z.enum(["dm", "group"]),
  key: z.string(),
  name: z.string().nullable().optional(),
  createdBy: z.string(),
  createdAt: z.number().int().nonnegative(),
})

/** 审批单出参（内部 `Approval.decidedAt` 为 `undefined`，JSON 中缺省 → optional 而非 nullable）。 */
const mcpApprovalOutput = z.object({
  id: z.string(),
  requesterAgentId: z.string(),
  action: approvalActionValueSchema,
  payload: z.record(z.string(), z.unknown()),
  status: approvalStatusSchema,
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().optional(),
})

const mcpSendOutput = z.object({
  message: mcpMessageOutput,
  receipts: z.array(mcpReceiptOutput),
  readReceipts: z.array(mcpReceiptOutput),
  reply: z
    .object({
      timedOut: z.boolean(),
      messages: z.array(mcpMessageOutput),
      receipts: z.array(mcpReceiptOutput),
    })
    .optional(),
})

/** `shout` 出参：即时投递（同 `send`）| 审批语义（可带 `timedOut` 表示闸后等待超时）。 */
const mcpShoutOutput = z.union([
  mcpSendOutput,
  z.object({ approval: mcpApprovalOutput, timedOut: z.literal(true).optional() }),
])

/** `group` 出参：create → 群资料；add → ok / 审批；list → 群数组（snake_case 线格式）。 */
const mcpGroupOutput = z.union([
  z.object({ group: mcpConversationOutput }),
  z.object({
    groups: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        created_by: z.string(),
        members: z.array(z.string()),
      }),
    ),
  }),
  z.object({ ok: z.literal(true) }),
  z.object({ approval: mcpApprovalOutput }),
])

/**
 * `ask` 单出参（`approvalSnapshotSchema` 家族 + `kind`/`target`/`result` 判别字段，spec §17.2）。
 * 内部 `Approval.result`/`decidedAt` 为 `undefined`，JSON 缺省 → optional。
 */
const mcpAskOutput = z.object({
  id: z.string(),
  requesterAgentId: z.string(),
  kind: z.literal("ask"),
  target: z.string(),
  action: approvalActionValueSchema,
  payload: z.record(z.string(), z.unknown()),
  status: approvalStatusSchema,
  result: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().optional(),
})

/** `ask` 答复视图：已决 `{choice|text, timedOut:false}`；超时 `{timedOut:true}`（spec §9）。 */
const mcpAskReplyOutput = z.object({
  timedOut: z.boolean(),
  choice: z.string().optional(),
  text: z.string().optional(),
})

/** `ask` 出参：批示单 + 带 `wait` 时的答复视图。 */
const mcpAskToolOutput = z.object({
  ask: mcpAskOutput,
  reply: mcpAskReplyOutput.optional(),
})

/** 十一工具出参（键恰为 MCP_TOOLS；spec §9 返回列的 zod 化）。 */
export const MCP_TOOL_OUTPUTS = {
  register: z.object({
    agent: mcpAgentOutput,
    unread: z.number().int().nonnegative(),
    join_token: z.string().optional(),
  }),
  send: mcpSendOutput,
  inbox: z.object({
    messages: z.array(mcpMessageOutput),
    unread: z.number().int().nonnegative(),
    timedOut: z.boolean().optional(),
  }),
  ack: z.object({ confirmed: z.number().int().nonnegative() }),
  roster: rosterTreeSchema,
  conversation: z.object({ messages: z.array(mcpMessageOutput) }),
  group: mcpGroupOutput,
  shout: mcpShoutOutput,
  status: z.object({ id: z.string(), status_text: z.string().nullable() }),
  message_status: z.array(
    z.object({ id: z.string(), receipts: z.array(mcpReceiptOutput) }),
  ),
  ask: mcpAskToolOutput,
  respond_ask: mcpAskOutput,
} as const satisfies Record<McpToolName, z.ZodType>

export type McpToolOutput<N extends McpToolName> = z.infer<(typeof MCP_TOOL_OUTPUTS)[N]>
