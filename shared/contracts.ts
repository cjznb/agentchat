/**
 * 共享契约 —— 各任务唯一导入源。
 *
 * 值以 spec（`docs/superpowers/specs/2026-09-25-agentchat-design.md`）为准，
 * 顺序即 spec 表述顺序，**禁止改动已有取值**；zod schema 由锁定枚举派生，
 * 供边界校验与 `z.infer` 复用（zod v4 语法）。
 */
import { z } from "zod"
import type { MentionsEcho } from "./mentions"

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

/**
 * 消息紧急度（P6）：三档，缺省 `normal`。
 * 落库位置 = `messages.meta.urgency`（**不加 DB 列**，避免迁移）；仅 `low`/`urgent` 写入，
 * `normal`/未传不写 —— 未带 urgency 的消息 meta 与既有 golden 逐字节一致。
 * Hub 只**携带**档位（投递排序/插队由适配器实现，见 `docs/urgency.md`）。
 */
export const MESSAGE_URGENCIES = ["low", "normal", "urgent"] as const
export type MessageUrgency = (typeof MESSAGE_URGENCIES)[number]

/** WebSocket 事件封套 type（spec §Global Constraints） */
export const WS_EVENT_TYPES = ["message", "receipt", "agent", "approval"] as const
export type WsEventType = (typeof WS_EVENT_TYPES)[number]

/** MCP 工具名（spec §9 十二个工具，顺序即表序；`ask`/`respond_ask` 为 2026-09-27 追加；
 *  `whoami` 为 2026-11-10 追加——真机反馈「agent 不知道自己的昵称是什么」） */
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
  "whoami",
] as const
export type McpToolName = (typeof MCP_TOOLS)[number]

// ── zod v4 schema（由锁定枚举派生） ─────────────────────────────────

export const agentStatusSchema = z.enum(AGENT_STATUS)
export const agentKindSchema = z.enum(AGENT_KIND)
export const waitUntilSchema = z.enum(WAIT_UNTIL)
export const receiptStageSchema = z.enum(RECEIPT_STAGES)
export const messageUrgencySchema = z.enum(MESSAGE_URGENCIES)
export const wsEventTypeSchema = z.enum(WS_EVENT_TYPES)
export const mcpToolNameSchema = z.enum(MCP_TOOLS)

/**
 * 紧急度**读口径单源**（P6）：`meta.urgency` 非法或缺失 → `normal`。
 * `/internal/wake`、`message_status` 与将来的适配器一律调它，禁止各处再写 `meta.urgency ?? "normal"`。
 */
export function urgencyOf(meta: unknown): MessageUrgency {
  if (typeof meta !== "object" || meta === null) return "normal"
  const parsed = messageUrgencySchema.safeParse((meta as Record<string, unknown>)["urgency"])
  return parsed.success ? parsed.data : "normal"
}

/** 紧急度**写口径单源**（P6）：仅 `low`/`urgent` 需落 `meta.urgency`（`normal`/缺省 → 不写，省体积且 golden 不变）。 */
export function urgencyMeta(
  urgency: MessageUrgency | undefined,
): { readonly urgency: MessageUrgency } | undefined {
  return urgency === undefined || urgency === "normal" ? undefined : { urgency }
}

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
  /** 发起方 agent id（Plan 3 T8：通知页「发起方」列；与 `ApprovalEntry.requesterAgentId` 同源）。 */
  requesterAgentId: z.string(),
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
  /**
   * 技能 chips（spec §11.1 联系人信息卡）；Plan 3 T6 补入线格式。
   * Plan 3 终审 L-cheap：由可选改为**必填**——schema `skills` 已有 `default([])`，
   * 解析缺失即得空数组，客户端不再需要 `?? []` 兜底（服务端 `rosterTree` 恒产出）。
   */
  readonly skills: readonly string[]
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
    skills: z.array(z.string()).default([]),
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

// ── MCP 工具 input schema（spec §9；Task 8） ──────────────────────
// 路由层零手写类型：server/routes/mcp.ts 全部经 `MCP_TOOL_INPUTS[name]`
// 校验入参后 `z.infer` 派生类型调 core。金样例见 tests/integration/mcp.test.ts。

