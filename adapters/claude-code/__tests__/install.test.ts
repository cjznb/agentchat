/**
 * Task 5 单测（含 review 修正）：以真实子进程运行 `install.mjs`，验证
 * ① hooks 落 settings.json、MCP 落 MCP 配置（默认 ~/.claude.json，测试用 --mcp-config），用户条目完好；
 * ② 安装两次两文件均字节等价（幂等，hooks 数组不重复）；
 * ③ `--uninstall` 精确移除两处本适配器条目、空数组键清理、**用户自有同名脚本（不同路径）不受影响**；
 * ④ `--dry-run` 不落盘且打印两处目标；⑤ 缺父目录/文件/同一文件 → 清晰错误 + 非 0 退出码；
 * ⑥ `mcp-headers.mjs` 从环境/`<home>` 文件产出头（配置不含 token）；
 * ⑦ snippet 与安装器写入结构逐字节一致。
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const ADAPTER_DIR = join(TEST_DIR, "..")
const INSTALL = join(ADAPTER_DIR, "install.mjs")
const HEADERS = join(ADAPTER_DIR, "mcp-headers.mjs")
const ADAPTER_POSIX = ADAPTER_DIR.split(/[\\/]/).join("/")
const EVENTS: ReadonlyArray<readonly [string, string]> = [
  ["SessionStart", "session-start.mjs"],
  ["SubagentStart", "subagent-start.mjs"],
  ["SubagentStop", "subagent-stop.mjs"],
  ["PreToolUse", "busy.mjs"],
  ["PostToolUse", "busy.mjs"],
  ["Stop", "idle.mjs"],
  ["Notification", "idle.mjs"],
]
const FOREIGN_BUSY = { hooks: [{ type: "command", command: "node", args: ["/user/own/busy.mjs"] }] }
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
        hooks: { SessionStart: [USER_SESSION_START], PreToolUse: [FOREIGN_BUSY], Stop: [USER_STOP] },
      },
      null,
      2,
    )}\n`,
  )
}

function seedMcp(path: string): void {
  writeFileSync(path, `${JSON.stringify({ mcpServers: { other: OTHER_MCP }, topLevelState: "keep" }, null, 2)}\n`)
}

function run(args: readonly string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  // 显式清空可能泄漏的宿主变量（否则 hubUrl / 目标路径会与 snippet、断言不一致）；
  // AGENTCHAT_HOME 默认指向临时 home，隔离安装器写入的 `<home>/config.json`。
  return spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTCHAT_HOME: join(tempDir(), "home"),
      AGENTCHAT_URL: "",
      AGENTCHAT_PORT: "",
      CLAUDE_CONFIG_DIR: "",
      CLAUDE_SETTINGS: "",
      ...env,
    },
  })
}

// ── 配置读取（`unknown` 边界 + 守卫，无 any）─────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readConfig(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isRecord(value)) throw new Error("root is not an object")
  return value
}

function nested(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  if (!isRecord(value)) throw new Error(`${key} is not an object`)
  return value
}

function maybeArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${key} is not an array`)
  return value
}

function arrayAt(record: Record<string, unknown>, key: string): unknown[] {
  const value = maybeArray(record, key)
  if (value === undefined) throw new Error(`${key} is not an array`)
  return value
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Error("not a string")
  return value
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "")
}

function ourPath(script: string): string {
  return `${ADAPTER_POSIX}/${script}`
}

/** 某 hooks 条目引用的命令路径列表。 */
function entryPaths(entry: unknown): string[] {
  if (!isRecord(entry)) return []
  const hooks = entry["hooks"]
  if (!Array.isArray(hooks)) return []
  return hooks.flatMap((hook) => {
    if (!isRecord(hook)) return []
    const args = hook["args"]
    const first = Array.isArray(args) ? args[0] : undefined
    return typeof first === "string" ? [normalize(first)] : []
  })
}

function ourCount(entries: unknown[], script: string): number {
  return entries.filter((entry) => entryPaths(entry).includes(ourPath(script))).length
}

function hasOurEntry(entries: unknown[], script: string): boolean {
  return entries.some((entry) => entryPaths(entry).includes(ourPath(script)))
}

