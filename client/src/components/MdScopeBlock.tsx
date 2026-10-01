/**
 * 「消息渲染」设置块：`agentchat:mdScope` 三档（全部 / 仅 AI 回复 / 关闭）。
 * 变更即持久化 + `notify` 广播 → 即时生效（订阅方无需刷新）。
 * 从 `Settings` 抽出以回收纯行（结构/testid 不动，settings-panel 断言零改动）。
 */
import { useState } from "react"
import { browserStorage } from "../accordion"
import { notify, readMdScope, writeMdScope, type MdScope } from "../mdScope"

export function MdScopeBlock() {
  const [mdScope, setMdScope] = useState<MdScope>(() => readMdScope(browserStorage()))

  return (
    <section className="settings-block">
      <h2>消息渲染</h2>
      <p className="settings-hint">选择哪些消息按 Markdown 渲染（变更即时生效，无需重启）。</p>
      <select
        className="settings-input"
        data-testid="settings-md-scope"
        value={mdScope}
        onChange={(event) => {
          const next = event.target.value as MdScope
          setMdScope(next)
          writeMdScope(browserStorage(), next)
          notify(next)
        }}
      >
        <option value="all">全部</option>
        <option value="agent">仅 AI 回复</option>
        <option value="off">关闭</option>
      </select>
    </section>
  )
}
