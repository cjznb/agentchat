/**
 * Task 3 —— 节点注册、身份与层级树集成测试（brief DoD）：
 * - join_token 文件（`$AGENTCHAT_HOME/tokens/<id>`，0600）与重连认领 offline→online
 * - `task_ref` 幂等（同 id、parent_id 不变）、子注册挂树
 * - `retire` 不可恢复（task_ref / join_token 两条注册路径均拒绝）
 * - `GET /api/roster` 嵌套树含 vendor/model/role_tag/remark/purpose/status/unread
 * - 展示态离线：`last_seen` 超过 600000ms 报 offline 并**持久化为 offline**
 *   （写库仅在状态真的变化时发生、幂等；再次读取不重复写、不重复发事件）
 * - 状态迁移白名单 `canTransition`
 * 每个用例使用独立临时 $AGENTCHAT_HOME。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  canTransition,
  OFFLINE_AFTER_MS,
  registerChild,
  registerLogical,
  registerRoot,
  RegistrationError,
  retire,
  rosterTree,
  rosterTreeSchema,
} from "../../server/core/agents"
import { loadConfig } from "../../server/config"
import { clearAllTables, openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import { askGroup } from "../../server/core/ask-group"
import { MentionNotParticipantError } from "../../server/core/ask"
import { applyAgentState } from "../../server/routes/internal"
import {
  agentDisplayName,
  AgentNameTakenError,
  AgentNotFoundError,
  getAgent,
  renameAgent,
  touchAgent,
} from "../../server/store/agents"
import { createDm, createGroup } from "../../server/store/conversations"
import { send } from "../../server/store/messages"
import { currentWsSeq, resetWsHub } from "../../server/ws"

let home = ""
let db: Db

function agentsColumns(database: Db): string[] {
  return (database.pragma("table_info(agents)") as { name: string }[]).map((c) => c.name)
}

function displayIndexSql(database: Db): string {
  const row = database
    .prepare<[], { sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_agents_display_name'",
    )
    .get()
  return row?.sql ?? ""
}

/** Task 6 前的旧结构：agents 表无 custom_name、无展示名唯一索引。 */
function seedLegacyAgentsDb(path: string): void {
  const legacy = new Database(path)
  legacy.exec(`CREATE TABLE agents (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL CHECK (kind IN ('runtime', 'logical')),
    task_ref    TEXT UNIQUE,
    parent_id   TEXT REFERENCES agents(id),
    root_id     TEXT NOT NULL REFERENCES agents(id),
    vendor      TEXT NOT NULL,
    model       TEXT NOT NULL DEFAULT '—',
    status      TEXT NOT NULL CHECK (status IN ('online', 'busy', 'offline', 'retired')),
    purpose     TEXT,
    skills      TEXT NOT NULL DEFAULT '[]',
    role_tag    TEXT,
    remark      TEXT,
    status_text TEXT,
    last_seen   INTEGER NOT NULL,
    retired_at  INTEGER,
    created_at  INTEGER NOT NULL
  )`)
  legacy
    .prepare(
      "INSERT INTO agents (id, name, kind, root_id, vendor, status, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run("legacy-agent", "legacy-root", "runtime", "legacy-agent", "opencode", "online", 1000, 1000)
  legacy.close()
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-agents-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
})

afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})

describe("registerRoot", () => {
  it("creates an online root and writes its join_token file under $AGENTCHAT_HOME/tokens/<id>", () => {
    const { agent, joinToken } = registerRoot(db, home, {
      name: "root-file",
      vendor: "opencode",
      model: "m1",
      purpose: "总控",
      skills: ["go"],
      roleTag: "组织者",
      remark: "主根",
    })

    expect(agent.status).toBe("online")
    expect(agent.parentId).toBeUndefined()
    expect(agent.rootId).toBe(agent.id)

    const tokenPath = join(home, "tokens", agent.id)
    expect(existsSync(tokenPath)).toBe(true)
    expect(readFileSync(tokenPath, "utf8")).toBe(joinToken)
    if (process.platform !== "win32") {
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
    }
  })

  it("re-claims the same root id as online when re-registering with the same join_token", () => {
    const first = registerRoot(db, home, { name: "root-claim", vendor: "opencode" })
    touchAgent(db, first.agent.id, "offline")
    expect(getAgent(db, first.agent.id)?.status).toBe("offline")

    const second = registerRoot(db, home, {
      joinToken: first.joinToken,
      name: "root-claim",
      vendor: "opencode",
    })

    expect(second.agent.id).toBe(first.agent.id)
    expect(second.agent.status).toBe("online")
    expect(second.joinToken).toBe(first.joinToken)
  })

  it("rejects an unknown join_token", () => {
    expect(() =>
      registerRoot(db, home, { name: "root-x", joinToken: "not-a-real-token" }),
    ).toThrow(RegistrationError)
  })
})

