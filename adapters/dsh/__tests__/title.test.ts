/**
 * 标题同步（会话标题 → Hub 展示名）回归测试 —— 重点是**绝不覆盖用户手动改名**（真机事故）：
 *
 * 用户在 AgentChat 里把 A/B 改名成「AgentChat群聊测试员A/B」后，插件在会话标题变化时又把
 * `custom_name` 覆盖回会话标题，改名无声丢失。本文件钉死：
 * ① 只有"当前名 == 机器名"（或"== 我们上次写入的值"）时才同步；
 * ② 一旦发现被手动改过 → 该会话 `detached`，**永久停用**自动同步；
 * ③ `detached` 持久化在 `<home>/agents/dsh.titles.json` —— 插件重启后仍然生效；
 * ④ 读不到当前名时降级为旧行为（不因可观测故障阻断同步）；
 * ⑤ 409 撞名的退化名重试保持原样。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createTitleSync,
  loadTitleState,
  titleStatePath,
} from "../lib/title.js"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** 一次性 home（状态文件落盘位置）。 */
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentchat-title-"))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  return home
}

interface FakeHub {
  readonly calls: { id: string; name: string }[]
  current: string | undefined
  failWith?: { name: string; error: unknown }
  readAgentDisplayName?: (id: string) => Promise<string | undefined>
  renameAgent(id: string, name: string): Promise<void>
}

/** 假 Hub：记录 PATCH；`current` 可变，用来模拟"用户改名后 Hub 上的当前展示名"。 */
function fakeHub(initial: { current?: string } = {}): FakeHub {
  const hub: FakeHub = {
    calls: [],
    current: initial.current,
    async renameAgent(id: string, name: string) {
      if (hub.failWith !== undefined && hub.failWith.name === name) throw hub.failWith.error
      hub.calls.push({ id, name })
      hub.current = name // 成功写入后 Hub 上的当前名就是我们写的
    },
    async readAgentDisplayName() {
      return hub.current
    },
  }
  return hub
}

const SESSION = "session-aaaabbbb-cccc"
const NODE = "node-1"
const MACHINE = "default-workspace-aaaabbbb"

interface FakeTitleCtx {
  readonly titles: Map<string, string>
  get(name: string): unknown
  on(): void
}

/** 假 Cordis 上下文：只提供 `sessionTitle.get`。 */
function fakeCtx(title: string): FakeTitleCtx {
  const titles = new Map<string, string>([["s1", title]])
  return {
    titles,
    get(name: string) {
      if (name !== "sessionTitle") return undefined
      return { get: (session: { id: string }) => ({ title: titles.get(session.id) }) }
    },
    on() {},
  }
}

const agent = { session: { id: "s1" } }

