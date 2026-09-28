/**
 * Task 3 单测：以真实子进程运行 `install.mjs`，在临时配置目录上验证
 * ① 安装两次内容等价（幂等）、② `--dry-run` 不落盘且打印两个条目、
 * ③ `--uninstall` 精确移除且用户其它键完好、④ 缺父目录/文件不存在 → 清晰错误且退出码非 0、
 * ⑤ JSONC（含注释与尾逗号）可就地合并。
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { isRecord } from "../util"

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const ADAPTER_DIR = join(TEST_DIR, "..")
const INSTALL = join(ADAPTER_DIR, "install.mjs")
const EXPECTED_PLUGIN = ADAPTER_DIR.split(/[\\/]/).join("/")
const EXPECTED_BRIDGE = `${EXPECTED_PLUGIN}/mcp-bridge.mjs`
const OTHER_MCP = { type: "remote", url: "https://example.com/mcp", enabled: true }

/** 旧（会砖）结构：remote + `{file:…opencode.id}` 身份头 —— 本适配器早期版本写的产物。 */
const LEGACY_ENTRY = {
  type: "remote",
  url: "http://127.0.0.1:4646/mcp",
  enabled: true,
  headers: {
    Authorization: "Bearer {env:HUB_TOKEN}",
    "x-agent-id": "{file:~/.agentchat/agents/opencode.id}",
  },
}

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-install-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seedConfig(path: string): void {
  writeFileSync(
    path,
    `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "x/y",
      plugin: ["other-plugin"],
      mcp: { other: OTHER_MCP },
    }, null, 2)}\n`,
  )
}

function run(args: readonly string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: "utf8",
    env: { ...process.env, AGENTCHAT_HOME: join(tempDir(), "home"), ...env },
  })
}

// ── 配置读取（`unknown` 边界 + 守卫，无 any）─────────────────────────

function readConfig(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!isRecord(value)) throw new Error("config root is not an object")
  return value
}

function pluginList(config: Record<string, unknown>): unknown[] {
  const value = config["plugin"]
  if (!Array.isArray(value)) throw new Error("plugin is not an array")
  return value
}

function mcpEntry(config: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const mcp = config["mcp"]
  if (!isRecord(mcp)) throw new Error("mcp is not an object")
  const entry = mcp[key]
  if (entry === undefined) return undefined
  if (!isRecord(entry)) throw new Error(`mcp.${key} is not an object`)
  return entry
}

function nested(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  if (!isRecord(value)) throw new Error(`${key} is not an object`)
  return value
}