describe("registerChild", () => {
  it("returns the same node with parent_id unchanged when task_ref repeats", () => {
    const rootOne = registerRoot(db, home, { name: "idem-root-1" }).agent
    const rootTwo = registerRoot(db, home, { name: "idem-root-2" }).agent

    const first = registerChild(db, { taskRef: "task-77", parentId: rootOne.id, name: "idem-child" })
    const again = registerChild(db, { taskRef: "task-77", parentId: rootTwo.id, name: "idem-child" })

    expect(again.id).toBe(first.id)
    expect(again.parentId).toBe(rootOne.id)
    expect(getAgent(db, first.id)?.rootId).toBe(rootOne.id)
  })

  it("mounts a child under its parent in the roster tree", () => {
    const root = registerRoot(db, home, { name: "tree-root" }).agent
    const child = registerChild(db, { taskRef: "task-tree", parentId: root.id, name: "tree-child" })

    expect(child.parentId).toBe(root.id)
    expect(child.rootId).toBe(root.id)

    const rootNode = rosterTree(db).find((n) => n.id === root.id)
    expect(rootNode?.children.map((c) => c.id)).toContain(child.id)
  })

  it("rejects a registration whose parent does not exist", () => {
    expect(() =>
      registerChild(db, { taskRef: "task-ghost", parentId: "missing-id", name: "ghost" }),
    ).toThrow(/parent agent not found/)
  })
})

describe("registerLogical", () => {
  it("creates a logical node that never comes online, attached to the tree", () => {
    const root = registerRoot(db, home, { name: "logical-root" }).agent

    const logical = registerLogical(db, {
      name: "board",
      parentId: root.id,
      roleTag: "留言板",
      remark: "群公告位",
    })

    expect(logical.kind).toBe("logical")
    expect(logical.status).toBe("offline")
    expect(logical.parentId).toBe(root.id)
    expect(logical.rootId).toBe(root.id)
  })
})

describe("retire", () => {
  it("marks the agent retired with retired_at set", () => {
    const root = registerRoot(db, home, { name: "retire-root" }).agent
    const child = registerChild(db, { taskRef: "task-retire", parentId: root.id, name: "retire-child" })

    const retired = retire(db, child.id)

    expect(retired.status).toBe("retired")
    expect(retired.retiredAt).toBeGreaterThan(0)
  })

  it("blocks re-registration of a retired child via task_ref", () => {
    const root = registerRoot(db, home, { name: "retire-root-2" }).agent
    const child = registerChild(db, { taskRef: "task-retire-2", parentId: root.id, name: "retire-child-2" })
    retire(db, child.id)

    expect(() =>
      registerChild(db, { taskRef: "task-retire-2", parentId: root.id, name: "retire-child-2" }),
    ).toThrow(RegistrationError)
    expect(getAgent(db, child.id)?.status).toBe("retired")
  })

  it("blocks claiming a retired root via join_token without re-activating it", () => {
    const rootRes = registerRoot(db, home, { name: "retire-claim" })
    retire(db, rootRes.agent.id)

    expect(() =>
      registerRoot(db, home, { joinToken: rootRes.joinToken, name: "retire-claim" }),
    ).toThrow(RegistrationError)
    expect(getAgent(db, rootRes.agent.id)?.status).toBe("retired")
  })

  it("throws AgentNotFoundError for an unknown id", () => {
    expect(() => retire(db, "no-such-agent")).toThrow(AgentNotFoundError)
  })
})

