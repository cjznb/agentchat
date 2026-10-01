/**
 * 真机事故的回归测试（10/1）：DSH 会话 id 形如 `session-<uuid>`，`slice(0, 8)` 恒为常量
 * `session-` → 同目录所有会话算出同名 → Hub `agents.name` 唯一索引拒绝注册（`name_taken`），
 * 该会话在 Hub 里没有节点、消息无处投递；同时重启后陈旧的 `agents/dsh.current` 未被清除，
 * 出站身份被记到旧会话名下。
 *
 * 本文件把四件事钉死：① 命名不再撞键；② 真撞名时按短哈希后缀重试一次；③ 新进程会清掉陈旧提示；
 * ④ 宿主 `createUserMessage` 解析不到时仍能产出可用消息（退化为最小 UserMessage）。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HubToolError } from "../lib/hub.js"
import { alternateTitle, normalizeTitle, TITLE_MAX_CHARS } from "../lib/title.js"
import { createMessageBuilder, MESSAGE_SOURCE, messageFactoryCandidates } from "../lib/message.js"
import { registerWithNameRetry } from "../lib/register.js"
import { createSessionHint, idSuffix, sessionName } from "../lib/session-hint.js"
import { currentPath, readToken, writeToken } from "../lib/token.js"

const homes: string[] = []
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agentchat-dsh-naming-"))
  homes.push(home)
  return home
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const UUID_A = "session-91fa2fb6-fbce-4b44-9853-4b5f738677b2"
const UUID_B = "session-f79d9a5c-1111-2222-3333-444455556666"
const CWD = "C:\\Users\\cjz\\Documents\\deepseek-harness\\default-workspace"

describe("会话节点命名（真机撞名事故的根因）", () => {
  it("idSuffix 剥掉 DSH 的 `session-` 前缀，不再返回常量 `session-`", () => {
    expect(idSuffix(UUID_A)).toBe("91fa2fb6")
    expect(idSuffix(UUID_B)).toBe("f79d9a5c")
    expect(idSuffix("session-")).toBe("session-") // 退化输入：剥完为空 → 回退原 id
    expect(idSuffix("4ed70484-8c1e-4b44-9853-4b5f738677b2")).toBe("4ed70484") // 无前缀的 id 照旧
  })

  it("同一工作目录下的两个 `session-<uuid>` 会话得到不同节点名", () => {
    const a = sessionName({ cwd: CWD }, UUID_A)
    const b = sessionName({ cwd: CWD }, UUID_B)
    expect(a).toBe("default-workspace-91fa2fb6")
    expect(b).toBe("default-workspace-f79d9a5c")
    expect(a).not.toBe(b)
  })

  it("无 cwd 时回退 `dsh-<短标识>`", () => {
    expect(sessionName({}, UUID_A)).toBe("dsh-91fa2fb6")
  })
})

describe("registerWithNameRetry（Hub 唯一索引兜底）", () => {
  const args = { name: "default-workspace-91fa2fb6", task_ref: UUID_A, vendor: "dsh" }

  it("`name_taken` → 追加会话 id 短哈希后缀并**只重试一次**", async () => {
    const calls: Record<string, unknown>[] = []
    const hub = {
      register: async (input: Record<string, unknown>) => {
        calls.push(input)
        if (calls.length === 1) throw new HubToolError("name_taken", "agent name already taken [name_taken]")
        return { agentId: "agent-1", joinToken: undefined }
      },
    }
    const result = await registerWithNameRetry(hub, args, () => {})
    expect(result.agentId).toBe("agent-1")
    expect(calls).toHaveLength(2)
    expect(String(calls[1]?.["name"])).toMatch(/^default-workspace-91fa2fb6-[0-9a-f]{6}$/)
    expect(calls[1]?.["task_ref"]).toBe(UUID_A) // 其余入参原样带过
  })

  it("后缀由 `task_ref` 决定（不同会话必得不同后缀，确定性）", async () => {
    const altNameFor = async (taskRef: string): Promise<string> => {
      const calls: Record<string, unknown>[] = []
      const hub = {
        register: async (input: Record<string, unknown>) => {
          calls.push(input)
          if (calls.length === 1) throw new HubToolError("name_taken", "taken [name_taken]")
          return { agentId: "agent-x", joinToken: undefined }
        },
      }
      await registerWithNameRetry(hub, { ...args, task_ref: taskRef }, () => {})
      return String(calls[1]?.["name"])
    }
    const a = await altNameFor(UUID_A)
    const b = await altNameFor(UUID_B)
    expect(a).not.toBe(b)
    expect(await altNameFor(UUID_A)).toBe(a) // 同一 task_ref 确定性
  })

  it("非 `name_taken` 错误原样抛出（不重试、不改名）", async () => {
    let count = 0
    const hub = {
      register: async () => {
        count += 1
        throw new HubToolError("identity_required", "no identity [identity_required]")
      },
    }
    await expect(registerWithNameRetry(hub, args, () => {})).rejects.toThrow("identity_required")
    expect(count).toBe(1)
  })
})

describe("会话提示文件（重启后不得留陈旧值）", () => {
  it("上一代进程留下的 `dsh.current` 在新进程卸载时被清除（而不是因同值早退而留存）", () => {
    const home = tempHome()
    writeToken(currentPath(home), "8398af70-stale-node")
    const hint = createSessionHint(home, 16, () => {})
    hint.clear() // 插件卸载路径：live 为空 → 应删文件
    expect(readToken(currentPath(home))).toBeUndefined()
  })

  it("恰好一个顶层会话 → 写该节点；多于一个且无人跑回合 → 删除（不猜）", () => {
    const home = tempHome()
    const hint = createSessionHint(home, 16, () => {})
    hint.onRegistered("s1", "node-1", true)
    expect(readToken(currentPath(home))).toBe("node-1")
    hint.onRegistered("s2", "node-2", true)
    expect(readToken(currentPath(home))).toBeUndefined()
    hint.onRegistered("s3", "node-3", false) // 子代理不参与计数
    expect(readToken(currentPath(home))).toBeUndefined()
  })

  it("多会话并存时取**正在跑回合**的那个（真机：桌面端恢复两个会话）", () => {
    const home = tempHome()
    const hint = createSessionHint(home, 16, () => {})
    hint.onRegistered("s1", "node-1", true)
    hint.onRegistered("s2", "node-2", true)
    expect(readToken(currentPath(home))).toBeUndefined() // 无人跑回合 → 不猜（桥回落容器）
    hint.onRunning("s2")
    expect(readToken(currentPath(home))).toBe("node-2") // 回合内发出的 MCP 调用归属 s2
    hint.onRunning("s1")
    expect(readToken(currentPath(home))).toBe("node-1") // 换成 s1 在跑
    hint.onDisposed("s1")
    expect(readToken(currentPath(home))).toBe("node-2") // 活跃者释放 → 只剩 s2，回到它
    hint.onRegistered("s3", "node-3", false)
    expect(readToken(currentPath(home))).toBe("node-2") // 子代理不影响
  })
})

describe("注入消息工厂", () => {
  it("候选顺序：裸包名 → `$DSH_HOME/profiles/node_modules/.../dsh-llm/lib/index.js`", () => {
    const withHome = messageFactoryCandidates({ DSH_HOME: "D:\\dsh" })
    expect(withHome[0]).toBe("@deepseek-ai/dsh-llm")
    expect(withHome[1]).toContain("/profiles/node_modules/@deepseek-ai/dsh-llm/lib/index.js")
    expect(messageFactoryCandidates({})[1]).toContain("/.dsh/profiles/node_modules/")
  })

  it("两条路径都不可用时退化为最小 UserMessage（投递不受影响），且消息带 relay 来源", async () => {
    const logs: string[] = []
    const build = createMessageBuilder({ DSH_HOME: "D:\\definitely-missing-dsh-home" }, (m) => void logs.push(m))
    const message = (await build("你好")) as Record<string, unknown>
    expect(typeof message["id"]).toBe("string")
    expect(message["role"]).toBe("user")
    expect(message["source"]).toEqual(MESSAGE_SOURCE)
    expect(message["content"]).toEqual([{ type: "text", text: "你好" }])
    expect(logs.some((line) => line.includes("退化为最小 UserMessage"))).toBe(true)
  })

  it("来源 kind 必须是生产者自有（`plugin:agentchat`）：`kind:'plugin'` 会被会话格式 v4 拒绝", () => {
    // 真机事故：注入后整轮报「处理失败 format v4 message requires a producer-owned source kind」。
    // `dsh-session-format-v3-to-v4` 的准入明确拒绝 `kind === 'plugin'`，官方迁移把未知插件重写为 `plugin:<名字>`。
    expect(MESSAGE_SOURCE.kind).not.toBe("plugin")
    expect((MESSAGE_SOURCE as Record<string, unknown>)["plugin"]).toBeUndefined()
    expect(MESSAGE_SOURCE.kind).toMatch(/^plugin:/)
  })
})

describe("会话标题 → 展示名（Hub 展示名 = custom_name）", () => {
  it("归一化：去控制字符、折叠空白、去首尾空白；空/非字符串 → undefined", () => {
    expect(normalizeTitle("  为 agentchat\u0007 编写  DSH 适配器 ")).toBe("为 agentchat 编写 DSH 适配器")
    expect(normalizeTitle("多行\n标题\t带制表")).toBe("多行 标题 带制表")
    expect(normalizeTitle("   ")).toBeUndefined()
    expect(normalizeTitle(undefined)).toBeUndefined()
    expect(normalizeTitle(42)).toBeUndefined()
  })

  it("按**码点**截断到 64（Hub `agentRenameSchema` 上限），不会截断成半个代理对", () => {
    expect([...(normalizeTitle("字".repeat(80)) ?? "")].length).toBe(TITLE_MAX_CHARS)
    const emoji = normalizeTitle("🙂".repeat(80)) ?? ""
    expect([...emoji].length).toBe(TITLE_MAX_CHARS)
    expect(emoji).not.toContain("\uFFFD")
  })

  it("撞名退化名 = 「标题·会话短标识」，且仍不超过 64", () => {
    const alt = alternateTitle("为 agentchat 编写 DSH 适配器", "session-91fa2fb6-fbce-4b44-9853-4b5f738677b2")
    expect(alt).toBe("为 agentchat 编写 DSH 适配器·91fa2fb6")
    const longAlt = alternateTitle("字".repeat(80), "session-91fa2fb6-x") ?? ""
    expect([...longAlt].length).toBeLessThanOrEqual(TITLE_MAX_CHARS)
    expect(longAlt.endsWith("·91fa2fb6")).toBe(true)
  })
})
