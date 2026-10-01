/**
 * 台账 Minor 补锁（.superpowers/sdd/2026-09-30-group-mentions/progress.md:125 五 Minor）——
 * 本文件锁三项（落点 tests/**；client/** 禁区不动，④ 见 admin-prune.test.ts）：
 * ① 键独立断言：ui-fixes-report.md:14「持久化键 `agentchat:expandedPickerLegacy`（复用
 *    loadExpanded/saveExpanded + 哨兵 id，独立于既有 `agentchat:expandedPicker`）」
 * ② busy 分支：ui-fixes-report.md:13「（子树）无任何 online/busy 成员 → 整棵移入折叠栏；
 *    含在线/busy 后代的子树留主列表」——既有分拣用例只锁 online，busy 成员未覆盖
 * ③ 红 JSON 另存：ui-fixes-report.md:26/29 红跑 offender 清单先落盘
 *    test-results/visual/<scenario>-overflow.json（落盘流程无用例）
 * ⑤ CSS 读取 cwd 依赖：tests/ 下无任何 CSS 读取（grep 实证），实际 cwd 依赖读在
 *    client/src/__tests__/{dm-identity,ui-fixes}.test.tsx = 禁区 → 跳过（见批次报告）
 */
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadExpanded, saveExpanded, type StorageLike } from "../../client/src/accordion"
import { foldTree, partitionPickerRows } from "../../client/src/treeFold"
import type { RosterNode } from "../../shared/contracts"
import { expectNoOverflow } from "../visual/helper"

const TREE_KEY = "agentchat:expandedPicker"
const LEGACY_KEY = "agentchat:expandedPickerLegacy"

function fakeStorage(): StorageLike {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

function makeNode(
  id: string,
  status: RosterNode["status"],
  children: readonly RosterNode[] = [],
  kind: RosterNode["kind"] = "runtime",
): RosterNode {
  return {
    id,
    name: id,
    kind,
    parent_id: null,
    vendor: "opencode",
    model: "m",
    status,
    status_text: null,
    purpose: null,
    role_tag: null,
    remark: null,
    skills: [],
    unread: 0,
    children,
  }
}

describe("① picker 持久化键独立（键独立断言）", () => {
  it("legacy 与 tree 两键互不串扰：写一键不改变另一键的读取", () => {
    const storage = fakeStorage()
    saveExpanded(storage, LEGACY_KEY, ["legacy-1"])
    expect(loadExpanded(storage, TREE_KEY)).toEqual([])
    saveExpanded(storage, TREE_KEY, ["tree-1"])
    expect(loadExpanded(storage, LEGACY_KEY)).toEqual(["legacy-1"])
    expect(loadExpanded(storage, TREE_KEY)).toEqual(["tree-1"])
  })

  it("MemberPicker 源码声明两把不同键且 legacy 键与台账逐字一致（接线锁，client 只读）", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../client/src/components/MemberPicker.tsx", import.meta.url)),
      "utf8",
    )
    const keys = [...source.matchAll(/PICKER_(?:TREE|LEGACY)_KEY = "([^"]+)"/g)].map(
      (match) => match[1],
    )
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
    expect(keys).toContain(LEGACY_KEY)
  })
})

describe("② partitionPickerRows busy 分支", () => {
  it("busy 成员（非 online）的子树留主列表；全 offline 子树仍入折叠栏", () => {
    const rows = foldTree([makeNode("busy-root", "busy"), makeNode("idle-root", "offline")])
    const { main, legacy } = partitionPickerRows(rows)
    expect(main.map((row) => row.node.id)).toEqual(["busy-root"])
    expect(legacy.map((row) => row.node.id)).toEqual(["idle-root"])
  })

  it("busy 仅在后代：含 busy 后代的子树留主列表（report:13「含在线/busy 后代」字面）", () => {
    const rows = foldTree([makeNode("parent", "offline", [makeNode("busy-leaf", "busy")])])
    const { main, legacy } = partitionPickerRows(rows)
    expect(main.map((row) => row.node.id)).toEqual(["parent"])
    expect(legacy).toEqual([])
  })
})

describe("③ 层1 红 JSON 另存（expectNoOverflow 落盘流程）", () => {
  it("红跑时先落盘 <scenario>-overflow.json（含 offender 明细）再抛出清单错误", async () => {
    const scenario = "red-json-lock"
    const file = join(process.cwd(), "test-results", "visual", `${scenario}-overflow.json`)
    rmSync(file, { force: true })
    const fakeElement = {
      tagName: "DIV",
      parentElement: null,
      getAttribute: (name: string) => (name === "class" ? "overflow-box" : null),
      scrollWidth: 300,
      clientWidth: 100,
      scrollHeight: 10,
      clientHeight: 10,
    }
    const scope = globalThis as unknown as Record<string, unknown>
    const previousDocument = scope["document"]
    const previousGetComputedStyle = scope["getComputedStyle"]
    Object.assign(globalThis, {
      document: { querySelectorAll: () => [fakeElement] },
      getComputedStyle: () => ({ overflowX: "visible", overflowY: "visible" }),
    })
    const page = {
      evaluate: async (fn: () => unknown) => fn(),
    } as unknown as Parameters<typeof expectNoOverflow>[0]
    try {
      await expect(expectNoOverflow(page, scenario)).rejects.toThrow(/层1溢出违规/)
    } finally {
      if (previousDocument === undefined) delete scope["document"]
      else scope["document"] = previousDocument
      if (previousGetComputedStyle === undefined) delete scope["getComputedStyle"]
      else scope["getComputedStyle"] = previousGetComputedStyle
    }
    const written = JSON.parse(readFileSync(file, "utf8")) as { overflowX: number }[]
    expect(written).toHaveLength(1)
    expect(written[0]?.overflowX).toBe(200)
    rmSync(file, { force: true })
  })
})