function ourCommand(entries: unknown[], script: string): { command: string; path: string } | undefined {
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const hooks = entry["hooks"]
    if (!Array.isArray(hooks)) continue
    for (const hook of hooks) {
      if (!isRecord(hook)) continue
      const args = hook["args"]
      const first = Array.isArray(args) ? args[0] : undefined
      if (typeof first === "string" && normalize(first) === ourPath(script)) {
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

function installPair(): { settings: string; mcp: string } {
  const dir = tempDir()
  const settings = join(dir, "settings.json")
  const mcp = join(dir, "claude.json")
  seedSettings(settings)
  seedMcp(mcp)
  expect(run(["--config", settings, "--mcp-config", mcp]).status).toBe(0)
  return { settings, mcp }
}

describe("install.mjs 幂等安装（hooks→settings，MCP→独立文件）", () => {
  it("merges hooks into settings and MCP into the MCP file, keeping user entries", () => {
    const dir = tempDir()
    const cfg = join(dir, "settings.json")
    const mcpFile = join(dir, "claude.json")
    seedSettings(cfg)
    seedMcp(mcpFile)

    expect(run(["--config", cfg, "--mcp-config", mcpFile]).status).toBe(0)

    const settings = readConfig(cfg)
    expect(settings["model"]).toBe("sonnet")
    expect(settings["mcpServers"]).toBeUndefined() // MCP 不得写进 settings.json
    const hooks = nested(settings, "hooks")
    expect(arrayAt(hooks, "SessionStart")).toContainEqual(USER_SESSION_START)
    expect(arrayAt(hooks, "Stop")).toContainEqual(USER_STOP)
    expect(arrayAt(hooks, "PreToolUse")).toContainEqual(FOREIGN_BUSY) // 用户自有 busy.mjs 保留
    for (const [event, script] of EVENTS) expect(hasOurEntry(arrayAt(hooks, event), script)).toBe(true)
    expect(ourCommand(arrayAt(hooks, "SessionStart"), "session-start.mjs")).toEqual({
      command: "node",
      path: `${ADAPTER_POSIX}/session-start.mjs`,
    })

    const mcp = readConfig(mcpFile)
    expect(mcp["topLevelState"]).toBe("keep")
    expect(mcpEntry(mcp, "other")).toEqual(OTHER_MCP)
    const agentchat = mcpEntry(mcp, "agentchat")
    if (agentchat === undefined) throw new Error("mcpServers.agentchat missing")
    expect(agentchat["type"]).toBe("http")
    expect(agentchat["url"]).toBe("http://127.0.0.1:4646/mcp")
    const helper = str(agentchat["headersHelper"])
    expect(helper).toContain(`${ADAPTER_POSIX}/mcp-headers.mjs`)
    expect(JSON.stringify(agentchat)).not.toContain("Bearer") // 配置里不得出现 token
    expect(existsSync(`${cfg}.bak`)).toBe(true)
    expect(existsSync(`${mcpFile}.bak`)).toBe(true)
  })

  it("is idempotent: two installs are byte-identical in both files, no duplicate hooks", () => {
    const dir = tempDir()
    const cfg = join(dir, "settings.json")
    const mcpFile = join(dir, "claude.json")
    seedSettings(cfg)
    seedMcp(mcpFile)

    expect(run(["--config", cfg, "--mcp-config", mcpFile]).status).toBe(0)
    const settingsAfter = readFileSync(cfg, "utf8")
    const mcpAfter = readFileSync(mcpFile, "utf8")

    expect(run(["--config", cfg, "--mcp-config", mcpFile]).status).toBe(0)
    expect(readFileSync(cfg, "utf8")).toBe(settingsAfter)
    expect(readFileSync(mcpFile, "utf8")).toBe(mcpAfter)

    const hooks = nested(readConfig(cfg), "hooks")
    for (const [event, script] of EVENTS) expect(ourCount(arrayAt(hooks, event), script)).toBe(1)
  })

  it("--uninstall removes only this adapter's entries from both files, leaving user keys/scripts", () => {
    const { settings: cfg, mcp: mcpFile } = installPair()

    const installedSettings = readConfig(cfg)
    arrayAt(nested(installedSettings, "hooks"), "Stop").push({ hooks: [{ type: "command", command: "echo", args: ["keep-stop"] }] })
    writeFileSync(cfg, `${JSON.stringify(installedSettings, null, 2)}\n`)
    const installedMcp = readConfig(mcpFile)
    nested(installedMcp, "mcpServers")["keep"] = { type: "http", url: "https://keep.example/mcp" }
    writeFileSync(mcpFile, `${JSON.stringify(installedMcp, null, 2)}\n`)

    expect(run(["--config", cfg, "--mcp-config", mcpFile, "--uninstall"]).status).toBe(0)

    const settings = readConfig(cfg)
    expect(settings["model"]).toBe("sonnet")
    const hooks = nested(settings, "hooks")
    expect(arrayAt(hooks, "SessionStart")).toContainEqual(USER_SESSION_START)
    expect(hasOurEntry(arrayAt(hooks, "SessionStart"), "session-start.mjs")).toBe(false)
    expect(arrayAt(hooks, "PreToolUse")).toContainEqual(FOREIGN_BUSY) // 用户同名脚本仍在
    expect(hasOurEntry(arrayAt(hooks, "PreToolUse"), "busy.mjs")).toBe(false)
    expect(arrayAt(hooks, "Stop")).toContainEqual(USER_STOP)
    expect(arrayAt(hooks, "Stop")).toContainEqual({ hooks: [{ type: "command", command: "echo", args: ["keep-stop"] }] })
    expect(hooks["SubagentStart"]).toBeUndefined() // 空数组键被清理
    expect(hooks["PostToolUse"]).toBeUndefined()
    expect(hooks["Notification"]).toBeUndefined()

    const mcp = readConfig(mcpFile)
    expect(mcp["topLevelState"]).toBe("keep")
    expect(mcpEntry(mcp, "agentchat")).toBeUndefined()
    expect(mcpEntry(mcp, "other")).toEqual(OTHER_MCP)
    expect(mcpEntry(mcp, "keep")).toEqual({ type: "http", url: "https://keep.example/mcp" })
  })

  it("--dry-run prints both targets without writing or backing up", () => {
    const dir = tempDir()
    const cfg = join(dir, "settings.json")
    const mcpFile = join(dir, "claude.json")
    seedSettings(cfg)
    seedMcp(mcpFile)
    const settingsBefore = readFileSync(cfg, "utf8")
    const mcpBefore = readFileSync(mcpFile, "utf8")

    const result = run(["--config", cfg, "--mcp-config", mcpFile, "--dry-run"])
    expect(result.status).toBe(0)
    expect(readFileSync(cfg, "utf8")).toBe(settingsBefore)
    expect(readFileSync(mcpFile, "utf8")).toBe(mcpBefore)
    expect(existsSync(`${cfg}.bak`)).toBe(false)
    expect(existsSync(`${mcpFile}.bak`)).toBe(false)
    const out = result.stdout ?? ""
    expect(out).toContain(`# hooks → ${cfg}`)
    expect(out).toContain(`# MCP → ${mcpFile}`)
    expect(out).toContain("session-start.mjs")
    expect(out).toContain('"agentchat"')
    expect(out).toContain("headersHelper")
  })

  it("honors CLAUDE_CONFIG_DIR for both targets, with --mcp-config taking precedence", () => {
    const dir = tempDir()
    seedSettings(join(dir, "settings.json"))

    const dry = run(["--dry-run"], { CLAUDE_CONFIG_DIR: dir })
    expect(dry.status).toBe(0)
    expect(dry.stdout ?? "").toContain(`# hooks → ${join(dir, "settings.json")}`)
    expect(dry.stdout ?? "").toContain(`# MCP → ${join(dir, ".claude.json")}`)

    expect(run([], { CLAUDE_CONFIG_DIR: dir }).status).toBe(0)
    const settings = readConfig(join(dir, "settings.json"))
    expect(hasOurEntry(arrayAt(nested(settings, "hooks"), "SessionStart"), "session-start.mjs")).toBe(true)
    expect(mcpEntry(readConfig(join(dir, ".claude.json")), "agentchat")).toBeDefined()

    const explicit = join(tempDir(), "project.mcp.json")
    writeFileSync(explicit, "{}\n")
    expect(run(["--mcp-config", explicit], { CLAUDE_CONFIG_DIR: dir }).status).toBe(0)
    expect(mcpEntry(readConfig(explicit), "agentchat")).toBeDefined()
  })

  it("fails with a clear message and non-zero exit on missing paths or a same-file target", () => {
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

    const cfg = join(dir, "settings.json")
    seedSettings(cfg)
    const same = run(["--config", cfg, "--mcp-config", cfg])
    expect(same.status).not.toBe(0)
    expect(same.stderr).toContain("同一文件")
  })
})

// ── 缺陷 #5：MCP 条目所有权守卫；缺陷 #6：同一文件规范化 ──────────────

describe("MCP 条目所有权守卫与同一文件规范化", () => {
  const FOREIGN_AGENTCHAT = { type: "http", url: "https://user.example/mcp" }

  it("refuses to overwrite a structurally different user-owned mcpServers.agentchat unless --force", () => {
    const dir = tempDir()
    const cfg = join(dir, "settings.json")
    const mcpFile = join(dir, "claude.json")
    seedSettings(cfg)
    writeFileSync(mcpFile, `${JSON.stringify({ mcpServers: { agentchat: FOREIGN_AGENTCHAT } }, null, 2)}\n`)

    const refused = run(["--config", cfg, "--mcp-config", mcpFile])
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain("结构不同")
    expect(mcpEntry(readConfig(mcpFile), "agentchat")).toEqual(FOREIGN_AGENTCHAT)

    const forced = run(["--config", cfg, "--mcp-config", mcpFile, "--force"])
    expect(forced.status).toBe(0)
    const entry = mcpEntry(readConfig(mcpFile), "agentchat")
    if (entry === undefined) throw new Error("agentchat missing after --force")
    expect(entry["type"]).toBe("http")
    expect(entry["headersHelper"]).toBeDefined()
  })

  it("does not delete a structurally different user-owned mcpServers.agentchat on --uninstall", () => {
    const dir = tempDir()
    const cfg = join(dir, "settings.json")
    const mcpFile = join(dir, "claude.json")
    seedSettings(cfg)
    writeFileSync(
      mcpFile,
      `${JSON.stringify({ mcpServers: { agentchat: FOREIGN_AGENTCHAT, other: OTHER_MCP } }, null, 2)}\n`,
    )

    const result = run(["--config", cfg, "--mcp-config", mcpFile, "--uninstall"])
    expect(result.status).toBe(0)
    expect(mcpEntry(readConfig(mcpFile), "agentchat")).toEqual(FOREIGN_AGENTCHAT)
    expect(mcpEntry(readConfig(mcpFile), "other")).toEqual(OTHER_MCP)
    expect(result.stderr).toContain("已保留")
  })

  it("rejects the same file expressed via a non-canonical alias or case variant", () => {
    const dir = tempDir()
    const cfg = join(dir, "settings.json")
    seedSettings(cfg)

    // 点段别名解析到同一真实文件（跨平台）。
    const alias = `${dir}${sep}.${sep}settings.json`
    const dot = run(["--config", cfg, "--mcp-config", alias])
    expect(dot.status).not.toBe(0)
    expect(dot.stderr).toContain("同一文件")

    // 大小写变体：注入 win32 判定，使大小写折叠语义跨平台确定（旧实现会误判为不同文件）。
    const upper = join(dir, "SETTINGS.JSON")
    const cased = run(["--config", cfg, "--mcp-config", upper], { AGENTCHAT_INSTALLER_PLATFORM: "win32" })
    expect(cased.status).not.toBe(0)
    expect(cased.stderr).toContain("同一文件")
  })
})

// ── Important #3：headersHelper 脚本产出头（配置不含 token）──────────
function envWithout(keys: readonly string[], extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || keys.includes(k)) continue
    env[k] = v
  }
  return { ...env, ...extra }
}

function runHeaders(env: Record<string, string>): Record<string, unknown> {
  const result = spawnSync(process.execPath, [HEADERS], { encoding: "utf8", env })
  expect(result.status).toBe(0)
  const parsed: unknown = JSON.parse(result.stdout ?? "")
  if (!isRecord(parsed)) throw new Error("headers output is not an object")
  return parsed
}

describe("mcp-headers.mjs", () => {
  it("reads token + agent id from <home> files when env is absent", () => {
    const home = tempDir()
    mkdirSync(join(home, "agents"), { recursive: true })
    writeFileSync(join(home, "hub_token"), "tok-123\n")
    writeFileSync(join(home, "agents", "claude-code.id"), "agent-9\n")

    const headers = runHeaders(envWithout(["HUB_TOKEN", "AGENTCHAT_AGENT_ID"], { AGENTCHAT_HOME: home }))
    expect(headers["Authorization"]).toBe("Bearer tok-123")
    expect(headers["x-agent-id"]).toBe("agent-9")
  })

  it("prefers environment variables and omits absent headers instead of emitting empties", () => {
    const overridden = runHeaders(
      envWithout([], { AGENTCHAT_HOME: tempDir(), HUB_TOKEN: "envtok", AGENTCHAT_AGENT_ID: "envid" }),
    )
    expect(overridden).toEqual({ Authorization: "Bearer envtok", "x-agent-id": "envid" })

    const empty = runHeaders(envWithout(["HUB_TOKEN", "AGENTCHAT_AGENT_ID"], { AGENTCHAT_HOME: tempDir() }))
    expect(empty).toEqual({})
  })
})

// ── snippet 与安装器写入结构一致 ────────────────────────────────────

describe("snippet 一致性", () => {
  it("settings/mcp snippets match the installer output byte-for-byte", () => {
    const dir = tempDir()
    const cfg = join(dir, "settings.json")
    const mcpFile = join(dir, "claude.json")
    writeFileSync(cfg, "{}\n")
    writeFileSync(mcpFile, "{}\n")
    expect(run(["--config", cfg, "--mcp-config", mcpFile]).status).toBe(0)

    function replaceSnippet(snippet: Record<string, unknown>): Record<string, unknown> {
      const value: unknown = JSON.parse(
        JSON.stringify(snippet).split("__AGENTCHAT_ADAPTER_DIR__").join(ADAPTER_POSIX),
      )
      if (!isRecord(value)) throw new Error("snippet is not an object")
      return value
    }

    const settingsSnippet = replaceSnippet(readConfig(join(ADAPTER_DIR, "settings.snippet.json")))
    const mcpSnippet = replaceSnippet(readConfig(join(ADAPTER_DIR, "mcp.snippet.json")))
    expect(JSON.stringify(readConfig(cfg)["hooks"])).toBe(JSON.stringify(settingsSnippet["hooks"]))
    expect(JSON.stringify(mcpEntry(readConfig(mcpFile), "agentchat"))).toBe(
      JSON.stringify(mcpEntry(mcpSnippet, "agentchat")),
    )
  })
})

// ── Hub config.json 登记（免手动设 AGENTCHAT_ADAPTERS）──────────────

describe("Hub config.json 登记", () => {
  function agentchatConfig(home: string): Record<string, unknown> {
    return readConfig(join(home, "config.json"))
  }

  it("writes the vendor into adapters, preserving other keys, and is idempotent", () => {
    const dir = tempDir()
    const cfg = join(dir, "settings.json")
    const mcpFile = join(dir, "claude.json")
    seedSettings(cfg)
    seedMcp(mcpFile)
    const home = join(tempDir(), "home")
    mkdirSync(home, { recursive: true })
    writeFileSync(
      join(home, "config.json"),
      `${JSON.stringify({ port: 5555, adapters: ["opencode"] }, null, 2)}\n`,
    )

    expect(run(["--config", cfg, "--mcp-config", mcpFile], { AGENTCHAT_HOME: home }).status).toBe(0)
    const first = readFileSync(join(home, "config.json"), "utf8")
    const parsed = agentchatConfig(home)
    expect(parsed["adapters"]).toEqual(["opencode", "claude-code"])
    expect(parsed["port"]).toBe(5555)

    expect(run(["--config", cfg, "--mcp-config", mcpFile], { AGENTCHAT_HOME: home }).status).toBe(0)
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(first) // 幂等
  })

  it("--uninstall removes only this vendor, keeping the file and other keys", () => {
    const dir = tempDir()
    const cfg = join(dir, "settings.json")
    const mcpFile = join(dir, "claude.json")
    seedSettings(cfg)
    seedMcp(mcpFile)
    const home = join(tempDir(), "home")
    mkdirSync(home, { recursive: true })
    writeFileSync(
      join(home, "config.json"),
      `${JSON.stringify({ port: 5555, adapters: ["opencode", "claude-code"] }, null, 2)}\n`,
    )

    expect(run(["--config", cfg, "--mcp-config", mcpFile, "--uninstall"], { AGENTCHAT_HOME: home }).status).toBe(0)
    const parsed = agentchatConfig(home)
    expect(parsed["adapters"]).toEqual(["opencode"])
    expect(parsed["port"]).toBe(5555)
    expect(existsSync(join(home, "config.json"))).toBe(true)
  })

  it("--dry-run prints the config target without writing it", () => {
    const dir = tempDir()
    const cfg = join(dir, "settings.json")
    const mcpFile = join(dir, "claude.json")
    seedSettings(cfg)
    seedMcp(mcpFile)
    const home = join(tempDir(), "home")

    const result = run(["--config", cfg, "--mcp-config", mcpFile, "--dry-run"], { AGENTCHAT_HOME: home })
    expect(result.status).toBe(0)
    expect(result.stdout ?? "").toContain("Hub 适配器")
    expect(result.stdout ?? "").toContain("claude-code")
    expect(existsSync(join(home, "config.json"))).toBe(false)
    expect(existsSync(`${cfg}.bak`)).toBe(false)
  })
})
