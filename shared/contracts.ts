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