describe("rosterTree", () => {
  it("reports a stale online node as offline AND persists the row to offline", () => {
    const { agent } = registerRoot(db, home, { name: "stale-root" })
    db.prepare<[number, string], void>("UPDATE agents SET last_seen = ? WHERE id = ?").run(
      Date.now() - OFFLINE_AFTER_MS - 1,
      agent.id,
    )

    const node = rosterTree(db).find((n) => n.id === agent.id)

    expect(node?.status).toBe("offline")
    expect(getAgent(db, agent.id)?.status).toBe("offline")
  })

  it("reports a stale busy node as offline AND persists the row to offline", () => {
    const { agent } = registerRoot(db, home, { name: "stale-busy" })
    touchAgent(db, agent.id, "busy")
    db.prepare<[number, string], void>("UPDATE agents SET last_seen = ? WHERE id = ?").run(
      Date.now() - OFFLINE_AFTER_MS - 1,
      agent.id,
    )

    const node = rosterTree(db).find((n) => n.id === agent.id)

    expect(node?.status).toBe("offline")
    expect(getAgent(db, agent.id)?.status).toBe("offline")
  })

  it("persists once and emits exactly one agent event; re-reading neither rewrites nor re-emits", () => {
    const { agent } = registerRoot(db, home, { name: "stale-once" })
    db.prepare<[number, string], void>("UPDATE agents SET last_seen = ? WHERE id = ?").run(
      Date.now() - OFFLINE_AFTER_MS - 1,
      agent.id,
    )
    resetWsHub()
    const before = currentWsSeq()

    const first = rosterTree(db)
    expect(first.find((n) => n.id === agent.id)?.status).toBe("offline")
    expect(getAgent(db, agent.id)?.status).toBe("offline")
    expect(currentWsSeq()).toBe(before + 1) // 落库即发一次 agent 树事件

    rosterTree(db) // 幂等：已 offline 的行不再写、不再发事件
    expect(currentWsSeq()).toBe(before + 1)
    expect(getAgent(db, agent.id)?.status).toBe("offline")
  })

  it("leaves fresh, offline, retired and logical nodes untouched on a roster read", () => {
    const stale = registerRoot(db, home, { name: "co-exists-stale" }).agent
    const fresh = registerRoot(db, home, { name: "co-fresh" }).agent
    const retiredNode = registerRoot(db, home, { name: "co-retired" }).agent
    const logical = registerLogical(db, { name: "co-logical", parentId: fresh.id })
    retire(db, retiredNode.id)
    const offlineRoot = registerRoot(db, home, { name: "co-offline" }).agent
    touchAgent(db, offlineRoot.id, "offline")
    // 把未超阈值节点的 last_seen 拉到可辨识的旧值：若被误触碰即可检出。
    const observed = Date.now() - 5000
    for (const id of [fresh.id, retiredNode.id, logical.id, offlineRoot.id]) {
      db.prepare<[number, string], void>("UPDATE agents SET last_seen = ? WHERE id = ?").run(observed, id)
    }
    db.prepare<[number, string], void>("UPDATE agents SET last_seen = ? WHERE id = ?").run(
      Date.now() - OFFLINE_AFTER_MS - 1,
      stale.id,
    )
    resetWsHub()
    const before = currentWsSeq()

    const tree = rosterTree(db)

    expect(tree.find((n) => n.id === stale.id)?.status).toBe("offline")
    expect(getAgent(db, stale.id)?.status).toBe("offline")
    expect(currentWsSeq()).toBe(before + 1) // 只有 stale 这一处变化 → 恰好一次事件
    // 其余节点原样：状态与 last_seen 均未被触碰。
    expect(getAgent(db, fresh.id)?.status).toBe("online")
    expect(getAgent(db, retiredNode.id)?.status).toBe("retired")
    expect(getAgent(db, logical.id)?.status).toBe("offline")
    expect(getAgent(db, offlineRoot.id)?.status).toBe("offline")
    for (const id of [fresh.id, retiredNode.id, logical.id, offlineRoot.id]) {
      expect(getAgent(db, id)?.lastSeen).toBe(observed)
    }
  })

  it("keeps registration at exactly one agent event even when a stale node exists (no double emit)", () => {
    const stale = registerRoot(db, home, { name: "co-stale-parent" }).agent
    db.prepare<[number, string], void>("UPDATE agents SET last_seen = ? WHERE id = ?").run(
      Date.now() - OFFLINE_AFTER_MS - 1,
      stale.id,
    )
    resetWsHub()
    const before = currentWsSeq()

    registerRoot(db, home, { name: "co-newcomer" })

    expect(currentWsSeq()).toBe(before + 1) // 读路径落库与 emitAgentTree 不叠加
  })

  it("keeps retired nodes in the tree with status retired", () => {
    const root = registerRoot(db, home, { name: "grey-root" }).agent
    const child = registerChild(db, { taskRef: "task-grey", parentId: root.id, name: "grey-child" })
    retire(db, child.id)

    const rootNode = rosterTree(db).find((n) => n.id === root.id)

    expect(rootNode?.children.find((n) => n.id === child.id)?.status).toBe("retired")
  })

  // Important #1：写失败不得拖死读 —— 只读连接上 SELECT 成功、UPDATE 抛 SQLITE_READONLY。
  it("returns the correct tree without throwing when the offline persist write fails (readonly connection)", () => {
    const { agent } = registerRoot(db, home, { name: "ro-stale" })
    db.prepare<[number, string], void>("UPDATE agents SET last_seen = ? WHERE id = ?").run(
      Date.now() - OFFLINE_AFTER_MS - 1,
      agent.id,
    )
    // 同库第二条**只读**连接：展示态可算（SELECT 通），落库必败（UPDATE → SQLITE_READONLY）。
    const roDb = new Database(loadConfig({ AGENTCHAT_HOME: home }).dbPath, { readonly: true })
    const logged: unknown[][] = []
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
    resetWsHub()
    const before = currentWsSeq()
    try {
      const tree = rosterTree(roDb)

      // 读照常成功，展示态正确（未抛、非 500）。
      expect(tree.find((n) => n.id === agent.id)?.status).toBe("offline")
      // 写确实失败：行仍是 online（未被半写），也未发树事件。
      expect(getAgent(db, agent.id)?.status).toBe("online")
      expect(currentWsSeq()).toBe(before)
      // 失败被记日志（而非静默）。
      expect(logged.length).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
      roDb.close()
    }
  })
})

