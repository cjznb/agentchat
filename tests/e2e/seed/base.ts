/**
 * E2E 种子 · 细粒度构造器（Plan 3 终审 F7 拆分自 `seed.ts`）——规格文件复用；
 * 每个规格独立 home/db，互不污染。`seed.ts` re-export 这些构造器（导入路径不变）。
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../../server/config"
import { registerChild, registerLogical, registerRoot, retire } from "../../../server/core/agents"
import { ensureHuman, sendMessage, shout } from "../../../server/core/messaging"
import { createGroup } from "../../../server/core/messaging"
import { openDb, type Db } from "../../../server/db"
import { setStatusText, touchAgent } from "../../../server/store/agents"
import { findCardMessage } from "../../../server/store/messages"

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
  sendMessage(db, { from: child1.id, to: root1.id, body: "root1-ping" }) // root1 聚合未读
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