describe("标题同步：不覆盖用户手动改名（真机回归）", () => {
  it("当前名 == 机器名 → 同步标题；状态文件记录 synced", async () => {
    const home = tempHome()
    const hub = fakeHub({ current: MACHINE })
    const ctx = fakeCtx("第一版标题")
    const sync = createTitleSync({ ctx, hub, home, log: () => {}, enabled: true })

    await sync(SESSION, agent, NODE, MACHINE)

    expect(hub.calls).toEqual([{ id: NODE, name: "第一版标题" }])
    const state = loadTitleState(titleStatePath(home), () => {})
    expect(state[SESSION]?.synced).toBe("第一版标题")
    expect(state[SESSION]?.detached).toBeUndefined()
  })

  it("同标题再次触发 → 不重复 PATCH", async () => {
    const home = tempHome()
    const hub = fakeHub({ current: MACHINE })
    const ctx = fakeCtx("标题A")
    const sync = createTitleSync({ ctx, hub, home, log: () => {}, enabled: true })

    await sync(SESSION, agent, NODE, MACHINE)
    await sync(SESSION, agent, NODE, MACHINE)

    expect(hub.calls).toHaveLength(1)
  })

  it("用户改名后（当前名 ≠ 上次同步值）→ 停止同步并持久化 detached；后续标题变化也不再 PATCH", async () => {
    const home = tempHome()
    const hub = fakeHub({ current: MACHINE })
    const ctx = fakeCtx("标题A")
    const sync = createTitleSync({ ctx, hub, home, log: () => {}, enabled: true })
    await sync(SESSION, agent, NODE, MACHINE)
    expect(hub.calls).toHaveLength(1)

    // 用户在 Hub 上改名 → 当前名变成用户的名字
    hub.current = "AgentChat群聊测试员A"
    // 会话标题又变了（会触发一次同步）
    ctx.titles.set("s1", "标题B")
    await sync(SESSION, agent, NODE, MACHINE)

    // 不得覆盖用户改名
    expect(hub.calls).toHaveLength(1)
    expect(hub.current).toBe("AgentChat群聊测试员A")
    expect(loadTitleState(titleStatePath(home), () => {})[SESSION]?.detached).toBe(true)
  })

  it("detached 持久化：插件重启（新实例读同一 home）后仍不覆盖", async () => {
    const home = tempHome()
    const hub1 = fakeHub({ current: MACHINE })
    const ctx1 = fakeCtx("标题A")
    const sync1 = createTitleSync({ ctx: ctx1, hub: hub1, home, log: () => {}, enabled: true })
    await sync1(SESSION, agent, NODE, MACHINE)

    hub1.current = "我的名字"
    ctx1.titles.set("s1", "标题B")
    await sync1(SESSION, agent, NODE, MACHINE) // 触发 detach

    // 模拟重启：同一 home，新实例、新 ctx/hub（Hub 上的当前名仍是用户改的那个）
    const hub2 = fakeHub({ current: "我的名字" })
    const ctx2 = fakeCtx("标题C")
    const sync2 = createTitleSync({ ctx: ctx2, hub: hub2, home, log: () => {}, enabled: true })
    await sync2(SESSION, agent, NODE, MACHINE)

    expect(hub2.calls).toHaveLength(0)
    expect(hub2.current).toBe("我的名字")
  })

  it("无状态但已存在自定义名（当前名 ≠ 机器名、≠ 本次标题）→ 不覆盖并 detach", async () => {
    const home = tempHome()
    const hub = fakeHub({ current: "用户早先改的名字" })
    const ctx = fakeCtx("标题A")
    const sync = createTitleSync({ ctx, hub, home, log: () => {}, enabled: true })

    await sync(SESSION, agent, NODE, MACHINE)

    expect(hub.calls).toHaveLength(0)
    expect(hub.current).toBe("用户早先改的名字")
    expect(loadTitleState(titleStatePath(home), () => {})[SESSION]?.detached).toBe(true)
  })

  it("读不到当前名（Hub 抖动）→ 降级为旧行为，继续同步", async () => {
    const home = tempHome()
    const hub = fakeHub({ current: MACHINE })
    hub.readAgentDisplayName = async () => {
      throw new Error("network boom")
    }
    const ctx = fakeCtx("标题A")
    const sync = createTitleSync({ ctx, hub, home, log: () => {}, enabled: true })

    await sync(SESSION, agent, NODE, MACHINE)

    expect(hub.calls).toEqual([{ id: NODE, name: "标题A" }])
  })

  it("老 hub 客户端（没有 readAgentDisplayName）→ 保持旧行为", async () => {
    const home = tempHome()
    const hub = fakeHub({ current: MACHINE })
    delete (hub as { readAgentDisplayName?: unknown }).readAgentDisplayName
    const ctx = fakeCtx("标题A")
    const sync = createTitleSync({ ctx, hub, home, log: () => {}, enabled: true })

    await sync(SESSION, agent, NODE, MACHINE)

    expect(hub.calls).toEqual([{ id: NODE, name: "标题A" }])
  })

  it("409 name_taken → 退化为「标题·短标识」重试成功", async () => {
    const home = tempHome()
    const hub = fakeHub({ current: MACHINE })
    hub.failWith = { name: "标题A", error: Object.assign(new Error("name taken"), { status: 409 }) }
    const ctx = fakeCtx("标题A")
    const sync = createTitleSync({ ctx, hub, home, log: () => {}, enabled: true })

    await sync(SESSION, agent, NODE, MACHINE)

    expect(hub.calls).toHaveLength(1)
    expect(hub.calls[0]?.name.startsWith("标题A·")).toBe(true)
    expect(loadTitleState(titleStatePath(home), () => {})[SESSION]?.synced).toBe(hub.calls[0]?.name)
  })

  it("状态文件损坏 → 从空状态开始（不抛）", async () => {
    const home = tempHome()
    const path = titleStatePath(home)
    // 写坏文件
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(join(home, "agents"), { recursive: true })
    writeFileSync(path, "{ not json", "utf8")
    const logs: string[] = []
    const state = loadTitleState(path, (message: string) => logs.push(message))
    expect(state).toEqual({})
    expect(logs.join("\n")).toContain("不是合法 JSON")
    // 且真实文件仍在（只是被忽略）
    expect(readFileSync(path, "utf8")).toBe("{ not json")
  })
})
