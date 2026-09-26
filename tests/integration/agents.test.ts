/**
 * Task 3 —— 节点注册、身份与层级树集成测试（brief DoD）：
 * - join_token 文件（`$AGENTCHAT_HOME/tokens/<id>`，0600）与重连认领 offline→online
 * - `task_ref` 幂等（同 id、parent_id 不变）、子注册挂树
 * - `retire` 不可恢复（task_ref / join_token 两条注册路径均拒绝）
 * - `GET /api/roster` 嵌套树含 vendor/model/role_tag/remark/purpose/status/unread
 * - 展示态离线：`last_seen` 超过 600000ms 报 offline（存储状态不回写）
 * - 状态迁移白名单 `canTransition`
 * 每个用例使用独立临时 $AGENTCHAT_HOME。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
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
import { openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import { AgentNotFoundError, getAgent, touchAgent } from "../../server/store/agents"
import { createDm } from "../../server/store/conversations"
import { send } from "../../server/store/messages"

let home = ""
let db: Db

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
  it("reports a stale online node as offline while the stored status stays online", () => {
    const { agent } = registerRoot(db, home, { name: "stale-root" })
    db.prepare<[number, string], void>("UPDATE agents SET last_seen = ? WHERE id = ?").run(
      Date.now() - OFFLINE_AFTER_MS - 1,
      agent.id,
    )

    const node = rosterTree(db).find((n) => n.id === agent.id)

    expect(node?.status).toBe("offline")
    expect(getAgent(db, agent.id)?.status).toBe("online")
  })

  it("reports a stale busy node as offline while the stored status stays busy", () => {
    const { agent } = registerRoot(db, home, { name: "stale-busy" })
    touchAgent(db, agent.id, "busy")
    db.prepare<[number, string], void>("UPDATE agents SET last_seen = ? WHERE id = ?").run(
      Date.now() - OFFLINE_AFTER_MS - 1,
      agent.id,
    )

    const node = rosterTree(db).find((n) => n.id === agent.id)

    expect(node?.status).toBe("offline")
    expect(getAgent(db, agent.id)?.status).toBe("busy")
  })

  it("keeps retired nodes in the tree with status retired", () => {
    const root = registerRoot(db, home, { name: "grey-root" }).agent
    const child = registerChild(db, { taskRef: "task-grey", parentId: root.id, name: "grey-child" })
    retire(db, child.id)

    const rootNode = rosterTree(db).find((n) => n.id === root.id)

    expect(rootNode?.children.find((n) => n.id === child.id)?.status).toBe("retired")
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
    expect(canTransition("offline", "online")).toBe(false)
    expect(canTransition("offline", "busy")).toBe(false)
    expect(canTransition("retired", "online")).toBe(false)
    expect(canTransition("retired", "busy")).toBe(false)
    expect(canTransition("retired", "offline")).toBe(false)
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
  })
})