/** `wait` 入参（spec §6.2；缺省锁定 285000/either，经 zod 校验后原样透传字面量）。 */
export const mcpWaitSchema = z.object({
  until: waitUntilSchema.default("either").describe("等什么：message=等新消息 / received=等对方回执 / either=任一（缺省）。"),
  timeoutMs: z.number().int().positive().default(285000).describe("最长等待毫秒数（缺省 285000≈4.75min）；超时不报错，结果 timedOut=true。"),
  /**
   * 群 ask 等待范围（spec §3.4）：`all` = 全体回复才返回；`any` = 任一先回即返回。
   * 可选且**不写 default**——群 ask 默认 `all` 由 Task 4 服务端生效，schema 层不设默认以免影响 send/shout 语义。
   */
  scope: z.enum(["all", "any"]).optional().describe("仅群 ask：all=等全体（服务端缺省）/ any=任一先回即返回。"),
})
export type McpWait = z.infer<typeof mcpWaitSchema>

const mcpRegisterInput = z.object({
  join_token: z.string().optional().describe("根节点重连认领用的一次性口令（首次 register 返回值，落 $AGENTCHAT_HOME/tokens/<id>）。"),
  parent_ref: z.string().optional().describe("父节点 id 或系统名（roster 可查）；给了它就必须同时给 task_ref，否则报 task_ref_required。"),
  task_ref: z.string().optional().describe("子会话的稳定任务键（通常=会话 id）：同 task_ref 重连会认领同一节点，不新建。"),
  kind: agentKindSchema.optional().describe("节点类型：runtime=可执行任务 / logical=纯逻辑节点（收不到唤醒，只能被读）。"),
  name: z.string().optional().describe("节点名（同一命名空间唯一；撞名报 name_taken）。"),
  vendor: z.string().optional().describe("来源厂商（如 opencode/dsh）；容器节点由适配器标记 role_tag=container。"),
  model: z.string().optional().describe("该节点使用的模型标识（展示用）。"),
  purpose: z.string().optional().describe("工作概述（展示在联系人卡）。"),
  skills: z.array(z.string()).optional().describe("能力标签数组（展示用）。"),
  role_tag: z.string().optional().describe("角色标记：container=分组容器（不是聊天对象，不可入群/发言）。"),
  remark: z.string().optional().describe("备注（展示用）。"),
})

const mcpSendInput = z.object({
  to: z.string().min(1).describe('收件方：agent id（自动建/复用 DM）或群会话 id；广播用 shout，这里不接受 "*"。'),
  body: z.string().describe("消息正文；必须带信息增量（禁纯回执/寒暄/复读）。"),
  /** 结构化提及（spec §3.1）：名字 / id / id 前 8 位 / `"*"`；解析见 `shared/mentions.ts`。 */
  mentions: z.array(z.string()).optional().describe('群内点名（仅群会话生效）：成员名字 / id 前 8 位 / "*"=全体；DM 忽略。'),
  wait: mcpWaitSchema.optional().describe("给了就阻塞等对方：等新消息/等回执/任一（见内部 until/timeoutMs/scope）。"),
  idempotencyKey: z.string().optional().describe("幂等键：同 (发送方, key) 重发返回同一条消息，不新增行、不重复唤醒。"),
  urgency: messageUrgencySchema.optional().describe("紧急度：low=闲时才递 / normal=缺省（现状） / urgent=适配器插队到下一个 step 边界（不抢占正在执行的工具）。"),
})

const mcpInboxInput = z.object({
  conversation: z.string().optional().describe("只看该会话（群/DM 会话 id）的消息。"),
  after: z.number().int().nonnegative().optional().describe("分页游标：只取 seq 大于它的消息（默认 0=全部未读）。"),
  ack: z.boolean().optional().describe("true=读到即自动标已读（等价于顺手 ack），但**不等于回复**。"),
  include_self: z.boolean().optional().describe("true=连自己发出的消息一起返回（旧行为）；缺省 false=**排除自发**（喊话广播会话例外，仍能看到自己那条）。"),
  timeout: z.number().int().positive().optional().describe("阻塞等新消息的毫秒数；超时返回 timedOut=true，不是错误。"),
})

