/**
 * Plan 4 修复波 Phase 1 —— `POST /internal/retire`（缺陷 #4 服务端部分）：
 * 适配器可调用的退役接缝。合同冻结：`200 {ok}` / `404 agent_not_found` /
 * `400 invalid_body` / 无票或错票 401；重复退役幂等；退役取消待投递 job、
 * roster 显示 retired、不可复活；退役是 hub 内部接缝，MCP_TOOLS 恒 12。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearAdapters } from "../../server/adapters/types"
import { loadConfig } from "../../server/config"
import { RegistrationError, registerChild, rosterTree } from "../../server/core/agents"
import { sendMessage } from "../../server/core/messaging"
import { openDb, type Db } from "../../server/db"
import { createApp } from "../../server/index"
import { ensureHubToken } from "../../server/routes/internal"
import { getAgent, insertAgent, type Agent } from "../../server/store/agents"
import { getWakeJob, type WakeJob } from "../../server/store/wake"
import { MCP_TOOLS, type RosterNode } from "../../shared/contracts"

let home = ""
let db: Db
let token = ""
let app: ReturnType<typeof createApp>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-retire-"))
  db = openDb(loadConfig({ AGENTCHAT_HOME: home }).dbPath)
  clearAdapters()
  app = createApp(db, { hubTokenPath: join(home, "hub_token"), adapters: ["opencode"] })
  token = ensureHubToken(join(home, "hub_token"))
})

afterEach(() => {
  clearAdapters()
  db.close()
  rmSync(home, { recursive: true, force: true })
})

function makeAgent(name: string): Agent {
  return insertAgent(db, { name, kind: "runtime", status: "online", vendor: "opencode" })
}

async function post(path: string, body: unknown, withAuth = true): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: withAuth
      ? { authorization: `Bearer ${token}`, "content-type": "application/json" }
      : { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function findNode(nodes: readonly RosterNode[], id: string): RosterNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    const hit = findNode(node.children, id)
    if (hit !== undefined) return hit
  }
  return undefined
}

function expectJob(messageSeq: number, agentId: string): WakeJob {
  const job = getWakeJob(db, messageSeq, agentId)
  if (job === undefined) throw new Error(`wake job missing for message ${messageSeq}`)
  return job
}

describe("POST /internal/retire", () => {
  it("retires a child, cancels undelivered jobs, shows retired in roster and rejects re-registration", async () => {
    const root = makeAgent("retire-root")
    const child = registerChild(db, {
      taskRef: "task-retire",
      parentId: root.id,
      name: "retire-child",
      vendor: "opencode",
    })
    const sender = makeAgent("retire-sender")
    const { message } = sendMessage(db, { from: sender.id, to: child.id, body: "即将离场" })
    expect(expectJob(message.seq, child.id).state).toBe("pending")

    const res = await post("/internal/retire", { agentId: child.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    expect(getAgent(db, child.id)?.status).toBe("retired")
    expect(findNode(rosterTree(db), child.id)?.status).toBe("retired")
    expect(expectJob(message.seq, child.id).state).toBe("cancelled")

    // 幂等：二次退役仍 ok
    const again = await post("/internal/retire", { agentId: child.id })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ ok: true })

    // 不可复活：同 task_ref 再注册被拒（retired）
    let caught: unknown
    try {
      registerChild(db, {
        taskRef: "task-retire",
        parentId: root.id,
        name: "retire-child",
        vendor: "opencode",
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RegistrationError)
    if (caught instanceof RegistrationError) expect(caught.code).toBe("retired")
  })

  it("rejects missing/wrong token with 401, unknown id with 404 and invalid body with 400; keeps MCP_TOOLS at 12", async () => {
    const root = makeAgent("guard-root")

    expect((await post("/internal/retire", { agentId: root.id }, false)).status).toBe(401)
    const wrong = await app.request("/internal/retire", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ agentId: root.id }),
    })
    expect(wrong.status).toBe(401)

    const unknown = await post("/internal/retire", { agentId: "does-not-exist" })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ ok: false, error: "agent_not_found" })

    const empty = await post("/internal/retire", { agentId: "" })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ ok: false, error: "invalid_body" })

    const malformed = await post("/internal/retire", { nope: 1 })
    expect(malformed.status).toBe(400)

    // 退役不进 MCP 面
    expect(MCP_TOOLS).toHaveLength(12)
  })
})
