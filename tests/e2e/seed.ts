/**
 * E2E 最小种子（Plan 3 T3；T9 扩展）——human + 一个在线根节点 + 一条 DM 消息。
 * 直接调 core/store（与 Hub 同进程），无需经 MCP 握手。
 */
import { registerRoot } from "../../server/core/agents"
import { ensureHuman, sendMessage } from "../../server/core/messaging"
import type { Db } from "../../server/db"

export interface SeedResult {
  readonly humanId: string
  readonly rootId: string
  readonly conversationId: string
}

export function seed(db: Db, home: string): SeedResult {
  const human = ensureHuman(db)
  const root = registerRoot(db, home, { name: "e2e-root", vendor: "opencode" }).agent
  const sent = sendMessage(db, { from: human.id, to: root.id, body: "seed" })
  return { humanId: human.id, rootId: root.id, conversationId: sent.message.conversationId }
}