const mcpAckInput = z.object({
  message_ids: z.array(z.string().min(1)).min(1).describe("要标已读的消息短 id（send/inbox 出参的 message.id，不是 seq）。"),
})

const mcpRosterInput = z.object({
  filter: z.string().optional().describe("按名称子串过滤（含祖先链保留）。"),
  online_only: z.boolean().optional().describe("true=只保留 online 节点。"),
  /** 只返回该会话（群）的参与者（spec §4.4；shout 广播会话不接受）。 */
  conversation: z.string().optional().describe("只看某个群/会话的成员；调用者必须是该群成员，否则 not_participant。"),
})

const mcpConversationInput = z.object({
  id: z.string().min(1).describe("会话 id（不是 agent id；从 group{op:list} 或 send 出参的 conversationId 取）。"),
  before: z.number().int().nonnegative().optional().describe("分页游标：只取 seq 小于它的消息（往前翻页）。"),
  limit: z.number().int().positive().optional().describe("本页条数上限（缺省 50，最大 200）。"),
})

/**
 * `group` 入参（修复轮 E 拍平）：原 `z.discriminatedUnion("op", [...])` 在 MCP SDK 的
 * Zod→JSON Schema 转换中降级为空壳 `{"type":"object","properties":{}}`，tools/list 广告不到
 * 任何字段。改为单一平铺 `z.object`——`op` 枚举与三分支全部字段均可见（校验与广告共用同一
 * 单源，零转换代码）；分支必填性由 `superRefine` 按 op 强制，错误文案稳定可读。
 * 静态类型仍为三分支联合（消费方 server/mcp/read-tools.ts 的 `switch(op)` 收窄不变）。
 */
type McpGroupInput =
  | { op: "create"; name: string; member_ids?: string[] }
  | { op: "add"; group: string; member: string }
  | { op: "list" }

const mcpGroupInput = z
  .object({
    op: z.enum(["create", "add", "list"]).describe("动作：create=建群 / add=拉人入群 / list=列群（含 is_member）。"),
    name: z.string().min(1).optional().describe("create 必填：群名。"),
    member_ids: z.array(z.string()).optional().describe("create 可选：初始成员 agent id（创作者自动为 owner；容器会被拒）。"),
    group: z.string().min(1).optional().describe("add 必填：目标群会话 id（用 op=list 查）。"),
    member: z.string().min(1).optional().describe("add 必填：要拉进来的 agent id 或系统名。"),
  })
  .superRefine((value, ctx) => {
    if (value.op === "create" && value.name === undefined) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "create 需要 name" })
    }
    if (value.op === "add" && value.group === undefined) {
      ctx.addIssue({ code: "custom", path: ["group"], message: "add 需要 group" })
    }
    if (value.op === "add" && value.member === undefined) {
      ctx.addIssue({ code: "custom", path: ["member"], message: "add 需要 member" })
    }
  }) as unknown as z.ZodType<McpGroupInput>

const mcpShoutInput = z.object({
  body: z.string().describe("广播正文；须有信息增量（禁纯回执/寒暄/复读），全员（非容器）各收一份。"),
  wait: mcpWaitSchema.optional().describe("给了就阻塞等回执/新消息；root 节点发起还需 human 审批。"),
  urgency: messageUrgencySchema.optional().describe("紧急度（同 send）：urgent 会随审批 payload 保留，批准后仍按 urgent 投递。"),
})

const mcpStatusInput = z.object({
  text: z.string().describe("你的状态文本（人类界面可见）；不改变 online/busy/offline。"),
})

const mcpMessageStatusInput = z.object({
  ids: z.array(z.string().min(1)).min(1).describe("要查回执的消息短 id 列表（己方发出的消息）。"),
})

