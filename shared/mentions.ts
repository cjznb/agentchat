/**
 * shared/mentions.ts —— 群聊 @ 提及解析的唯一实现（spec §2/§5）。
 *
 * 服务端 / 客户端 / MCP 共用同一份解析，后续任务只准调用 `resolveMentions`，
 * 不得各自另写。纯函数、无 IO、不 import server 代码；`participants` 由调用方注入
 * （群 = `listParticipants` 映射，客户端 = roster）。
 *
 * 规则：
 * - 全体关键字：正文 `@所有人` / `@all`（词边界）/ `@*`、正文恰为 `*`、
 *   结构化 `"所有人"`/`"all"`/`"*"` → `scope:"all"`，`matched` = 全体 participants（spec §2）。
 * - 名字取**最长前缀**匹配（名字可含空格与间隔点，如别名 `标题 · abcd`），
 *   故 `@张三，` 的尾随中英文标点天然落在名字之外（无须单独剔除）。
 * - 名字未中时按 token 兜底（取到空白/中英文标点/行尾）比对 id：完整 id 或前 8 位。
 * - `@` 前一位是 ASCII 字母/数字（邮箱等）时不视为提及。
 * - 未命中的 token 进 `unmatched`——本模块不阻断，宽容度由调用方决定
 *   （`send` 宽容回显、`ask` 据此报 `mention_not_found`）。
 * - 结构化 `mentions` 与正文解析取并集（同 id 去重）。
 */

/** 被提及者：名字全局唯一（`agents.name` UNIQUE）→ 精确比对无歧义。 */
export type MentionTarget = { id: string; name: string }

/** 解析回声：`send` 出参回显、`messages.meta` 落库均复用此形状。 */
export type MentionsEcho = {
  matched: MentionTarget[]
  unmatched: string[]
  /** all = 命中全体关键字；explicit = 有提及（含未命中）；none = 无任何提及。 */
  scope: "all" | "explicit" | "none"
}

type ParseCtx = {
  matched: MentionTarget[]
  unmatched: string[]
  seen: Set<string>
  all: boolean
}

/** token 边界：空白 / Unicode 标点 / 符号（含中英文标点与 `-`，故 UUID 正好取到前 8 位）。 */
const TOKEN_STOP = /[\s\p{P}\p{S}]/u
/** 提及起始的左边界：`@` 前一位是 ASCII 字母/数字则不开启提及（邮箱等）。 */
const ASCII_WORD = /[A-Za-z0-9]/

function isAllKeyword(token: string): boolean {
  return token === "*" || token === "所有人" || token.toLowerCase() === "all"
}

/** 贪心取 token：到第一个空白/中英文标点/行尾为止（尾随标点因此被天然剔除）。 */
function takeToken(text: string): string {
  let i = 0
  while (i < text.length && !TOKEN_STOP.test(text.charAt(i))) i += 1
  return text.slice(0, i)
}

function addMatch(ctx: ParseCtx, target: MentionTarget): void {
  if (ctx.seen.has(target.id)) return
  ctx.seen.add(target.id)
  ctx.matched.push({ id: target.id, name: target.name })
}

function addUnmatched(ctx: ParseCtx, token: string): void {
  if (!ctx.unmatched.includes(token)) ctx.unmatched.push(token)
}

/** 解析单个 `@` 之后的文本；返回消耗的字符数（供正文扫描游标前进）。 */
function resolveAt(rest: string, participants: readonly MentionTarget[], ctx: ParseCtx): number {
  // 1) 全体关键字先于名字：`@*` / `@所有人` / `@all`（后两者要求词边界）
  if (rest.startsWith("*")) {
    ctx.all = true
    return 1
  }
  if (rest.startsWith("所有人")) {
    ctx.all = true
    return "所有人".length
  }
  if (rest.slice(0, 3).toLowerCase() === "all" && !ASCII_WORD.test(rest.charAt(3))) {
    ctx.all = true
    return 3
  }

  // 2) 名字最长前缀匹配（名字可含空格/间隔点；`@张三，` 的标点天然不入围选）
  let best: MentionTarget | undefined
  let bestLen = 0
  for (const p of participants) {
    if (p.name.length > bestLen && rest.startsWith(p.name)) {
      best = p
      bestLen = p.name.length
    }
  }
  if (best !== undefined) {
    addMatch(ctx, best)
    return bestLen
  }

  // 3) token 兜底：完整 id / id 前 8 位 → 命中；否则进 unmatched
  const token = takeToken(rest)
  if (token.length === 0) return 0
  const byId = participants.find(
    (p) => p.id === token || (token.length >= 8 && p.id.startsWith(token)),
  )
  if (byId !== undefined) {
    addMatch(ctx, byId)
    return token.length
  }
  addUnmatched(ctx, token)
  return token.length
}

/** 扫描正文中的每个 `@`（跳过左邻 ASCII 词字符的，如邮箱）。 */
function scanBody(body: string, participants: readonly MentionTarget[], ctx: ParseCtx): void {
  let from = 0
  let at = body.indexOf("@", from)
  while (at >= 0) {
    from = at === 0 || !ASCII_WORD.test(body.charAt(at - 1))
      ? at + 1 + resolveAt(body.slice(at + 1), participants, ctx)
      : at + 1
    at = body.indexOf("@", from)
  }
}

/** 结构化 mentions 单元素：全体关键字 / 名字精确 / id 或 id 前 8 位 / 未命中（元素可带前导 `@`）。 */
function resolveStructured(
  raw: string,
  participants: readonly MentionTarget[],
  ctx: ParseCtx,
): void {
  const token = raw.trim().replace(/^@/, "")
  if (token.length === 0) return
  if (isAllKeyword(token)) {
    ctx.all = true
    return
  }
  const byName = participants.find((p) => p.name === token)
  if (byName !== undefined) {
    addMatch(ctx, byName)
    return
  }
  const byId = participants.find(
    (p) => p.id === token || (token.length >= 8 && p.id.startsWith(token)),
  )
  if (byId !== undefined) {
    addMatch(ctx, byId)
    return
  }
  addUnmatched(ctx, token)
}

/** scope "all" 时 matched = 全体参与者（同 id 去重，保持 participants 顺序）。 */
function allParticipants(participants: readonly MentionTarget[]): MentionTarget[] {
  const seen = new Set<string>()
  const matched: MentionTarget[] = []
  for (const p of participants) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    matched.push({ id: p.id, name: p.name })
  }
  return matched
}

/**
 * 提及解析单点（Task 2/3/4/8 的跨任务接口，导出名锁定勿改）。
 *
 * @param input.body 正文（必填）
 * @param input.mentions 结构化提及（可选）：名字 / id / id 前 8 位 / `"*"`
 * @param input.participants 该会话参与者（群 = `listParticipants` 映射；客户端 = roster）
 * @returns `{matched, unmatched, scope}`；结构化与正文取并集、同 id 去重
 */
export function resolveMentions(input: {
  body: string
  mentions?: string[] | undefined
  participants: readonly MentionTarget[]
}): MentionsEcho {
  const ctx: ParseCtx = { matched: [], unmatched: [], seen: new Set(), all: false }
  for (const token of input.mentions ?? []) resolveStructured(token, input.participants, ctx)
  scanBody(input.body, input.participants, ctx)

  if (ctx.all || input.body.trim() === "*") {
    return { matched: allParticipants(input.participants), unmatched: ctx.unmatched, scope: "all" }
  }
  const scope = ctx.matched.length > 0 || ctx.unmatched.length > 0 ? "explicit" : "none"
  return { matched: ctx.matched, unmatched: ctx.unmatched, scope }
}
