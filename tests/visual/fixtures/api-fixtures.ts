/**
 * 视觉测试 fixture（层2 数据面）：按 `shared/contracts.ts` 线格式造全量 HTTP mock 数据。
 * 纯数据、零副作用、零 server import；仅 tests/visual 消费
 * （vitest include 是 `tests 下全部 .test.ts`，本文件天然不在其中）。
 */
import type {
  AdminInfo,
  AgentCard,
  AgentKind,
  AgentStatus,
  ApprovalEntry,
  ChatMessage,
  ConversationList,
  ConversationSummary,
  GroupEntry,
  NotificationEntry,
  RosterNode,
} from "../../../shared/contracts"

/** 固定时间戳（确定性渲染，禁止用 now）。 */
const T0 = 1_750_000_000_000

export const HUMAN_ID = "hum000001"
export const ROOT_A = "agt-root-a01"
export const CHILD_A1 = "agt-claude-01"
export const CHILD_A2 = "agt-opencode-02"
export const ROOT_B = "agt-root-b02"
export const CHILD_B1 = "agt-child-b01"
export const ROOT_LONG = "agt-root-long"

export const GROUP_CONV = "con-group01"
export const DM_CONV = "con-dm00001"
export const SHOUT_CONV = "con-shout01"
export const GROUP_TITLE = "发布协调群"

/** 溢出探针：长显示名（存量缺陷「长名无省略号」复现源）。 */
const LONG_NAME =
  "超长显示名-overflow-probe-without-ellipsis-0123456789-0123456789-0123456789"
const LONG_STATUS =
  "状态文本溢出探针：这是一段刻意拉长的状态描述，用于复现「span scrollWidth 远大于 clientWidth」的存量溢出缺陷，验证层1 断言是否能抓住它。"
const LONG_BODY =
  "长消息正文溢出探针：这段内容刻意拉长，用于检验气泡与消息列表的横向约束是否生效；" +
  "若排版缺少断行或省略号，层1 溢出扫描会把它连同选择器路径一起列进 offender 清单。"

interface NodeSeed {
  readonly id: string
  readonly name: string
  readonly parentId?: string
  readonly kind?: AgentKind
  readonly vendor?: string
  readonly model?: string
  readonly status?: AgentStatus
  readonly statusText?: string | null
  readonly purpose?: string | null
  readonly roleTag?: string | null
  readonly remark?: string | null
  readonly skills?: readonly string[]
  readonly unread?: number
  readonly children?: readonly RosterNode[]
}

function makeNode(seed: NodeSeed): RosterNode {
  return {
    id: seed.id,
    name: seed.name,
    kind: seed.kind ?? "runtime",
    parent_id: seed.parentId ?? null,
    vendor: seed.vendor ?? "opencode",
    model: seed.model ?? "model-x",
    status: seed.status ?? "online",
    status_text: seed.statusText ?? null,
    purpose: seed.purpose ?? null,
    role_tag: seed.roleTag ?? null,
    remark: seed.remark ?? null,
    skills: seed.skills ?? [],
    unread: seed.unread ?? 0,
    children: seed.children ?? [],
  }
}

const longRootNode = makeNode({
  id: ROOT_LONG,
  name: LONG_NAME,
  status: "offline",
  purpose: LONG_NAME,
  unread: 1,
})

/** `GET /api/roster`（含 `?conversation=` 口径，同形状）。 */
export const roster: readonly RosterNode[] = [
  makeNode({ id: HUMAN_ID, name: "我", vendor: "human", model: "-", status: "online" }),
  makeNode({
    id: ROOT_A,
    name: "Claude Code 主实例",
    purpose: "主编码与评审实例",
    unread: 3,
    children: [
      makeNode({
        id: CHILD_A1,
        parentId: ROOT_A,
        name: "claude-01",
        status: "busy",
        statusText: LONG_STATUS,
        purpose: "子任务执行",
        skills: ["refactor", "review"],
      }),
      makeNode({ id: CHILD_A2, parentId: ROOT_A, name: "opencode-02", status: "offline" }),
    ],
  }),
  makeNode({
    id: ROOT_B,
    name: "容器实例组",
    roleTag: "container",
    unread: 1,
    children: [
      makeNode({ id: CHILD_B1, parentId: ROOT_B, name: "deep-child-01", status: "online" }),
    ],
  }),
  longRootNode,
]

/** `GET /api/conversations`。 */
export const conversationListResponse: ConversationList = {
  conversations: [
    {
      id: GROUP_CONV,
      name: GROUP_TITLE,
      kind: "group",
      key: "group:g-001",
      createdAt: T0 - 900_000,
      lastMessage: {
        id: "msg-0006",
        seq: 6,
        from: CHILD_A1,
        body: "收到，20:00 前给出回归清单。",
        createdAt: T0 - 120_000,
      },
      unread: 2,
    },
    {
      id: DM_CONV,
      name: "Claude Code 主实例",
      kind: "dm",
      key: `dm:${HUMAN_ID}:${ROOT_A}`,
      createdAt: T0 - 800_000,
      lastMessage: {
        id: "msg-dm02",
        seq: 2,
        from: ROOT_A,
        body: "分支已推送，等待评审。",
        createdAt: T0 - 240_000,
      },
      unread: 0,
    },
    {
      id: SHOUT_CONV,
      name: null,
      kind: "group",
      key: "shout",
      createdAt: T0 - 700_000,
      lastMessage: null,
      unread: 0,
    },
  ],
  unreadByRoot: { [ROOT_A]: 3, [ROOT_B]: 1, [ROOT_LONG]: 1 },
}