// 展示态落库 offline 后的状态上报序列（有意裁决：offline→busy 409，offline→online 放行）。
describe("展示态落库 offline 后的状态上报", () => {
  it("rejects busy with 409 while offline, then reactivates on the first online report", () => {
    const { agent } = registerRoot(db, home, { name: "reactivate-root" })
    db.prepare<[number, string], void>("UPDATE agents SET last_seen = ? WHERE id = ?").run(
      Date.now() - OFFLINE_AFTER_MS - 1,
      agent.id,
    )
    rosterTree(db) // 读路径把超阈值行落库 offline
    expect(getAgent(db, agent.id)?.status).toBe("offline")

    // 持续上报 busy → 409（白名单不扩：offline→busy 仍拒），行不动。
    expect(applyAgentState(db, { agentId: agent.id, state: "busy" })).toEqual({
      ok: false,
      error: "transition_rejected",
      status: 409,
    })
    expect(getAgent(db, agent.id)?.status).toBe("offline")

    // 首次 idle（→online）上报重激活，200 + 拉回 online。
    expect(applyAgentState(db, { agentId: agent.id, state: "idle" })).toEqual({ ok: true })
    expect(getAgent(db, agent.id)?.status).toBe("online")
  })
})

// ── 重注册更新卡片字段（会话标题漂移等；Part 1）────────────────────