/** `ask` 入参（spec §9/§17：`to` = `'human'` 或目标 agent id（群会话 id 见 spec §3.1）；`wait?` 同 §6.2 阻塞语义）。 */
const mcpAskInput = z.object({
  to: z.string().min(1).describe('问谁："human"（人类）或 agent id；给群会话 id 则问全群（此时 mentions 必填）。'),
  question: z.string().describe("要对方裁决的问题（一句话说清选项差异）。"),
  options: z.array(z.string()).describe("候选项（答复只能选其中之一，除非 allow_custom=true）。"),
  allow_custom: z.boolean().optional().describe("true=允许自由文本答复（respond_ask 用 text 而非 choice）。"),
  /** 结构化提及（spec §3.1）：`to` 为群会话 id 时必填（必填校验在 Task 4 服务端）。 */
  mentions: z.array(z.string()).optional().describe("群问必填：@ 群成员（名字 / id 前 8 位），解析失败报 mention_not_found。"),
  wait: mcpWaitSchema.optional().describe("阻塞等答复；群问用 scope=all（缺省，等全体）/any（任一先回）。"),
  urgency: messageUrgencySchema.optional().describe("紧急度：只影响**卡消息的投递**（落卡 meta），不影响答复链路。"),
})

/** `respond_ask` 入参（spec §9/§17：`choice` ∈ options 或 `text` 自由答复，二者择一）。 */
const mcpRespondAskInput = z.object({
  ask_id: z.string().min(1).describe("要答复的 ask id（inbox/conversation 里的 ask 卡）。"),
  choice: z.string().optional().describe("选一个 options 里的值；不在其中且未开 allow_custom 报 invalid_choice。"),
  text: z.string().optional().describe("自由文本答复（仅 allow_custom=true 的 ask 用）；与 choice 二者择一。"),
})

/** `whoami`：无入参——读**自己**的身份卡（id / 机器名 / 展示名 / 状态 / 未读）。 */
const mcpWhoamiInput = z.object({})

/**
 * 工具入参（键恰为 MCP_TOOLS；spec §9 参数列的 zod 化）。
 */
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
  whoami: mcpWhoamiInput,
} as const satisfies Record<McpToolName, z.ZodType>

export type McpToolInput<N extends McpToolName> = z.infer<(typeof MCP_TOOL_INPUTS)[N]>

// ── MCP 工具 output schema（spec §13.5：契约防漂移；金样例见 tests/integration/mcp.test.ts） ──
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

/**
 * 提及回声线格式（Task 1 `shared/mentions.ts` 的 `MentionsEcho`）：
 * `z.ZodType<MentionsEcho>` 注解使字段类型与 import 的类型在编译期对齐（防两处漂移）。
 */
const mentionsEchoSchema: z.ZodType<MentionsEcho> = z.object({
  matched: z.array(z.object({ id: z.string(), name: z.string() })),
  unmatched: z.array(z.string()),
  scope: z.enum(["all", "explicit", "none"]),
})

