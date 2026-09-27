/**
 * E2E 种子 · 完整体验数据（Plan 3 终审 F7 拆分自 `seed.ts`）——一命令生成全量体验数据。
 */
import { registerChild, registerLogical, registerRoot, retire } from "../../../server/core/agents"
import { ask } from "../../../server/core/ask"
import { ack, createGroup, ensureHuman, sendMessage, shout } from "../../../server/core/messaging"
import { decide, postDecision, shoutPayloadSchema } from "../../../server/core/permissions"
import type { Db } from "../../../server/db"
import { getConversationByKey, SHOUT_KEY } from "../../../server/store/conversations"
import { send, type Message } from "../../../server/store/messages"

export interface ExperienceSummary {
  readonly humanId: string
  readonly roots: { readonly opencode: string; readonly claude: string }
  readonly children: readonly string[]
  readonly logicals: readonly string[]
  readonly groupId: string
  readonly conversations: {
    readonly opencodeRoot: string
    readonly opencodeChild: string
    readonly claudeChild: string
    readonly group: string
    readonly shout: string
  }
  readonly messages: {
    readonly readReceipt: string
    readonly groupSystem: string
    readonly leaveSystem: string
  }
  readonly approvals: { readonly pending: string; readonly decided: string }
  readonly asks: { readonly pending: string }
}

/** 写入一条 system 消息（入群/离场等；`idempotencyKey` 保证重复跑幂等）。 */
function systemMessage(db: Db, conversationId: string, fromAgentId: string, body: string, key: string): Message {
  return send(db, {
    conversationId,
    fromAgentId,
    body,
    kind: "system",
    meta: { reason: "seed" },
    idempotencyKey: key,
  })
}

/**
 * 完整体验数据：2 根树 / 3 子 / 2 逻辑 / 1 群 / 消息 + 系统入群离场 /
 * 回执（一条 read）/ 待决审批 + 待决批示 + 已决审批。返回摘要（id 与关键会话）。
 */
export function seedExperience(db: Db, home: string): ExperienceSummary {
  const human = ensureHuman(db)
  const rootO = registerRoot(db, home, {
    name: "opencode-root",
    vendor: "opencode",
    model: "gpt-5",
    purpose: "主控与协调",
    roleTag: "组织者",
    remark: "体验数据",
  }).agent
  const rootC = registerRoot(db, home, {
    name: "claude-root",
    vendor: "claude-code",
    model: "sonnet",
    purpose: "实现与审查",
    roleTag: "监管者",
  }).agent
  const childO1 = registerChild(db, {
    name: "oc-child-1",
    parentId: rootO.id,
    taskRef: "seed-oc-1",
    vendor: "opencode",
    model: "gpt-5",
    roleTag: "执行者",
    skills: ["react", "ts"],
  })
  const childO2 = registerChild(db, {
    name: "oc-child-2",
    parentId: rootO.id,
    taskRef: "seed-oc-2",
    vendor: "opencode",
  })
  const childC1 = registerChild(db, {
    name: "cc-child-1",
    parentId: rootC.id,
    taskRef: "seed-cc-1",
    vendor: "claude-code",
    roleTag: "执行者",
    skills: ["api"],
  })
  const logO = registerLogical(db, { name: "board-opencode", parentId: rootO.id })
  const logC = registerLogical(db, { name: "board-claude", parentId: rootC.id })

  // 私聊消息 + 回执演化：human→childO1 一条，childO1 ack → read。
  const ocRootDm = sendMessage(db, { from: human.id, to: rootO.id, body: "你好，opencode 根。" })
    .message.conversationId
  sendMessage(db, { from: rootO.id, to: human.id, body: "收到，开始协调。" })
  const childDm = sendMessage(db, { from: human.id, to: childO1.id, body: "请实现会话列表。" })
  ack(db, childO1.id, [childDm.message.id]) // 四级回执演化 → read
  const claudeChildDm = sendMessage(db, { from: childC1.id, to: human.id, body: "claude 子节点就绪。" })
    .message.conversationId

  // 群：子 agent + 逻辑节点（human 提交即时生效）。
  const group = createGroup(db, {
    name: "发布协调群",
    createdBy: human.id,
    memberIds: [childO1.id, logO.id, childC1.id],
  })
  if (!("approved" in group)) throw new Error("human group creation must execute immediately")
  const groupId = group.approved.id
  sendMessage(db, { from: human.id, to: groupId, body: "群里同步一下进度。" })
  sendMessage(db, { from: childO1.id, to: groupId, body: "前端已完成 80%。" })
  const groupSystem = systemMessage(db, groupId, childO1.id, "oc-child-1 加入群聊", "seed-join-oc1")
  retire(db, childO2.id)
  const leaveSystem = systemMessage(db, ocRootDm, childO2.id, "oc-child-2 已离场", "seed-leave-oc2")

  // 喊话（human 即时执行）→ 汇总数据。
  shout(db, human.id, "全员：今日 18:00 前完成自测。")

  // 待决审批（root 经闸）+ 待决批示（root → human）+ 已决审批（root 经闸后批准执行）。
  const pendingApproval = shout(db, rootO.id, "opencode 根申请全员播报")
  if (!("approval" in pendingApproval)) throw new Error("expected pending approval for root shout")
  const pendingAsk = ask(db, rootO.id, {
    to: "human",
    question: "本次发布目标环境？",
    options: ["staging", "prod"],
    allowCustom: true,
  }).ask
  const toDecide = shout(db, rootC.id, "claude 根申请全员播报")
  if (!("approval" in toDecide)) throw new Error("expected pending approval for root shout")
  const decided = decide(db, toDecide.approval.id, "approve", Date.now())
  const decidedBody = shoutPayloadSchema.parse(decided.payload).body
  sendMessage(db, { from: decided.requesterAgentId, to: "*", body: decidedBody }) // 批准后执行
  postDecision(db, decided)

  const shoutId = getConversationByKey(db, SHOUT_KEY)?.id ?? ""
  return {
    humanId: human.id,
    roots: { opencode: rootO.id, claude: rootC.id },
    children: [childO1.id, childO2.id, childC1.id],
    logicals: [logO.id, logC.id],
    groupId,
    conversations: {
      opencodeRoot: ocRootDm,
      opencodeChild: childDm.message.conversationId,
      claudeChild: claudeChildDm,
      group: groupId,
      shout: shoutId,
    },
    messages: { readReceipt: childDm.message.id, groupSystem: groupSystem.id, leaveSystem: leaveSystem.id },
    approvals: { pending: pendingApproval.approval.id, decided: decided.id },
    asks: { pending: pendingAsk.id },
  }
}
