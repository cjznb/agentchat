/**
 * `read_states` 表读写（spec §5.4 每参与者已读位点）：
 * 从 `store/conversations.ts` 拆出（Task 4 文件行数红线，controller 批准的结构偏差）。
 * 位点是已读与未读派生的唯一真相；upsert 只前进不回退。
 */
import type { Db } from "../db"

export interface ReadState {
  readonly conversationId: string
  readonly agentId: string
  readonly lastReadSeq: number
  readonly updatedAt: number
}

export interface MarkReadInput {
  readonly conversationId: string
  readonly agentId: string
  readonly lastReadSeq: number
}

/**
 * 已读位点 upsert（spec §5.4）：单语句原子写入；
 * 位点只前进不回退（旧 ack 不得把已读拉回）。
 */
export function markRead(db: Db, input: MarkReadInput): void {
  const params: MarkReadInput & { updatedAt: number } = {
    conversationId: input.conversationId,
    agentId: input.agentId,
    lastReadSeq: input.lastReadSeq,
    updatedAt: Date.now(),
  }
  db.prepare<MarkReadInput & { updatedAt: number }, void>(
    `INSERT INTO read_states (conversation_id, agent_id, last_read_seq, updated_at)
     VALUES ($conversationId, $agentId, $lastReadSeq, $updatedAt)
     ON CONFLICT (conversation_id, agent_id) DO UPDATE SET
       last_read_seq = MAX(read_states.last_read_seq, excluded.last_read_seq),
       updated_at = excluded.updated_at`,
  ).run(params)
}

export function getReadState(db: Db, conversationId: string, agentId: string): ReadState | undefined {
  const row = db
    .prepare<
      [string, string],
      { conversation_id: string; agent_id: string; last_read_seq: number; updated_at: number }
    >("SELECT * FROM read_states WHERE conversation_id = ? AND agent_id = ?")
    .get(conversationId, agentId)
  return row === undefined
    ? undefined
    : {
        conversationId: row.conversation_id,
        agentId: row.agent_id,
        lastReadSeq: row.last_read_seq,
        updatedAt: row.updated_at,
      }
}