describe("install.mjs 幂等安装", () => {
  it("installs the plugin + MCP entries and is idempotent", () => {
    const cfg = join(tempDir(), "opencode.json")
    seedConfig(cfg)
    const home = join(tempDir(), "home")

    const first = run(["--config", cfg], { AGENTCHAT_HOME: home })
    expect(first.status).toBe(0)
    const afterFirst = readFileSync(cfg, "utf8")

    const second = run(["--config", cfg], { AGENTCHAT_HOME: home })
    expect(second.status).toBe(0)
    expect(readFileSync(cfg, "utf8")).toBe(afterFirst)

    const parsed = readConfig(cfg)
    expect(pluginList(parsed)).toContain("other-plugin")
    expect(pluginList(parsed)).toContain(EXPECTED_PLUGIN)
    expect(parsed["model"]).toBe("x/y")
    expect(mcpEntry(parsed, "other")).toEqual(OTHER_MCP)

    const agentchat = mcpEntry(parsed, "agentchat")
    if (agentchat === undefined) throw new Error("mcp.agentchat missing")
    expect(agentchat["type"]).toBe("local")
    expect(agentchat["enabled"]).toBe(true)
    expect(agentchat["command"]).toEqual([process.execPath, EXPECTED_BRIDGE])
    // 配置里禁止任何 {file:} 引用与机密：否则 OpenCode 解析配置时会因生成文件缺失而致命。
    const written = readFileSync(cfg, "utf8")
    expect(written).not.toContain("{file:")
    expect(written).not.toContain("Bearer")
    expect(written).not.toContain("hub_token")
    expect(existsSync(`${cfg}.bak`)).toBe(true)
  })

  it("--dry-run prints both entries without writing or backing up", () => {
    const cfg = join(tempDir(), "opencode.json")
    seedConfig(cfg)
    const before = readFileSync(cfg, "utf8")

    const result = run(["--config", cfg, "--dry-run"])
    expect(result.status).toBe(0)
    expect(readFileSync(cfg, "utf8")).toBe(before)
    expect(existsSync(`${cfg}.bak`)).toBe(false)
    const out = result.stdout ?? ""
    expect(out).toContain(EXPECTED_PLUGIN)
    expect(out).toContain(EXPECTED_BRIDGE)
    expect(out).toContain('"agentchat"')
    expect(out).toContain('"local"')
  })

  it("--uninstall removes only this adapter's entries", () => {
    const cfg = join(tempDir(), "opencode.json")
    seedConfig(cfg)
    const home = join(tempDir(), "home")
    expect(run(["--config", cfg], { AGENTCHAT_HOME: home }).status).toBe(0)

    const installed = readConfig(cfg)
    pluginList(installed).push("keep-me")
    const mcp = nested(installed, "mcp")
    mcp["keep"] = { type: "remote", url: "https://keep.example/mcp" }
    writeFileSync(cfg, `${JSON.stringify(installed, null, 2)}\n`)

    const result = run(["--config", cfg, "--uninstall"], { AGENTCHAT_HOME: home })
    expect(result.status).toBe(0)
    const parsed = readConfig(cfg)
    expect(pluginList(parsed)).not.toContain(EXPECTED_PLUGIN)
    expect(pluginList(parsed)).toContain("other-plugin")
    expect(pluginList(parsed)).toContain("keep-me")
    expect(mcpEntry(parsed, "agentchat")).toBeUndefined()
    expect(mcpEntry(parsed, "other")).toEqual(OTHER_MCP)
    expect(mcpEntry(parsed, "keep")).toEqual({ type: "remote", url: "https://keep.example/mcp" })
  })

  it("refuses to overwrite a structurally different user-owned mcp.agentchat unless --force", () => {
    const cfg = join(tempDir(), "opencode.json")
    const home = join(tempDir(), "home")
    const foreign = { type: "remote", url: "https://user.example/mcp", enabled: true }
    writeFileSync(cfg, `${JSON.stringify({ mcp: { agentchat: foreign } }, null, 2)}\n`)

    const refused = run(["--config", cfg], { AGENTCHAT_HOME: home })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain("结构不同")
    expect(mcpEntry(readConfig(cfg), "agentchat")).toEqual(foreign) // 未被改动

    const forced = run(["--config", cfg, "--force"], { AGENTCHAT_HOME: home })
    expect(forced.status).toBe(0)
    const entry = mcpEntry(readConfig(cfg), "agentchat")
    if (entry === undefined) throw new Error("mcp.agentchat missing after --force")
    expect(entry["type"]).toBe("local")
    expect(entry["command"]).toEqual([process.execPath, EXPECTED_BRIDGE])
  })

  it("does not delete a structurally different user-owned mcp.agentchat on --uninstall", () => {
    const cfg = join(tempDir(), "opencode.json")
    const home = join(tempDir(), "home")
    const foreign = { type: "remote", url: "https://user.example/mcp" }
    writeFileSync(cfg, `${JSON.stringify({ mcp: { agentchat: foreign, other: OTHER_MCP } }, null, 2)}\n`)

    const result = run(["--config", cfg, "--uninstall"], { AGENTCHAT_HOME: home })
    expect(result.status).toBe(0)
    expect(mcpEntry(readConfig(cfg), "agentchat")).toEqual(foreign) // 保留用户自有条目
    expect(result.stderr).toContain("已保留")
  })

  it("fails with a clear message and non-zero exit when the path is missing", () => {
    const dir = tempDir()

    const missingParent = run(["--config", join(dir, "nope", "opencode.json")])
    expect(missingParent.status).not.toBe(0)
    expect(missingParent.stderr).toContain("父目录不存在")

    const missingFile = run(["--config", join(dir, "opencode.json")])
    expect(missingFile.status).not.toBe(0)
    expect(missingFile.stderr).toContain("配置文件不存在")
  })

  it("parses a JSONC config with comments and trailing commas", () => {
    const cfg = join(tempDir(), "opencode.jsonc")
    writeFileSync(
      cfg,
      '{\n  // user comment\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": ["a", "b",],\n}\n',
    )

    const result = run(["--config", cfg])
    expect(result.status).toBe(0)
    expect(pluginList(readConfig(cfg))).toEqual(["a", "b", EXPECTED_PLUGIN])
  })

  it("migrates the legacy {file:} structure without --force and says so", () => {
    const cfg = join(tempDir(), "opencode.json")
    const home = join(tempDir(), "home")
    writeFileSync(
      cfg,
      `${JSON.stringify({ plugin: ["other-plugin"], mcp: { agentchat: LEGACY_ENTRY, other: OTHER_MCP } }, null, 2)}\n`,
    )

    const result = run(["--config", cfg], { AGENTCHAT_HOME: home })
    expect(result.status).toBe(0)
    expect(result.stdout ?? "").toContain("迁移")

    const parsed = readConfig(cfg)
    const agentchat = mcpEntry(parsed, "agentchat")
    if (agentchat === undefined) throw new Error("mcp.agentchat missing after migration")
    expect(agentchat["type"]).toBe("local")
    expect(agentchat["command"]).toEqual([process.execPath, EXPECTED_BRIDGE])
    expect(mcpEntry(parsed, "other")).toEqual(OTHER_MCP)
    expect(pluginList(parsed)).toContain("other-plugin")
    expect(existsSync(`${cfg}.bak`)).toBe(true)
  })

  it("--uninstall removes the legacy {file:} structure", () => {
    const cfg = join(tempDir(), "opencode.json")
    const home = join(tempDir(), "home")
    writeFileSync(
      cfg,
      `${JSON.stringify({ plugin: ["other-plugin"], mcp: { agentchat: LEGACY_ENTRY, other: OTHER_MCP } }, null, 2)}\n`,
    )

    const result = run(["--config", cfg, "--uninstall"], { AGENTCHAT_HOME: home })
    expect(result.status).toBe(0)
    const parsed = readConfig(cfg)
    expect(mcpEntry(parsed, "agentchat")).toBeUndefined()
    expect(mcpEntry(parsed, "other")).toEqual(OTHER_MCP)
    expect(pluginList(parsed)).toContain("other-plugin")
  })

  it("writes only non-secret agentchat overrides into the MCP environment", () => {
    const cfg = join(tempDir(), "opencode.json")
    const home = join(tempDir(), "home")
    seedConfig(cfg)

    const result = run(["--config", cfg], {
      AGENTCHAT_HOME: home,
      AGENTCHAT_URL: "http://127.0.0.1:9999",
    })
    expect(result.status).toBe(0)
    const agentchat = mcpEntry(readConfig(cfg), "agentchat")
    if (agentchat === undefined) throw new Error("mcp.agentchat missing")
    expect(nested(agentchat, "environment")).toEqual({
      AGENTCHAT_HOME: home,
      AGENTCHAT_URL: "http://127.0.0.1:9999",
    })
    expect(readFileSync(cfg, "utf8")).not.toContain("HUB_TOKEN")
  })

  it("omits the environment block entirely when no agentchat override is set", () => {
    const cfg = join(tempDir(), "opencode.json")
    seedConfig(cfg)

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("AGENTCHAT_") && key !== "HUB_TOKEN") env[key] = value
    }
    const result = spawnSync(process.execPath, [INSTALL, "--config", cfg], { encoding: "utf8", env })
    expect(result.status).toBe(0)
    const agentchat = mcpEntry(readConfig(cfg), "agentchat")
    if (agentchat === undefined) throw new Error("mcp.agentchat missing")
    expect(agentchat["environment"]).toBeUndefined()
    expect(agentchat["command"]).toEqual([process.execPath, EXPECTED_BRIDGE])
  })
})