describe("重注册更新卡片字段", () => {
  it("join_token 认领时按已提供字段更新名字，未提供字段与身份字段保持不动", () => {
    const first = registerRoot(db, home, {
      name: "claim-old",
      vendor: "opencode",
      model: "m0",
      purpose: "旧目的",
      remark: "备注0",
      roleTag: "标签0",
      skills: ["go"],
    }).joinToken
    const claimed = registerRoot(db, home, {
      joinToken: first,
      name: "claim-new",
      vendor: "claude-code", // 身份字段：不得改写
      model: "m1",
      purpose: "新目的",
    }).agent

    expect(claimed.name).toBe("claim-new")
    expect(claimed.model).toBe("m1")
    expect(claimed.purpose).toBe("新目的")
    // 未提供 → 不动。
    expect(claimed.remark).toBe("备注0")
    expect(claimed.roleTag).toBe("标签0")
    expect(claimed.skills).toEqual(["go"])
    // 身份/结构字段不动。
    expect(claimed.vendor).toBe("opencode")
    expect(claimed.kind).toBe("runtime")
    expect(claimed.status).toBe("online")
    expect(claimed.parentId).toBeUndefined()
  })

  it("子 task_ref 幂等重注册时更新名字，parent/kind/vendor/status/未提供字段均不动", () => {
    const parentOne = registerRoot(db, home, { name: "cp-root-1" }).agent
    const parentTwo = registerRoot(db, home, { name: "cp-root-2" }).agent
    const first = registerChild(db, {
      taskRef: "cp-task",
      parentId: parentOne.id,
      name: "child-old",
      vendor: "v0",
      model: "m0",
      remark: "r0",
    })
    const again = registerChild(db, {
      taskRef: "cp-task",
      parentId: parentTwo.id,
      name: "child-new",
      vendor: "v1",
      purpose: "p1",
    })

    expect(again.id).toBe(first.id)
    expect(again.name).toBe("child-new")
    expect(again.purpose).toBe("p1")
    // 未提供 → 不动；vendor（身份）→ 不动。
    expect(again.model).toBe("m0")
    expect(again.remark).toBe("r0")
    expect(again.vendor).toBe("v0")
    expect(again.kind).toBe("runtime")
    expect(again.status).toBe("online")
    // parent 不改写（既有幂等裁决）。
    expect(again.parentId).toBe(parentOne.id)
  })

  it("重注册每次恰好发一次 agent 树事件", () => {
    const res = registerRoot(db, home, { name: "emit-root" })
    resetWsHub()
    const before = currentWsSeq()
    registerRoot(db, home, { joinToken: res.joinToken, name: "emit-root-renamed" })
    expect(currentWsSeq()).toBe(before + 1)
  })

  it("重注册仍拒绝已退役节点（改名不绕过退役）", () => {
    const res = registerRoot(db, home, { name: "retire-rename" })
    retire(db, res.agent.id)
    expect(() =>
      registerRoot(db, home, { joinToken: res.joinToken, name: "retire-renamed" }),
    ).toThrow(RegistrationError)
    expect(getAgent(db, res.agent.id)?.name).toBe("retire-rename")
    expect(getAgent(db, res.agent.id)?.status).toBe("retired")
  })
})

describe("未提供 name 的注册与认领（Part 1 回归：不带 name 不得被改名）", () => {
  it("join_token 认领未提供 name 时保持原名（Claude SessionStart 每次都不带 name）", () => {
    const first = registerRoot(db, home, { name: "claude-root", vendor: "claude-code" })
    const claimed = registerRoot(db, home, {
      joinToken: first.joinToken,
      vendor: "claude-code",
      purpose: "coding-agent",
    })

    expect(claimed.agent.id).toBe(first.agent.id)
    expect(claimed.agent.name).toBe("claude-root")
    expect(claimed.agent.purpose).toBe("coding-agent")
    expect(claimed.agent.vendor).toBe("claude-code")
  })

  it("子 task_ref 幂等重注册未提供 name 时保持原名，已提供字段照常更新", () => {
    const root = registerRoot(db, home, { name: "nn-root" }).agent
    const first = registerChild(db, {
      taskRef: "nn-task",
      parentId: root.id,
      name: "子节点",
      vendor: "claude-code",
    })
    const again = registerChild(db, {
      taskRef: "nn-task",
      parentId: root.id,
      vendor: "claude-code",
      purpose: "sub",
    })

    expect(again.id).toBe(first.id)
    expect(again.name).toBe("子节点")
    expect(again.purpose).toBe("sub")
  })

  it("新建未提供 name 时生成 vendor-model-hex 兜底名（格式与旧 MCP 层一致）", () => {
    const root = registerRoot(db, home, { vendor: "claude-code" })
    expect(root.agent.name).toMatch(/^claude-code-unknown-[0-9a-f]{4}$/)

    const child = registerChild(db, {
      taskRef: "nn-fallback",
      parentId: root.agent.id,
      vendor: "opencode",
      model: "m1",
    })
    expect(child.name).toMatch(/^opencode-m1-[0-9a-f]{4}$/)
  })
})

