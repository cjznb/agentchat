/**
 * Task 5 单测：以真实子进程运行 `install.mjs`，在临时 settings 上验证
 * ① 含用户自定义 hooks/mcpServers 的 settings 安装后用户条目完好 + 本适配器条目已加、
 * ② 安装两次内容等价（幂等，hooks 数组不重复）、③ `--uninstall` 精确移除且空数组键被清理、
 * ④ `--dry-run` 不落盘且打印 hooks 与 mcpServers 两处内容、
 * ⑤ 缺父目录/找不到配置 → 清晰错误 + 非 0 退出码。
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const ADAPTER_DIR = join(TEST_DIR, "..")
const INSTALL = join(ADAPTER_DIR, "install.mjs")
const ADAPTER_POSIX = ADAPTER_DIR.split(/[\\/]/).join("/")
const OUR_SCRIPTS = ["session-start.mjs", "subagent-start.mjs", "busy.mjs", "idle.mjs"]
const EVENTS: ReadonlyArray<readonly [string, string]> = [
  ["SessionStart", "session-start.mjs"],
  ["SubagentStart", "subagent-start.mjs"],
  ["PreToolUse", "busy.mjs"],
  ["PostToolUse", "busy.mjs"],
  ["Stop", "idle.mjs"],
  ["Notification", "idle.mjs"],
]
const OTHER_MCP = { type: "http", url: "https://example.com/mcp" }
const USER_SESSION_START = {
  matcher: "startup",
  hooks: [{ type: "command", command: "echo", args: ["user-session-start"] }],
}
const USER_STOP = { hooks: [{ type: "command", command: "echo", args: ["user-stop"] }] }

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-cc-install-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seedSettings(path: string): void {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        model: "sonnet",
        hooks: { SessionStart: [USER_SESSION_START], Stop: [USER_STOP] },
        mcpServers: { other: OTHER_MCP },
      },
      null,
      2,
    )}\n`,
  )
}

function run(args: readonly string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_SETTINGS: "", ...env },
  })
}

// ── 配置读取（`unknown` 边界 + 守卫，无 any）─────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readConfig(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isRecord(value)) throw new Error("settings root is not an object")
  return value
}

function nested(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  if (!isRecord(value)) throw new Error(`${key} is not an object`)
  return value
}

function arrayAt(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) throw new Error(`${key} is not an array`)
  return value
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Error("not a string")
  return value
}

/** 某 hooks 条目引用的脚本 basename 列表（`args[0]`）。 */
function entryScripts(entry: unknown): string[] {
  if (!isRecord(entry)) return []
  const hooks = entry["hooks"]
  if (!Array.isArray(hooks)) return []
  return hooks.flatMap((hook) => {
    if (!isRecord(hook)) return []
    const args = hook["args"]
    const first = Array.isArray(args) ? args[0] : undefined
    return typeof first === "string" ? [basename(first)] : []
  })
}

function ourCount(entries: unknown[]): number {
  return entries.filter((entry) => entryScripts(entry).some((name) => OUR_SCRIPTS.includes(name))).length
}

function hasOurEntry(entries: unknown[], script: string): boolean {
  return entries.some((entry) => entryScripts(entry).includes(script))
}

/** 定位本适配器的 command 条目，核对 exec form 的 `node` + 绝对路径。 */
function ourCommand(entries: unknown[], script: string): { command: string; path: string } | undefined {
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const hooks = entry["hooks"]
    if (!Array.isArray(hooks)) continue
    for (const hook of hooks) {
      if (!isRecord(hook)) continue
      const args = hook["args"]
      const first = Array.isArray(args) ? args[0] : undefined
      if (typeof first === "string" && basename(first) === script) {
        return { command: str(hook["command"]), path: first }
      }
    }
  }
  return undefined
}

function mcpEntry(config: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const mcp = config["mcpServers"]
  if (!isRecord(mcp)) return undefined
  const entry = mcp[key]
  if (entry === undefined) return undefined
  if (!isRecord(entry)) throw new Error(`mcpServers.${key} is not an object`)
  return entry
}

