/**
 * E2E 种子（Plan 3 T3 起，T9 扩展为**完整体验数据**）——进程内直连 core/store（与 Hub 同进程），
 * 不经 MCP 握手；规格文件调用本模块的构造器，互不重复造数。
 *
 * - `seedExperience(db, home)`：一命令生成完整体验数据 —— 2 棵根树（`opencode` / `claude-code`）、
 *   3 名子节点、2 个逻辑节点、1 个群（含子 agent 与逻辑节点）、若干消息（含系统入群/离场）、
 *   回执演化（至少一条 `read`）、1 条待决审批 + 1 条待决批示 + 1 条已决审批。
 * - 细粒度构造器：`seedBase`（最小 human+根+DM）/ `seedList`（折叠列表）/ `seedOrg`（组织树）/
 *   `seedGroups`（建群+喊话）/ `seedApproval` + `cardRef`（审批卡深链）。
 * - 独立运行：`npx tsx tests/e2e/seed.ts`（临时 home，或 `AGENTCHAT_HOME` 指定）→ 打印摘要 JSON。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { loadConfig } from "../../server/config"
import { registerChild, registerLogical, registerRoot, retire } from "../../server/core/agents"
import { ask } from "../../server/core/ask"
import { ack, createGroup, ensureHuman, sendMessage, shout } from "../../server/core/messaging"
import { decide, postDecision, shoutPayloadSchema } from "../../server/core/permissions"
import { openDb, type Db } from "../../server/db"
import { setStatusText, touchAgent } from "../../server/store/agents"
import { getConversationByKey, SHOUT_KEY } from "../../server/store/conversations"
import { findCardMessage, send, type Message } from "../../server/store/messages"

// ── 细粒度构造器（规格文件复用；每个规格独立 home/db，互不污染） ─────────────

export interface SeedResult {
  readonly humanId: string
  readonly rootId: string
  readonly conversationId: string
}

/** 最小种子：human + 一个在线根 + 一条 DM（realtime 用例）。 */
export function seed(db: Db, home: string): SeedResult {
  const human = ensureHuman(db)
  const root = registerRoot(db, home, { name: "e2e-root", vendor: "opencode" }).agent
  const sent = sendMessage(db, { from: human.id, to: root.id, body: "seed" })
  return { humanId: human.id, rootId: root.id, conversationId: sent.message.conversationId }
}

export interface Seeded {
  readonly db: Db
  readonly home: string
  readonly humanId: string
  readonly rootId: string
  readonly dmId: string
  /** 种子首条消息（body `seed`，human 发出）的短 id。 */
  readonly seedMessageId: string
}

/** human + 一个在线根 + 一条 DM；返回 id 与临时库以便用例继续造数/断言。 */
export function seedBase(prefix: string): Seeded {
  const home = mkdtempSync(join(tmpdir(), prefix))
  const db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  const human = ensureHuman(db)
  const root = registerRoot(db, home, { name: "chat-root", vendor: "opencode" }).agent
  const sent = sendMessage(db, { from: human.id, to: root.id, body: "seed" })
  return {
    db,
    home,
    humanId: human.id,
    rootId: root.id,
    dmId: sent.message.conversationId,
    seedMessageId: sent.message.id,
  }
}

export interface ListSeed {
  readonly root1: string
  readonly root2: string
}

/** human + 两棵根树 + 逻辑节点 + 群 + 喊话；child2 退役（会话列表折叠用例）。 */
export function seedList(db: Db, home: string): ListSeed {
  const human = ensureHuman(db)
  const root1 = registerRoot(db, home, { name: "cl-root1", vendor: "opencode" }).agent
  const root2 = registerRoot(db, home, { name: "cl-root2", vendor: "opencode" }).agent
  const child1 = registerChild(db, { name: "cl-child1", parentId: root1.id, taskRef: "cl-t1" })
  const child2 = registerChild(db, { name: "cl-child2", parentId: root1.id, taskRef: "cl-t2" })
  const child3 = registerChild(db, { name: "cl-child3", parentId: root2.id, taskRef: "cl-t3" })
  const logical = registerLogical(db, { name: "cl-logical" })

  sendMessage(db, { from: human.id, to: root1.id, body: "seed-root" })
  sendMessage(db, { from: child1.id, to: human.id, body: "child-ping" })
  sendMessage(db, { from: child2.id, to: human.id, body: "child2-ping" })
  sendMessage(db, { from: child3.id, to: human.id, body: "child3-ping" })
  sendMessage(db, { from: logical.id, to: human.id, body: "logical-ping" })
  const group = createGroup(db, { name: "cl-group", createdBy: human.id, memberIds: [root1.id] })
  if (!("approved" in group)) throw new Error("human group creation must execute immediately")
  shout(db, human.id, "cl-shout")
  retire(db, child2.id)
  return { root1: root1.id, root2: root2.id }
}

export interface OrgSeed {
  readonly root1: string
  readonly root2: string
  readonly child1: string
  readonly child2: string
  readonly child3: string
  readonly child4: string
  readonly logical: string
}

