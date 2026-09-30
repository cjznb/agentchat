/**
 * 消息输入（feat/revoke-queued 自 `ChatView` 抽出，保持其 ≤250 纯行）——
 * 受控草稿 + CJK 输入法安全回车发送（`isComposing` 忽略 Enter）+ 同帧双击锁 + 失败行内提示。
 * 每会话独立实例：调用方以 `key={conversationId}` 挂载，切换会话即重置草稿与错误。
 *
 * feat/group-mentions（T7）：`@` 候选名提示（spec §4.1）——纯前端 roster 拍平做候选
 * （排除 human 自身与容器），片段 = 光标前最右合法 `@` 到光标（可含空格）；固定高度可滚动
 * 下拉，`↑↓` 循环高亮 + `scrollIntoView` 跟随，`Enter`/`Tab`/点击插入 `@<名字> `，
 * `Esc`/失焦/光标移出段收起。仅提示不建实体（D7），解析以服务端回显为准。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react"
import type { RosterNode } from "../../../shared/contracts"
import { useStore } from "../store"
import { isContainerNode } from "../treeFold"

/** Composer 入参。 */
export interface ComposerProps {
  readonly conversationId: string
  /** 发送成功后回调（调用方用于贴底滚动）。 */
  readonly onSent?: () => void
}

/** `@` 候选目标（roster 拍平后的展示名）。 */
interface MentionCandidate {
  readonly id: string
  readonly name: string
}

/**
 * 取光标前最后一个合法 `@` 到光标的片段（可含空格——人名可含空格）。
 * 该 `@` 左邻若为 ASCII 词字符（邮箱形态）则向前回退找上一个合法 `@`；都无 → null。
 * 空片段（光标紧贴 `@`）返回 `{at, fragment:""}`；无命中（换行/移出段）由调用方按无匹配收起。
 */
function mentionSegment(
  text: string,
  caret: number,
): { readonly at: number; readonly fragment: string } | null {
  const before = text.slice(0, caret)
  let at = before.lastIndexOf("@")
  while (at >= 0) {
    const prev = at === 0 ? "" : before.charAt(at - 1)
    if (!/[A-Za-z0-9]/.test(prev)) return { at, fragment: before.slice(at + 1) }
    at = before.lastIndexOf("@", at - 1)
  }
  return null
}

/** roster 拍平为候选：排除 human 自身（不会 @ 自己）与分组容器（不可提及）。 */
function mentionCandidates(roster: readonly RosterNode[]): MentionCandidate[] {
  const out: MentionCandidate[] = []
  const walk = (nodes: readonly RosterNode[]): void => {
    for (const node of nodes) {
      if (node.vendor !== "human" && !isContainerNode(node)) out.push({ id: node.id, name: node.name })
      walk(node.children)
    }
  }
  walk(roster)
  return out
}

/** 大小写不敏感子串匹配（空片段 → 全量候选）。 */
function matchCandidates(
  candidates: readonly MentionCandidate[],
  fragment: string,
): readonly MentionCandidate[] {
  const needle = fragment.toLowerCase()
  return candidates.filter((candidate) => candidate.name.toLowerCase().includes(needle))
}

export function Composer({ conversationId, onSent }: ComposerProps) {
  const { sendMessage, state } = useStore()
  const sendingRef = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // @ 候选态：caret 随输入/光标移动同步；dismissed 于 Esc/失焦置位、onChange 复位。
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const canSend = draft.trim().length > 0 && !sending

  const segment = mentionSegment(draft, caret)
  const candidates = mentionCandidates(state.roster)
  const matched = segment === null || dismissed ? [] : matchCandidates(candidates, segment.fragment)
  const open = matched.length > 0
  const active = open ? ((activeIndex % matched.length) + matched.length) % matched.length : 0

  // ↑↓ 切高亮时把活动项滚进可视区（列表固定高可滚动）。
  useEffect(() => {
    if (!open) return
    const item = listRef.current?.children[active]
    if (item instanceof HTMLElement) item.scrollIntoView({ block: "nearest" })
  }, [active, open])

  const submit = useCallback((): void => {
    // 同步 ref 锁（F4②）：异步 state 更新前的同帧双击不得重复提交。
    if (draft.trim().length === 0 || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError(null)
    void sendMessage(conversationId, draft)
      .then(() => {
        setDraft("")
        onSent?.()
      })
      .catch(() => {
        // 失败：乐观气泡已回滚，草稿保留供重试。
        setError("发送失败，请重试。")
      })
      .finally(() => {
        sendingRef.current = false
        setSending(false)
      })
  }, [conversationId, draft, onSent, sendMessage])

  /** 选中候选：替换 `@片段` 为 `@<完整名字> `（尾随空格），收起下拉并复位光标。 */
  const pick = useCallback(
    (candidate: MentionCandidate): void => {
      if (segment === null) return
      const end = caret
      const next = `${draft.slice(0, segment.at)}@${candidate.name} ${draft.slice(end)}`
      const nextCaret = segment.at + candidate.name.length + 2
      setDraft(next)
      setCaret(nextCaret)
      setDismissed(true)
      setActiveIndex(0)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.setSelectionRange(nextCaret, nextCaret)
      })
    },
    [caret, draft, segment],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      // CJK 输入法选词回车不发送（F4①）。
      if (event.nativeEvent.isComposing) return
      if (open) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault()
          const delta = event.key === "ArrowDown" ? 1 : -1
          setActiveIndex(((active + delta) % matched.length + matched.length) % matched.length)
          return
        }
        if (event.key === "Enter" && !event.shiftKey) {
          const candidate = matched[active]
          if (candidate !== undefined) {
            event.preventDefault()
            pick(candidate)
          }
          return
        }
        if (event.key === "Tab") {
          const candidate = matched[active]
          if (candidate !== undefined) {
            event.preventDefault()
            pick(candidate)
          }
          return
        }
        if (event.key === "Escape") {
          event.preventDefault()
          setDismissed(true)
          return
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        submit()
      }
    },
    [active, matched, open, pick, submit],
  )

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setDraft(event.target.value)
    setCaret(event.target.selectionStart ?? event.target.value.length)
    setDismissed(false)
    setActiveIndex(0)
  }

  // 键盘移动光标 / 鼠标选择不触发 onChange：同步 caret 让片段重算（光标移出段 → 收起）。
  const syncCaret = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    setCaret(event.currentTarget.selectionStart ?? 0)
  }

  return (
    <form
      className="composer"
      data-testid="composer"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <textarea
        ref={inputRef}
        className="composer-input"
        data-testid="composer-input"
        aria-label="消息输入框"
        placeholder="输入消息，回车发送，Shift+回车换行"
        value={draft}
        rows={1}
        onChange={onChange}
        onKeyUp={syncCaret}
        onSelect={syncCaret}
        onBlur={() => setDismissed(true)}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <ul className="composer-mention" data-testid="composer-mention" ref={listRef}>
          {matched.map((candidate, index) => (
            <li
              key={candidate.id}
              className="composer-mention-item"
              data-testid="composer-mention-item"
              data-active={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(candidate)}
            >
              {candidate.name}
            </li>
          ))}
        </ul>
      ) : null}
      <button className="composer-send" data-testid="composer-send" type="submit" disabled={!canSend}>
        发送
      </button>
      {error !== null ? (
        <p className="composer-error" role="alert" data-testid="composer-error">
          {error}
        </p>
      ) : null}
    </form>
  )
}