describe("canTransition", () => {
  it("permits exactly the whitelisted transitions", () => {
    expect(canTransition("online", "busy")).toBe(true)
    expect(canTransition("busy", "online")).toBe(true)
    expect(canTransition("online", "offline")).toBe(true)
    expect(canTransition("busy", "offline")).toBe(true)
    expect(canTransition("online", "retired")).toBe(true)
    expect(canTransition("busy", "retired")).toBe(true)
    expect(canTransition("offline", "retired")).toBe(true)
  })

  it("rejects transitions outside the whitelist", () => {
    expect(canTransition("offline", "busy")).toBe(false)
    expect(canTransition("retired", "online")).toBe(false)
    expect(canTransition("retired", "busy")).toBe(false)
    expect(canTransition("retired", "offline")).toBe(false)
  })

  // 展示态落库后的重激活裁决：roster 把超阈值节点写成 offline 后，
  // 活节点必须能经状态上报（`/internal/state idle→online`）拉回，否则会永久卡死。
  it("permits offline → online so a persisted-offline node can be reactivated by a state report", () => {
    expect(canTransition("offline", "online")).toBe(true)
  })
})

describe("GET /api/roster", () => {
  it("returns the nested tree with contact-card fields and unread", async () => {
    const rootRes = registerRoot(db, home, {
      name: "roster-root",
      vendor: "opencode",
      model: "m1",
      purpose: "总控协调",
      roleTag: "组织者",
      remark: "主根",
    })
    const root = rootRes.agent
    const child = registerChild(db, {
      taskRef: "task-roster-child",
      parentId: root.id,
      name: "roster-child",
      vendor: "claude-code",
      model: "c1",
      skills: ["go", "sql"],
    })
    const grandchild = registerChild(db, {
      taskRef: "task-roster-gc",
      parentId: child.id,
      name: "roster-gc",
    })
    const logical = registerLogical(db, { name: "roster-board", parentId: root.id })
    const dm = createDm(db, root.id, child.id)
    send(db, { conversationId: dm.id, fromAgentId: root.id, body: "开工" })

    const res = await createApp(db).request("/api/roster")

    expect(res.status).toBe(200)
    const nodes = rosterTreeSchema.parse(await res.json())
    const rootNode = nodes.find((n) => n.id === root.id)
    expect(rootNode).toMatchObject({
      vendor: "opencode",
      model: "m1",
      role_tag: "组织者",
      remark: "主根",
      purpose: "总控协调",
      status: "online",
      unread: 0,
    })
    const childNode = rootNode?.children.find((n) => n.id === child.id)
    expect(childNode?.unread).toBe(1)
    expect(childNode?.children.map((n) => n.id)).toContain(grandchild.id)
    expect(rootNode?.children.find((n) => n.id === logical.id)?.kind).toBe("logical")

    // Plan 3 T6：roster 出参补 `skills`（资料卡技能 chips）；注册值原样透传。
    expect(childNode?.skills).toEqual(["go", "sql"])
    // 未提供 skills 的节点 → 空数组（register 缺省 `[]`，非 null/缺字段）。
    expect(rootNode?.skills).toEqual([])
    expect(childNode?.children.find((n) => n.id === grandchild.id)?.skills).toEqual([])
  })

  it("keeps skills stable across a re-read and defaults missing skills to an empty array", async () => {
    const root = registerRoot(db, home, { name: "skills-root" }).agent
    registerChild(db, {
      taskRef: "task-skills-none",
      parentId: root.id,
      name: "skills-child",
      skills: ["ts"],
    })

    const first = rosterTreeSchema.parse(await (await createApp(db).request("/api/roster")).json())
    const node = first.find((n) => n.id === root.id)?.children.find((n) => n.name === "skills-child")
    expect(node?.skills).toEqual(["ts"])

    // 再读一次（模拟 WS 重拉）：字段稳定，不漂移。
    const again = rosterTreeSchema.parse(await (await createApp(db).request("/api/roster")).json())
    const reread = again.find((n) => n.id === root.id)?.children.find((n) => n.name === "skills-child")
    expect(reread?.skills).toEqual(["ts"])
  })

  it("shows a stale node offline and persists its DB row to offline (display state now lands in the store)", async () => {
    const root = registerRoot(db, home, { name: "persist-root", vendor: "opencode" }).agent
    const staleChild = registerChild(db, {
      taskRef: "task-persist-stale",
      parentId: root.id,
      name: "persist-stale",
    })
    db.prepare<[number, string], void>("UPDATE agents SET last_seen = ? WHERE id = ?").run(
      Date.now() - OFFLINE_AFTER_MS - 1,
      staleChild.id,
    )

    const res = await createApp(db).request("/api/roster")

    expect(res.status).toBe(200)
    const nodes = rosterTreeSchema.parse(await res.json())
    const childNode = nodes.find((n) => n.id === root.id)?.children.find((n) => n.id === staleChild.id)
    expect(childNode?.status).toBe("offline")
    expect(getAgent(db, staleChild.id)?.status).toBe("offline")
    // 未超阈值的根节点不受影响。
    expect(nodes.find((n) => n.id === root.id)?.status).toBe("online")
    expect(getAgent(db, root.id)?.status).toBe("online")
  })
})