/** human + 两棵根树（含 busy/退役/逻辑/多层）+ 未读（组织树用例）。 */
export function seedOrg(db: Db, home: string): OrgSeed {
  const human = ensureHuman(db)
  const root1 = registerRoot(db, home, {
    name: "org-root1",
    vendor: "opencode",
    model: "m1",
    purpose: "总控协调",
    roleTag: "组织者",
    remark: "主根",
  }).agent
  const root2 = registerRoot(db, home, { name: "org-root2", vendor: "claude-code" }).agent
  const child1 = registerChild(db, {
    name: "org-child1",
    parentId: root1.id,
    taskRef: "org-t1",
    vendor: "claude-code",
    model: "sonnet",
    purpose: "前端实现",
    roleTag: "执行者",
    skills: ["react", "css"],
  })
  const child2 = registerChild(db, {
    name: "org-child2",
    parentId: root1.id,
    taskRef: "org-t2",
    vendor: "opencode",
    roleTag: "监管者",
  })
  const child3 = registerChild(db, { name: "org-child3", parentId: root1.id, taskRef: "org-t3" })
  const child4 = registerChild(db, { name: "org-child4", parentId: root2.id, taskRef: "org-t4" })
  const logical = registerLogical(db, { name: "org-board" })
  touchAgent(db, child2.id, "busy")
  setStatusText(db, child2.id, "编译中")
  sendMessage(db, { from: child1.id, to: root1.id, body: "root1-ping" }) // root1 聚合未读 = 1
  sendMessage(db, { from: child1.id, to: human.id, body: "child1-ping" }) // child1 参与 human DM
  retire(db, child3.id)
  return {
    root1: root1.id,
    root2: root2.id,
    child1: child1.id,
    child2: child2.id,
    child3: child3.id,
    child4: child4.id,
    logical: logical.id,
  }
}

export interface GroupsSeed {
  readonly humanId: string
  readonly root1: string
  readonly root2: string
  readonly child1: string
  readonly child2: string
  readonly logical: string
}

/** human + 两棵树（子/逻辑混合）+ root1 两名子节点（建群与喊话用例）。 */
export function seedGroups(db: Db, home: string): GroupsSeed {
  const human = ensureHuman(db)
  const root1 = registerRoot(db, home, { name: "gs-root1", vendor: "opencode" }).agent
  const root2 = registerRoot(db, home, { name: "gs-root2", vendor: "claude-code" }).agent
  const child1 = registerChild(db, { name: "gs-child1", parentId: root1.id, taskRef: "gs-t1" })
  const child2 = registerChild(db, { name: "gs-child2", parentId: root1.id, taskRef: "gs-t2" })
  const logical = registerLogical(db, { name: "gs-board" })
  shout(db, human.id, "gs-seed-shout")
  sendMessage(db, { from: human.id, to: root2.id, body: "gs-seed-dm" })
  return {
    humanId: human.id,
    root1: root1.id,
    root2: root2.id,
    child1: child1.id,
    child2: child2.id,
    logical: logical.id,
  }
}

export interface Base {
  readonly db: Db
  readonly home: string
  readonly humanId: string
  readonly rootId: string
  readonly dmId: string
}

/** 单据 id → 卡消息的深链锚点。 */
export function cardRef(db: Db, id: string): { readonly conversationId: string; readonly messageId: string } {
  const card = findCardMessage(db, id)
  if (card === undefined) throw new Error(`card message missing for ${id}`)
  return { conversationId: card.conversationId, messageId: card.id }
}

/** 造一张待决审批卡（root 经闸 → pending approval + 卡消息）。 */
export function seedApproval(
  base: Base,
  body: string,
): { readonly id: string; readonly card: { conversationId: string; messageId: string } } {
  const outcome = shout(base.db, base.rootId, body)
  if (!("approval" in outcome)) throw new Error("expected a pending action approval")
  return { id: outcome.approval.id, card: cardRef(base.db, outcome.approval.id) }
}

// ── 完整体验数据（一命令） ─────────────────────────────────────────────

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

// ── 独立运行（`npx tsx tests/e2e/seed.ts`） ────────────────────────────

/** CLI 入口：临时 home（或 `AGENTCHAT_HOME`）生成完整体验数据并打印摘要。 */
export function runSeedCli(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExperienceSummary & { readonly home: string } {
  const configured = env["AGENTCHAT_HOME"]
  // 无显式 home 时落一次性临时目录；用后清理，避免 `agentchat-seed-*` 目录泄漏。
  // 摘要中的 `home` 仍报告本次所用路径（即便临时目录已在 finally 清除）。
  const ephemeral = configured === undefined
  const home = configured ?? mkdtempSync(join(tmpdir(), "agentchat-seed-"))
  const db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  try {
    return { home, ...seedExperience(db, home) }
  } finally {
    db.close()
    if (ephemeral) rmSync(home, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(runSeedCli(), null, 2))
}