const mcpSendOutput = z.object({
  message: mcpMessageOutput,
  receipts: z.array(mcpReceiptOutput),
  readReceipts: z.array(mcpReceiptOutput),
  /** 提及回声（spec §3.3：宽容回显、不阻断发送）；Task 3 起产出 → 既有金样例无此字段，故 optional。 */
  mentions: mentionsEchoSchema.optional(),
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
        /** 群成员卡片（spec §4.4：`members` id 数组不变，本字段 additive 追加）。 */
        member_cards: z
          .array(z.object({ id: z.string(), name: z.string(), status: agentStatusSchema }))
          .optional(),
        /** P4 additive：调用者是否已是该群成员（false → 先 group{op:add} 再发言，否则 not_participant）。 */
        is_member: z.boolean().optional(),
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

/** `ask` 单卡答复视图（DM / `human`）：已决 `{choice|text, timedOut:false}`；超时 `{timedOut:true}`（spec §9）。 */
const mcpAskReplyOutput = z.object({
  timedOut: z.boolean(),
  choice: z.string().optional(),
  text: z.string().optional(),
})

/** DM / `human` ask 出参（spec §3.3：形状**一字不变**，既有金样例零改动）。 */
const mcpAskSingleOutput = z.object({
  ask: mcpAskOutput,
  reply: mcpAskReplyOutput.optional(),
})

/** 群 ask 答复视图（spec §3.3/§3.4）：`replies` = 已回（按 target 判别谁回的），`pending` = 未回名单。 */
const mcpAskGroupReplyOutput = z.object({
  timedOut: z.boolean(),
  replies: z.array(
    z.object({
      target: z.string(),
      choice: z.string().optional(),
      text: z.string().optional(),
    }),
  ),
  pending: z.array(z.string()),
})

/** 群 ask 出参（spec §3.3 D2：一目标一卡，靠 `asks` 字段与 DM 形态判别）。 */
const mcpAskGroupOutput = z.object({
  asks: z.array(mcpAskOutput),
  reply: mcpAskGroupReplyOutput.optional(),
})

/** `ask` 出参：DM/human 单卡 `{ask, reply?}` | 群 `{asks, reply?}` 判别联合（导出名 `mcpAskToolOutput` 锁定不变）。 */
const mcpAskToolOutput = z.union([mcpAskSingleOutput, mcpAskGroupOutput])

/** 工具出参（键恰为 MCP_TOOLS；spec §9 返回列的 zod 化）。 */
export const MCP_TOOL_OUTPUTS = {
  register: z.object({
    agent: mcpAgentOutput,
    unread: z.number().int().nonnegative(),
    join_token: z.string().optional(),
    /** P4 additive：随注册回一份《使用指南》（原生工具面不消费 server `instructions`）。 */
    guide: z.string().optional(),
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
    z.object({
      id: z.string(),
      /** P6 additive：该消息的紧急度（缺省 `normal`；便于测试与排障区分三档）。 */
      urgency: messageUrgencySchema.optional(),
      receipts: z.array(mcpReceiptOutput),
    }),
  ),
  ask: mcpAskToolOutput,
  respond_ask: mcpAskOutput,
  whoami: z.object({
    agent_id: z.string(),
    /** 机器唯一名（注册时的 `name`；`task_ref` 幂等与撞名重试都依赖它稳定，不会变）。 */
    name: z.string(),
    /** **展示名** = `COALESCE(custom_name, name)`：人类在 UI 里改的、以及适配器标题同步写的就是它。 */
    display_name: z.string(),
    vendor: z.string(),
    kind: agentKindSchema,
    status: agentStatusSchema,
    role_tag: z.string().nullable(),
    parent_id: z.string().nullable(),
    unread: z.number().int().nonnegative(),
  }),
} as const satisfies Record<McpToolName, z.ZodType>

export type McpToolOutput<N extends McpToolName> = z.infer<(typeof MCP_TOOL_OUTPUTS)[N]>

// ── UI REST 线格式（Plan 3 T3：前端数据层消费；出参形状对齐 Task 9 / Task 4 路由） ──
// 前端一律经 `zod` 边界解析后 `z.infer` 复用，禁止在 client 手写重复的服务端类型。

/** 会话种类（spec §5.3：一对一 DM / 群组，含喊话广播会话）。 */
export const CONVERSATION_KINDS = ["dm", "group"] as const
export type ConversationKind = (typeof CONVERSATION_KINDS)[number]
export const conversationKindSchema = z.enum(CONVERSATION_KINDS)

/** 消息种类（spec §5.3：普通文本 / 系统消息）。 */
export const MESSAGE_KINDS = ["text", "system"] as const
export type UiMessageKind = (typeof MESSAGE_KINDS)[number]
export const messageKindSchema = z.enum(MESSAGE_KINDS)

/** 单收件方回执视图（REST 出参元素）。 */
export const receiptViewSchema = z.object({ agentId: z.string(), stage: receiptStageSchema })
export type ReceiptView = z.infer<typeof receiptViewSchema>

/**
 * 会话消息线格式（`GET /api/conversations/:id/messages` 与发送结果元素）。
 * `meta` 缺省 = 无（JSON 省略 undefined 属性），故 optional。
 */
export const chatMessageSchema = z.object({
  seq: z.number().int().nonnegative(),
  id: z.string(),
  conversationId: z.string(),
  fromAgentId: z.string(),
  body: z.string(),
  kind: messageKindSchema,
  meta: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int().nonnegative(),
  /** 发送方撤回时间（epoch ms）；缺省 = 未撤回（向后兼容旧负载）。 */
  revoked_at: z.number().int().nonnegative().nullable().optional(),
  /**
   * 己方文本消息的各收件方四级回执（Plan 3 T5 决议 1：仅 human 消息；
   * 非己方 / 系统消息 / 无收件方 → 字段缺省）。派生自既有 `receiptState`。
   */
  receipts: z.array(receiptViewSchema).optional(),
  /** 聚合回执：取**最落后**收件方的阶段（全部 read → read）。与 `receipts` 同现。 */
  receiptStage: receiptStageSchema.optional(),
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

/** 会话列表最后一条消息预览。 */
export const conversationPreviewSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  from: z.string(),
  body: z.string(),
  createdAt: z.number().int().nonnegative(),
  /** Task 8 I1（controller 专项批准）：预览携带消息 meta（被@标记读取）；老端省略即 undefined。 */
  meta: z.record(z.string(), z.unknown()).optional(),
})
export type ConversationPreview = z.infer<typeof conversationPreviewSchema>

/**
 * 会话摘要（`GET /api/conversations` 元素）。
 *
 * `createdAt` 为 Plan 3 T7 追加：无消息的新建会话（`lastMessage === null`）需据会话创建时间参与
 * 列表排序，否则活动时间恒为 0 会被排到末尾（binding DoD「新会话出现在列表顶部」）。
 */
export const conversationSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  kind: conversationKindSchema,
  key: z.string(),
  createdAt: z.number().int().nonnegative(),
  lastMessage: conversationPreviewSchema.nullable(),
  unread: z.number().int().nonnegative(),
})
export type ConversationSummary = z.infer<typeof conversationSummarySchema>

/** `GET /api/conversations` 响应体（会话数组 + 各根双层聚合未读）。 */
export const conversationListSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  unreadByRoot: z.record(z.string(), z.number().int().nonnegative()),
})
export type ConversationList = z.infer<typeof conversationListSchema>