// ── Task 6：custom_name 迁移 + 展示名优先级（用户改名 > 系统名） ─────────────

describe("custom_name 迁移（migrateAgents 幂等）", () => {
  it("旧库缺列 → openDb 补列并建展示名唯一索引；旧数据展示名回落 name；重复打开安全", () => {
    const legacyHome = mkdtempSync(join(tmpdir(), "agentchat-agents-legacy-"))
    const legacyPath = loadConfig({ AGENTCHAT_HOME: legacyHome }).dbPath
    try {
      seedLegacyAgentsDb(legacyPath)

      const migrated = openDb(legacyPath)
      expect(agentsColumns(migrated)).toContain("custom_name")
      expect(displayIndexSql(migrated)).toContain("COALESCE(custom_name, name)")
      const legacy = getAgent(migrated, "legacy-agent")
      if (legacy === undefined) throw new Error("legacy row lost after migration")
      expect(legacy.customName).toBeUndefined()
      expect(agentDisplayName(legacy)).toBe("legacy-root")
      migrated.close()

      // 幂等：重复 openDb 不报错、不重复加列。
      const reopened = openDb(legacyPath)
      expect(agentsColumns(reopened).filter((c) => c === "custom_name")).toHaveLength(1)
      expect(displayIndexSql(reopened)).toContain("COALESCE(custom_name, name)")
      reopened.close()
    } finally {
      rmSync(legacyHome, { recursive: true, force: true })
    }
  })

  it("出厂 schema 路径含新列与展示名唯一索引（clearAllTables 重跑 schema.sql）", () => {
    expect(agentsColumns(db)).toContain("custom_name")
    expect(displayIndexSql(db)).toContain("COALESCE(custom_name, name)")

    const victim = registerRoot(db, home, { name: "reset-victim", vendor: "opencode" }).agent
    renameAgent(db, victim.id, "出厂前改名")
    clearAllTables(db)

    expect(agentsColumns(db)).toContain("custom_name")
    expect(displayIndexSql(db)).toContain("COALESCE(custom_name, name)")
    // 出厂后 custom_name 随表重建清空（与出厂态一致）。
    const fresh = registerRoot(db, home, { name: "post-reset-root", vendor: "opencode" }).agent
    expect(fresh.customName).toBeUndefined()
    expect(agentDisplayName(fresh)).toBe("post-reset-root")
  })
})

