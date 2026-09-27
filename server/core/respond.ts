/**
 * 请求批示（ask）答复编排（spec §17.3）—— 自 `core/ask.ts` 拆出
 * （`ask.ts` ≤250 纯行红线，controller 授权的结构偏差；`core/permissions` 一并
 * `export * from "./respond"`，既有 `core/permissions` 导入路径零改动）。
 *
 * - `respondAsk`：人类超级观察者可答任意 ask；agent 仅限 `target`。选项合法性 → `invalid_choice`；
 *   首答生效（`markAnswered` 条件 UPDATE）；答复消息落**卡所在会话**（优先建卡时持久化的
 *   `payload.conversationId`，缺失才回退 `cardConversation` 重算 —— 向后兼容既有行）+ publish。
 */
import { z } from "zod"
import type { Db } from "../db"
import { getAgent } from "../store/agents"
import { getApproval, markAnswered, type Approval } from "../store/approvals"
import { getConversation } from "../store/conversations"
import { send } from "../store/messages"
import {
  AskAlreadyAnsweredError,
  AskForbiddenError,
  AskNotFoundError,
  cardConversation,
  InvalidChoiceError,
} from "./ask"
import { emitApproval } from "./permissions"
import { publishMessage } from "./publish"

export interface RespondAskInput {
  /** 选择某个选项（必须 ∈ options）。 */
  readonly choice?: string
  /** 自由答复（仅 `allowCustom !== false` 时允许）。 */
  readonly text?: string
}

/** 校验并归一答案：choice 必须 ∈ options；text 仅 `allowCustom`；二者互斥且至少其一。 */
function resolveAnswer(
  input: RespondAskInput,
  rawOptions: unknown,
  allowCustom: boolean,
): { readonly choice: string } | { readonly text: string } {
  const { choice, text } = input
  if (choice !== undefined && text !== undefined) throw new InvalidChoiceError("choice and text are mutually exclusive")
  if (choice !== undefined) {
    const parsed = z.array(z.string()).safeParse(rawOptions)
    const options = parsed.success ? parsed.data : []
    if (!options.includes(choice)) {
      throw new InvalidChoiceError(`choice "${choice}" is not one of the options`)
    }
    return { choice }
  }
  if (text !== undefined) {
    if (!allowCustom) throw new InvalidChoiceError("custom text is not allowed for this ask")
    return { text }
  }
  throw new InvalidChoiceError("either choice or text is required")
}

function answerBody(answer: { readonly choice: string } | { readonly text: string }): string {
  return "choice" in answer ? `✅ 已答复：${answer.choice}` : `✅ 已答复：${answer.text}`
}

/**
 * 答复请求批示（首答生效）：校验应答权限与答案合法性 → `markAnswered`（仅 `pending` 成功）；
 * 答复消息落**卡所在会话**（优先取建卡时持久化的 `payload.conversationId`，缺失才回退
 * `cardConversation` 重算 —— 向后兼容既有行）+ publish（解锁 wait）+ `emitApproval`。
 * 人类超级观察者（`vendor='human'`）可答任意 ask；agent 仅限 `target`。
 */
export function respondAsk(
  db: Db,
  askId: string,
  responder: string,
  input: RespondAskInput,
): Approval {
  const stored = getApproval(db, askId)
  if (stored === undefined || stored.kind !== "ask") throw new AskNotFoundError(askId)
  const responderAgent = getAgent(db, responder)
  if (responderAgent?.vendor !== "human" && responder !== stored.target) {
    throw new AskForbiddenError(responder, askId)
  }
  // 卡所在会话：优先建卡时持久化的会话 id（即使双方后来又建了 DM，也恒落卡会话）；
  // 仅当该字段缺失 / 空串 / 指向不存在的会话时回退按目标规则重算（F5①：任意字符串不再
  // 被当作持久化 conversationId，防止答复落进不存在会话而不可恢复）。
  const persisted = stored.payload["conversationId"]
  const persistedConversation =
    typeof persisted === "string" && persisted !== "" ? getConversation(db, persisted) : undefined
  const conversationId = persistedConversation?.id ?? cardConversation(db, stored).id
  const answer = resolveAnswer(
    input,
    stored.payload["options"],
    stored.payload["allowCustom"] !== false,
  )
  const decidedAt = Date.now()
  const result: Record<string, unknown> = { ...answer, responder, decidedAt }
  // F5②：状态迁移与答复消息写入同事务 —— 写消息失败则 `markAnswered` 一并回滚
  //（绝不留下「answered 但无答复消息」的不可恢复中间态）；publish 放在提交之后。
  const committed = db
    .transaction((): boolean => {
      if (!markAnswered(db, askId, result, decidedAt)) return false
      send(db, {
        conversationId,
        fromAgentId: responder,
        body: answerBody(answer),
        kind: "system",
        meta: { askId, kind: "ask", result },
        idempotencyKey: `ask-answer:${askId}`,
      })
      return true
    })
    .immediate()
  if (!committed) throw new AskAlreadyAnsweredError(askId)
  publishMessage(db, conversationId)
  const decided: Approval = { ...stored, status: "answered", result, decidedAt }
  emitApproval(decided)
  return decided
}
