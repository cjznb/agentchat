/**
 * 消息 Markdown 渲染器（轮 1）：
 * - react-markdown@10 + remark-gfm + rehype-sanitize（默认 schema，先于 highlight）
 *   + rehype-highlight（subset 常见语言裁剪）；**不加 rehype-raw** → 源内 raw HTML 不成元素。
 * - `p` 覆盖：children 经 mention 递归 walker → `shared/mentions.splitMentions`
 *   命中出 `<mark class="mention-hit">`；code/pre 子树豁免（代码内字面量不注入）。
 * - `code`：无 language class 视为行内 → `code.md-inline`；围栏保留 language/hljs class。
 * - `a`：统一 `_blank + noopener noreferrer`；`table`：外包 `div.md-table-wrap` 横向滚动。
 * - React.memo：source 字符串相等且 participants 引用相等或长度+id 序列相等 → 跳过重渲染。
 */
import {
  Fragment,
  cloneElement,
  isValidElement,
  memo,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react"
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSanitize from "rehype-sanitize"
import rehypeHighlight from "rehype-highlight"
import { splitMentions, type MentionTarget } from "../../shared/mentions"

export interface MDMessageProps {
  readonly source: string
  readonly participants: readonly MentionTarget[]
}

/** rehype-highlight `subset`：常见语言白名单（未列出的语言不加载，控制包体）。 */
const HIGHLIGHT_SUBSET = [
  "js", "jsx", "ts", "tsx", "json", "bash", "python", "c", "cpp",
  "rust", "go", "java", "sql", "yaml", "xml", "css", "diff", "markdown",
] as const

/** 字符串节点 → splitMentions 分段；命中段包 `mark.mention-hit`（带 key，拼接还原原文）。 */
function mentionParts(
  text: string,
  participants: readonly MentionTarget[],
  path: string,
): ReactNode[] {
  return splitMentions(text, participants).map((part, index) =>
    part.mention !== undefined ? (
      <mark key={`${path}-${index}`} className="mention-hit">
        {part.text}
      </mark>
    ) : (
      <Fragment key={`${path}-${index}`}>{part.text}</Fragment>
    ),
  )
}

/** 深度遍历 React children：字符串分段注入；code/pre 子树整体豁免；元素递归克隆。 */
function walkMentions(
  node: ReactNode,
  participants: readonly MentionTarget[],
  path: string,
): ReactNode {
  if (typeof node === "string") return mentionParts(node, participants, path)
  if (Array.isArray(node)) {
    return node.map((child, index) => walkMentions(child, participants, `${path}.${index}`))
  }
  if (!isValidElement(node)) return node
  // code/pre 内跳过（组件覆盖后行内 code 的 type 为下方 MdCode 引用，字符串形态兜底）
  if (node.type === "pre" || node.type === "code" || node.type === MdCode) return node
  const props = node.props as { children?: ReactNode }
  if (props.children === undefined) return node
  return cloneElement(node as ReactElement<{ children?: ReactNode }>, {
    children: walkMentions(props.children, participants, `${path}.${String(node.key ?? "")}`),
  })
}

/** 行内/围栏 code 渲染：无 language class → `md-inline`；围栏原样保留 language/hljs class。 */
function MdCode({
  className,
  children,
  node,
  ...rest
}: ComponentPropsWithoutRef<"code"> & ExtraProps): ReactNode {
  void node
  const fenced = typeof className === "string" && className.includes("language-")
  return (
    <code className={fenced ? className : "md-inline"} {...rest}>
      {children}
    </code>
  )
}

/** 每次渲染重建 components（闭包携带 participants）；memo 已挡住无变化重渲染。 */
function makeComponents(participants: readonly MentionTarget[]): Components {
  return {
    p: ({ children, node }) => {
      void node
      return <p>{walkMentions(children, participants, "p")}</p>
    },
    code: MdCode,
    a: ({ href, children, node }) => {
      void node
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      )
    },
    table: ({ children, node }) => {
      void node
      return (
        <div className="md-table-wrap">
          <table>{children}</table>
        </div>
      )
    },
  }
}

/** participants 等价：引用相等，或长度相同且 id 序列相等。 */
function sameParticipants(
  a: readonly MentionTarget[],
  b: readonly MentionTarget[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((target, index) => target.id === b[index]?.id)
}

/** 消息体 Markdown 渲染（memo：source 相等 + participants 等价 → 跳过重渲染/重解析）。 */
export const MDMessage = memo(
  function MDMessage({ source, participants }: MDMessageProps) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize, [rehypeHighlight, { subset: [...HIGHLIGHT_SUBSET] }]]}
        components={makeComponents(participants)}
      >
        {source}
      </ReactMarkdown>
    )
  },
  (prev, next) =>
    prev.source === next.source && sameParticipants(prev.participants, next.participants),
)
MDMessage.displayName = "MDMessage"