describe("agentDisplayName 与 renameAgent", () => {
  it("agentDisplayName = customName ?? name（展示名优先级）", () => {
    const root = registerRoot(db, home, { name: "display-src", vendor: "opencode" }).agent
    expect(agentDisplayName(root)).toBe("display-src")
    const renamed = renameAgent(db, root.id, "用户起的名")
    expect(agentDisplayName(renamed)).toBe("用户起的名")
    // 系统名不动（register/标题同步只写 name 的对偶面）。
    expect(renamed.name).toBe("display-src")
    expect(getAgent(db, root.id)?.customName).toBe("用户起的名")
  })

  it("未知 id → AgentNotFoundError；他人展示名（raw 或 custom）冲突 → AgentNameTakenError(code name_taken)；自身幂等改名放行", () => {
    const a = registerRoot(db, home, { name: "conflict-a", vendor: "opencode" }).agent
    const b = registerRoot(db, home, { name: "conflict-b", vendor: "opencode" }).agent

    expect(() => renameAgent(db, "no-such-agent", "任意名")).toThrow(AgentNotFoundError)
    // 冲突目标是他人展示名：b 未改名时展示名 = 裸名。
    expect(() => renameAgent(db, a.id, "conflict-b")).toThrow(AgentNameTakenError)
    renameAgent(db, b.id, "b-custom")
    // 冲突目标是他人 custom_name。
    expect(() => renameAgent(db, a.id, "b-custom")).toThrow(AgentNameTakenError)

    let caught: unknown
    try {
      renameAgent(db, a.id, "b-custom")
      throw new Error("expected AgentNameTakenError")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AgentNameTakenError)
    if (caught instanceof AgentNameTakenError) expect(caught.code).toBe("name_taken")

    // 自身幂等：改到自身当前展示名（b 已 custom，重复写同值）放行。
    expect(() => renameAgent(db, b.id, "b-custom")).not.toThrow()
    expect(getAgent(db, b.id)?.customName).toBe("b-custom")
  })

  it("优先级：改名后同 task_ref 重注册（新会话标题）→ 展示名仍是用户改的，custom_name 未变", () => {
    const root = registerRoot(db, home, { name: "prio-root", vendor: "opencode" }).agent
    const child = registerChild(db, { taskRef: "t6-prio", parentId: root.id, name: "旧会话标题" })
    renameAgent(db, child.id, "用户改的名")

    const again = registerChild(db, { taskRef: "t6-prio", parentId: root.id, name: "新会话标题" })

    expect(again.id).toBe(child.id)
    expect(again.name).toBe("新会话标题") // name 随标题漂移（既有语义）
    expect(again.customName).toBe("用户改的名") // custom_name 未被 register 触碰
    expect(agentDisplayName(again)).toBe("用户改的名")
    // 回归点①：roster 取名（buildRoster 单点覆盖 roster 三输出）。
    const rootNode = rosterTree(db).find((n) => n.id === root.id)
    expect(rootNode?.children.find((n) => n.id === child.id)?.name).toBe("用户改的名")
  })

  it("回归④：群 ask 提及集用展示名（mentionableTargets/isRealAgent 切展示名口径）", () => {
    const root = registerRoot(db, home, { name: "ask-src-root", vendor: "opencode" }).agent
    const member = registerChild(db, {
      taskRef: "t6-ask-member",
      parentId: root.id,
      name: "ask-member",
    })
    const outsider = registerRoot(db, home, { name: "ask-outsider", vendor: "opencode" }).agent
    renameAgent(db, member.id, "改名后的成员")
    renameAgent(db, outsider.id, "改名后的群外")
    const group = createGroup(db, {
      name: "t6-ask-group",
      createdBy: root.id,
      memberIds: [member.id],
    })

    // 提及集以展示名寻址：改名后的成员可被 @ 中并成为 ask 目标。
    const asked = askGroup(db, root.id, {
      to: group.id,
      question: "选哪个？",
      options: ["a", "b"],
      mentions: ["改名后的成员"],
    })
    expect(asked.asks).toHaveLength(1)
    expect(asked.asks[0]?.target).toBe(member.id)

    // isRealAgent 展示名匹配：群外真实节点按展示名提及 → mention_not_participant（而非 not_found）。
    expect(() =>
      askGroup(db, root.id, {
        to: group.id,
        question: "选哪个？",
        options: ["a"],
        mentions: ["改名后的群外"],
      }),
    ).toThrow(MentionNotParticipantError)
  })
})
