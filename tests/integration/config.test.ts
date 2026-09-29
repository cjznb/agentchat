/**
 * 本地配置文件测试（`<home>/config.json`）：
 * - 文件缺失 → 用默认、不报错；Hub **只读**（不创建文件）
 * - 文件键（adapters/port/openBrowser）→ 类型化解析
 * - 优先级：env > 文件 > 默认（adapters/port 各测一条）
 * - openBrowser env：`AGENTCHAT_NO_OPEN`（1/true→关）/`AGENTCHAT_OPEN`（1/true→开、0/false→关）
 * - 非法 JSON / 键类型错 → 一条清晰 warn + 用默认，绝不崩
 * - `AGENTCHAT_HOME` 空串视同未设 → 默认 `~/.agentchat`
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_OPEN_BROWSER, DEFAULT_PORT, loadConfig } from "../../server/config"

const dirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentchat-config-"))
  dirs.push(dir)
  return dir
}

function writeConfig(home: string, value: unknown): void {
  writeFileSync(join(home, "config.json"), `${JSON.stringify(value, null, 2)}\n`)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("config.json 解析与优先级", () => {
  it("uses defaults and never creates the file when it is missing", () => {
    const home = tempHome()
    const warnings: string[] = []
    const config = loadConfig({ AGENTCHAT_HOME: home }, (m) => void warnings.push(m))

    expect(config.home).toBe(home)
    expect(config.configPath).toBe(join(home, "config.json"))
    expect(config.dbPath).toBe(join(home, "agentchat.db"))
    expect(config.hubTokenPath).toBe(join(home, "hub_token"))
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.adapters).toEqual([])
    expect(config.openBrowser).toBe(DEFAULT_OPEN_BROWSER)
    expect(warnings).toEqual([])
    expect(existsSync(join(home, "config.json"))).toBe(false) // 只读：绝不创建
  })

  it("reads adapters / port / openBrowser from the file", () => {
    const home = tempHome()
    writeConfig(home, { adapters: ["claude-code"], port: 5555, openBrowser: false })
    const config = loadConfig({ AGENTCHAT_HOME: home })
    expect(config.adapters).toEqual(["claude-code"])
    expect(config.port).toBe(5555)
    expect(config.openBrowser).toBe(false)
  })

  it("lets env override the file (env > file > default)", () => {
    const home = tempHome()
    writeConfig(home, { adapters: ["from-file"], port: 1111, openBrowser: false })
    const config = loadConfig({
      AGENTCHAT_HOME: home,
      AGENTCHAT_ADAPTERS: " from-env , ",
      AGENTCHAT_PORT: "2222",
    })
    expect(config.adapters).toEqual(["from-env"])
    expect(config.port).toBe(2222)
  })

  it("applies openBrowser env flags with AGENTCHAT_NO_OPEN winning", () => {
    const home = tempHome()
    writeConfig(home, { openBrowser: true })
    expect(loadConfig({ AGENTCHAT_HOME: home, AGENTCHAT_NO_OPEN: "1" }).openBrowser).toBe(false)
    expect(loadConfig({ AGENTCHAT_HOME: home, AGENTCHAT_NO_OPEN: "true" }).openBrowser).toBe(false)
    // AGENTCHAT_OPEN 覆盖文件
    writeConfig(home, { openBrowser: false })
    expect(loadConfig({ AGENTCHAT_HOME: home, AGENTCHAT_OPEN: "1" }).openBrowser).toBe(true)
    expect(loadConfig({ AGENTCHAT_HOME: home, AGENTCHAT_OPEN: "0" }).openBrowser).toBe(false)
  })

  it("warns once and falls back to defaults on invalid JSON", () => {
    const home = tempHome()
    writeFileSync(join(home, "config.json"), "{ not json,, }\n")
    const warnings: string[] = []
    const config = loadConfig({ AGENTCHAT_HOME: home }, (m) => void warnings.push(m))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("config.json")
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.adapters).toEqual([])
    expect(config.openBrowser).toBe(DEFAULT_OPEN_BROWSER)
  })

  it("warns once and falls back to defaults on wrong key types", () => {
    const home = tempHome()
    writeConfig(home, { adapters: "opencode", port: "not-a-number" })
    const warnings: string[] = []
    const config = loadConfig({ AGENTCHAT_HOME: home }, (m) => void warnings.push(m))
    expect(warnings).toHaveLength(1)
    expect(config.adapters).toEqual([])
    expect(config.port).toBe(DEFAULT_PORT)
  })

  it("treats a blank AGENTCHAT_HOME as unset and uses the default home", () => {
    const config = loadConfig({ AGENTCHAT_HOME: "" })
    expect(config.home).toBe(join(homedir(), ".agentchat"))
  })
})