/** `GET /api/conversations/:id/messages`。 */
export const messagesByConversation: Readonly<Record<string, readonly ChatMessage[]>> = {
  [GROUP_CONV]: [
    {
      seq: 1,
      id: "msg-0001",
      conversationId: GROUP_CONV,
      fromAgentId: CHILD_A1,
      body: "已加入群聊。",
      kind: "system",
      createdAt: T0 - 600_000,
    },
    {
      seq: 2,
      id: "msg-0002",
      conversationId: GROUP_CONV,
      fromAgentId: HUMAN_ID,
      body: "今晚 20:00 前跑完溢出回归清单。",
      kind: "text",
      createdAt: T0 - 500_000,
      receipts: [
        { agentId: CHILD_A1, stage: "delivered" },
        { agentId: CHILD_A2, stage: "read" },
      ],
      receiptStage: "delivered",
    },
    {
      seq: 3,
      id: "msg-0003",
      conversationId: GROUP_CONV,
      fromAgentId: CHILD_A1,
      body: LONG_BODY,
      kind: "text",
      createdAt: T0 - 400_000,
    },
    {
      seq: 4,
      id: "msg-0004",
      conversationId: GROUP_CONV,
      fromAgentId: HUMAN_ID,
      body: "先造仪器，溢出修复放下一个任务。",
      kind: "text",
      createdAt: T0 - 300_000,
      receipts: [{ agentId: CHILD_A2, stage: "queued" }],
      receiptStage: "queued",
    },
    {
      seq: 5,
      id: "msg-0005",
      conversationId: GROUP_CONV,
      fromAgentId: CHILD_A2,
      body: "收到。",
      kind: "text",
      createdAt: T0 - 200_000,
    },
    {
      seq: 6,
      id: "msg-0006",
      conversationId: GROUP_CONV,
      fromAgentId: CHILD_A1,
      body: "收到，20:00 前给出回归清单。",
      kind: "text",
      createdAt: T0 - 120_000,
    },
  ],
  [DM_CONV]: [
    {
      seq: 1,
      id: "msg-dm01",
      conversationId: DM_CONV,
      fromAgentId: HUMAN_ID,
      body: "开始视觉仪器搭建。",
      kind: "text",
      createdAt: T0 - 260_000,
    },
    {
      seq: 2,
      id: "msg-dm02",
      conversationId: DM_CONV,
      fromAgentId: ROOT_A,
      body: "分支已推送，等待评审。",
      kind: "text",
      createdAt: T0 - 240_000,
    },
  ],
}

/** `GET /api/notifications?scope=…`（actionable = 待处理）。 */
export const notifications: readonly NotificationEntry[] = [
  {
    id: "ask-0001",
    kind: "ask",
    requesterAgentId: ROOT_A,
    target: "human",
    action: "ask",
    payload: { question: "是否批准今晚发布？", options: ["批准", "再想想"] },
    status: "pending",
    createdAt: T0 - 300_000,
    cardMessageId: "msg-0002",
    conversationId: GROUP_CONV,
  },
  {
    id: "apv-0002",
    kind: "action",
    requesterAgentId: CHILD_B1,
    target: "human",
    action: "group_create",
    payload: { name: GROUP_TITLE },
    status: "approved",
    createdAt: T0 - 400_000,
    decidedAt: T0 - 350_000,
    readAt: T0 - 340_000,
    cardMessageId: null,
    conversationId: null,
  },
]
export const actionableNotifications: readonly NotificationEntry[] = notifications.filter(
  (entry) => entry.status === "pending" && entry.target === "human",
)

/** `GET /api/approvals`（pending action 单）。 */
export const approvals: readonly ApprovalEntry[] = [
  {
    id: "apv-0003",
    kind: "action",
    requesterAgentId: ROOT_B,
    target: "human",
    action: "shout",
    payload: { body: "全员集合" },
    status: "pending",
    createdAt: T0 - 200_000,
  },
]

/** `GET /api/groups`（群资料面板数据源）。 */
export const groupListResponse: { groups: readonly GroupEntry[] } = {
  groups: [
    {
      id: GROUP_CONV,
      kind: "group",
      name: GROUP_TITLE,
      key: "group:g-001",
      createdBy: HUMAN_ID,
      createdAt: T0 - 900_000,
      members: [HUMAN_ID, ROOT_A, CHILD_A1, CHILD_A2],
    },
  ],
}

/** `GET /api/agents/:id`（资料卡；PATCH 改名同形状兜底）。 */
export const agentCardResponse: AgentCard = {
  node: longRootNode,
  conversations: [{ id: GROUP_CONV, name: GROUP_TITLE, kind: "group", key: "group:g-001" }],
}

/** `GET /api/admin/info`（设置面板；假路径，绝不指向真实用户数据目录）。 */
export const adminInfoResponse: AdminInfo = {
  home: "D:\\agentchat-fixture\\home",
  logsDir: "D:\\agentchat-fixture\\home\\logs",
}

/** `ConversationSummary` 冗余导出（spec 场景定位用）。 */
export type { ConversationSummary }