/** `GET /api/conversations/:id/messages` 响应体（seq 升序）。 */
export const messageHistorySchema = z.object({ messages: z.array(chatMessageSchema) })
export type MessageHistory = z.infer<typeof messageHistorySchema>

/** 发送消息 / 喊话即时投递响应体（元素消息 + 各收件方回执）。 */
export const sendMessageResultSchema = z.object({
  ok: z.literal(true),
  message: chatMessageSchema,
  receipts: z.array(receiptViewSchema),
})
export type SendMessageResult = z.infer<typeof sendMessageResultSchema>

/** 会话已读位点推进结果。 */
export const conversationReadResultSchema = z.object({
  ok: z.literal(true),
  lastReadSeq: z.number().int().nonnegative(),
})
export type ConversationReadResult = z.infer<typeof conversationReadResultSchema>

/** 撤回消息结果（`POST /api/conversations/:id/messages/:messageId/revoke`）。 */
export const revokeMessageResultSchema = z.object({
  ok: z.literal(true),
  revokedAt: z.number().int().nonnegative(),
})
export type RevokeMessageResult = z.infer<typeof revokeMessageResultSchema>

/** 会话核心资料（建群出参 `group` 字段）。 */
export const conversationSchema = z.object({
  id: z.string(),
  kind: conversationKindSchema,
  key: z.string(),
  name: z.string().nullable().optional(),
  createdBy: z.string(),
  createdAt: z.number().int().nonnegative(),
})

/**
 * 确保 DM 结果（Plan 3 T6 `POST /api/conversations {to}`）：human↔节点 DM 的取或建
 * （幂等）；资料卡「发消息」在无既有 DM 时凭此创建会话。
 */
export const ensureDmResultSchema = z.object({
  ok: z.literal(true),
  conversation: conversationSchema,
})
export type EnsureDmResult = z.infer<typeof ensureDmResultSchema>

/**
 * 群列表元素（`GET /api/groups`）——会话资料 + 成员 id 列表。
 *
 * `members` 为 Plan 3 T7 追加：群资料页需树状展示成员（成员 → 所属根），
 * 而会话核心资料（`conversationSchema`）本身不含成员表；服务端 `groupList`
 * 已随会话返回参与者 id（与 MCP `group list` 出参同口径）。
 */
