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

/** MCP 工具名（spec §9 十个工具，顺序即表序） */
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

/** 十工具入参（键恰为 MCP_TOOLS；spec §9 参数列的 zod 化）。 */
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
} as const satisfies Record<McpToolName, z.ZodType>

export type McpToolInput<N extends McpToolName> = z.infer<(typeof MCP_TOOL_INPUTS)[N]>