describe("install.mjs 幂等安装", () => {
  it("merges hooks + MCP entries while keeping user entries", () => {
    const cfg = join(tempDir(), "settings.json")
    seedSettings(cfg)

    const result = run(["--config", cfg])
    expect(result.status).toBe(0)
    const parsed = readConfig(cfg)
    expect(parsed["model"]).toBe("sonnet")

    const hooks = nested(parsed, "hooks")
    const session = arrayAt(hooks, "SessionStart")
    expect(session).toContainEqual(USER_SESSION_START)
    expect(hasOurEntry(session, "session-start.mjs")).toBe(true)
    expect(ourCommand(session, "session-start.mjs")).toEqual({
      command: "node",
      path: `${ADAPTER_POSIX}/session-start.mjs`,
    })
    const stop = arrayAt(hooks, "Stop")
    expect(stop).toContainEqual(USER_STOP)
    expect(hasOurEntry(stop, "idle.mjs")).toBe(true)
    for (const [event, script] of EVENTS) expect(hasOurEntry(arrayAt(hooks, event), script)).toBe(true)

    expect(mcpEntry(parsed, "other")).toEqual(OTHER_MCP)
    const agentchat = mcpEntry(parsed, "agentchat")
    if (agentchat === undefined) throw new Error("mcpServers.agentchat missing")
    expect(agentchat["type"]).toBe("http")
    expect(agentchat["url"]).toBe("http://127.0.0.1:4646/mcp")
    const headers = nested(agentchat, "headers")
    expect(headers["Authorization"]).toBe("Bearer ${HUB_TOKEN}")
    expect(str(headers["x-agent-id"])).toBe("${AGENTCHAT_AGENT_ID}")
    expect(existsSync(`${cfg}.bak`)).toBe(true)
  })

  it("is idempotent: installing twice is byte-identical with no duplicate hooks", () => {
    const cfg = join(tempDir(), "settings.json")
    seedSettings(cfg)
    expect(run(["--config", cfg]).status).toBe(0)
    const afterFirst = readFileSync(cfg, "utf8")

    expect(run(["--config", cfg]).status).toBe(0)
    expect(readFileSync(cfg, "utf8")).toBe(afterFirst)

    const hooks = nested(readConfig(cfg), "hooks")
    for (const [event] of EVENTS) expect(ourCount(arrayAt(hooks, event))).toBe(1)
  })

  it("--uninstall removes only this adapter's entries and clears emptied event keys", () => {
    const cfg = join(tempDir(), "settings.json")
    seedSettings(cfg)
    expect(run(["--config", cfg]).status).toBe(0)

    const installed = readConfig(cfg)
    arrayAt(nested(installed, "hooks"), "Stop").push({ hooks: [{ type: "command", command: "echo", args: ["keep-stop"] }] })
    nested(installed, "mcpServers")["keep"] = { type: "http", url: "https://keep.example/mcp" }
    writeFileSync(cfg, `${JSON.stringify(installed, null, 2)}\n`)

    expect(run(["--config", cfg, "--uninstall"]).status).toBe(0)
    const parsed = readConfig(cfg)
    const hooks = nested(parsed, "hooks")
    expect(arrayAt(hooks, "SessionStart")).toContainEqual(USER_SESSION_START)
    expect(hasOurEntry(arrayAt(hooks, "SessionStart"), "session-start.mjs")).toBe(false)
    expect(arrayAt(hooks, "Stop")).toContainEqual(USER_STOP)
    expect(arrayAt(hooks, "Stop")).toContainEqual({ hooks: [{ type: "command", command: "echo", args: ["keep-stop"] }] })
    expect(hasOurEntry(arrayAt(hooks, "Stop"), "idle.mjs")).toBe(false)
    expect(hooks["SubagentStart"]).toBeUndefined()
    expect(hooks["PreToolUse"]).toBeUndefined()
    expect(parsed["model"]).toBe("sonnet")

    expect(mcpEntry(parsed, "agentchat")).toBeUndefined()
    expect(mcpEntry(parsed, "other")).toEqual(OTHER_MCP)
    expect(mcpEntry(parsed, "keep")).toEqual({ type: "http", url: "https://keep.example/mcp" })
  })

  it("--dry-run prints both sections without writing or backing up", () => {
    const cfg = join(tempDir(), "settings.json")
    seedSettings(cfg)
    const before = readFileSync(cfg, "utf8")

    const result = run(["--config", cfg, "--dry-run"])
    expect(result.status).toBe(0)
    expect(readFileSync(cfg, "utf8")).toBe(before)
    expect(existsSync(`${cfg}.bak`)).toBe(false)
    const out = result.stdout ?? ""
    expect(out).toContain("session-start.mjs")
    expect(out).toContain("mcpServers")
    expect(out).toContain('"agentchat"')
    expect(out).toContain("${HUB_TOKEN}")
  })

  it("fails with a clear message and non-zero exit when the target is missing", () => {
    const dir = tempDir()

    const missingParent = run(["--config", join(dir, "nope", "settings.json")])
    expect(missingParent.status).not.toBe(0)
    expect(missingParent.stderr).toContain("父目录不存在")

    const missingFile = run(["--config", join(dir, "settings.json")])
    expect(missingFile.status).not.toBe(0)
    expect(missingFile.stderr).toContain("不存在")

    const defaultMissing = run([], { CLAUDE_CONFIG_DIR: tempDir() })
    expect(defaultMissing.status).not.toBe(0)
    expect(defaultMissing.stderr).toContain("--config")
  })
})