export const groupEntrySchema = conversationSchema.extend({
  members: z.array(z.string()),
})
export type GroupEntry = z.infer<typeof groupEntrySchema>
export const groupListSchema = z.object({ groups: z.array(groupEntrySchema) })

/** 审批/批示单出参（内部 `decidedAt`/`result`/`readAt` 为 undefined，JSON 省略 → optional）。 */
export const approvalEntrySchema = z.object({
  id: z.string(),
  requesterAgentId: z.string(),
  kind: approvalKindSchema,
  target: z.string(),
  action: approvalActionValueSchema,
  payload: z.record(z.string(), z.unknown()),
  status: approvalStatusSchema,
  result: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int().nonnegative(),
  decidedAt: z.number().int().nonnegative().optional(),
  readAt: z.number().int().nonnegative().optional(),
})
export type ApprovalEntry = z.infer<typeof approvalEntrySchema>

/** `GET /api/approvals` 响应体（pending 审批单数组）。 */
export const approvalListSchema = z.array(approvalEntrySchema)

/** 建群结果：即时执行 → group；经闸 → pending approval。 */
export const groupCreateResultSchema = z.union([
  z.object({ ok: z.literal(true), group: conversationSchema }),
  z.object({ ok: z.literal(true), approval: approvalEntrySchema }),
])
export type GroupCreateResult = z.infer<typeof groupCreateResultSchema>

/** 拉成员结果：即时执行 → ok；经闸 → pending approval。 */
export const groupMemberResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(true), approval: approvalEntrySchema }),
])
export type GroupMemberResult = z.infer<typeof groupMemberResultSchema>

/** 喊话结果：即时投递 → 消息+回执；经闸 → pending approval。 */
export const shoutResultSchema = z.union([
  sendMessageResultSchema,
  z.object({ ok: z.literal(true), approval: approvalEntrySchema }),
])
export type ShoutResult = z.infer<typeof shoutResultSchema>

/** 资料卡（`GET /api/agents/:id`）：roster 节点 + 参与会话入口。 */
export const agentCardSchema = z.object({
  node: rosterNodeSchema,
  conversations: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      kind: conversationKindSchema,
      key: z.string(),
    }),
  ),
})
export type AgentCard = z.infer<typeof agentCardSchema>

/** ask 答复入参（`choice?` | `text?`，二者择一由服务端裁决）。 */
export const respondAskInputSchema = z.object({
  choice: z.string().optional(),
  text: z.string().optional(),
})
export type RespondAskInput = z.infer<typeof respondAskInputSchema>

/** 审批决议入参。 */
export const approvalDecisionSchema = z.enum(["approve", "reject"])
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>

/** 通知已读结果（`read` = 本次是否新置位）。 */
export const notificationReadResultSchema = z.object({
  ok: z.literal(true),
  read: z.boolean(),
})
export type NotificationReadResult = z.infer<typeof notificationReadResultSchema>

/** ask 答复结果（`ask` = 已决批示单）。 */
export const respondAskResultSchema = z.object({
  ok: z.literal(true),
  ask: approvalEntrySchema,
})
export type RespondAskResult = z.infer<typeof respondAskResultSchema>

/** 审批决议结果（`approval` = 已决审批单）。 */
export const approvalDecisionResultSchema = z.object({
  ok: z.literal(true),
  approval: approvalEntrySchema,
})
export type ApprovalDecisionResult = z.infer<typeof approvalDecisionResultSchema>

// ── 管理端点（恢复出厂设置；本机回环单用户模型） ─────────────────────────

/** `GET /api/admin/info`：数据目录与日志目录（供「设置」面板展示）。 */
export const adminInfoSchema = z.object({
  home: z.string(),
  logsDir: z.string(),
})
export type AdminInfo = z.infer<typeof adminInfoSchema>

/** `POST /api/admin/reset` 成功结果（`restartRequired` 恒 true：须重启 Hub 才彻底生效）。 */
export const resetResultSchema = z.object({
  ok: z.literal(true),
  restartRequired: z.literal(true),
  snapshotPath: z.string(),
  failed: z.array(z.string()).optional(),
})
export type ResetResult = z.infer<typeof resetResultSchema>
