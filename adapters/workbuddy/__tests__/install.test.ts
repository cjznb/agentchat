/**
 * 安装器的不变量（真子进程 + 一次性临时目录）：
 * ① `--dry-run` 只打印、不落盘；
 * ② 幂等：二次安装后所有文件**字节等价**；
 * ③ `--uninstall` 在用户没改过时**字节级还原**（含"本安装器创建的文件被删掉，不留空壳"）；
 * ④ 用户改过 → 精确移除本适配器的键 + **告警**（绝不静默损毁用户改动）；
 * ⑤ 未知参数 / 缺插件源 / 目标已存在（未 `--force`）→ 明确错误 + 非 0 退出码。
 *
 * 注：这里用异步 `spawn`（见 `harness.runProcess`）——本机 Windows 上 `spawnSync` 会对
 * `node.exe` 抛 `EBUSY`，会导致整批用例假失败。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installerPaths, MARKETPLACE_NAME, PLUGIN_NAME, pluginKey } from "../install-plan.mjs"
import { runProcess } from "./harness"

/**
 * 本文件只放宽**自己的**等待上限，不动仓库共享的 `vitest.config.ts`。
 *
 * 每个用例都要冷启动若干次 `node install.mjs`；在**整仓并行**运行时（本机 83 个测试文件同时
 * 起 worker，node 冷启动从 ~1.2s 涨到十几秒），单用例 2–4 次 spawn 会越过默认 30s / `afterEach`
 * 默认 10s。注意这只放宽"等到什么时候算失败"，**不放宽任何断言**；真正的挂起仍会失败。
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 })

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), "..", "install.mjs")
const dirs: string[] = []

function tempDir(prefix = "agentchat-wb-install-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // Windows 上刚被 node 子进程碰过的目录可能短暂被锁（AV 扫描/句柄回收）：
    // `maxRetries` 让删除自愈；真删不掉也不该让**已经断言通过**的用例变成失败。
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      /* 临时目录残留由系统清理，不影响本套用例的结论 */
    }
  }
})

/** 造一个最小可用的插件源目录（避免把整个适配器（含测试）复制进临时目录）。 */
function pluginSource(): string {
  const dir = tempDir("agentchat-wb-plugin-")
  mkdirSync(join(dir, ".codebuddy-plugin"), { recursive: true })
  mkdirSync(join(dir, "hooks"), { recursive: true })
  writeFileSync(
    join(dir, ".codebuddy-plugin", "plugin.json"),
    `${JSON.stringify({ name: PLUGIN_NAME, version: "0.1.0" }, null, 2)}\n`,
  )
  writeFileSync(join(dir, "hooks", "hooks.json"), "{}\n")
  return dir
}

interface RunResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly wbHome: string
  readonly home: string
}

async function run(args: readonly string[], options: { wbHome?: string; home?: string } = {}): Promise<RunResult> {
  const wbHome = options.wbHome ?? tempDir("agentchat-wb-home-")
  const home = options.home ?? tempDir("agentchat-home-")
  const result = await runProcess([INSTALL, ...args, "--workbuddy-home", wbHome, "--agentchat-home", home], {
    AGENTCHAT_HOME: home,
  })
  return { ...result, wbHome, home }
}

function readJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object")
  return value as Record<string, unknown>
}

function settingsSeed(): Record<string, unknown> {
  return { $schema: "https://example/schema", model: "x", enabledPlugins: { "other@market": true }, keep: 1 }
}

describe("install.mjs", () => {
  it("写入市场清单 + 插件源 + 安装落地 + 三处台账 + Hub 适配器登记", async () => {
    const wbHome = tempDir("agentchat-wb-home-")
    const home = tempDir("agentchat-home-")
    const source = pluginSource()
    const paths = installerPaths(wbHome)
    mkdirSync(wbHome, { recursive: true })
    writeFileSync(paths.settings, `${JSON.stringify(settingsSeed(), null, 2)}\n`)

    const result = await run(["--plugin-dir", source], { wbHome, home })
    expect(result.code).toBe(0)

    const manifest = readJson(paths.marketplaceManifest)
    expect(manifest["name"]).toBe(MARKETPLACE_NAME)
    const plugins = manifest["plugins"] as Array<Record<string, string>>
    expect(plugins[0]?.["name"]).toBe(PLUGIN_NAME)
    expect(plugins[0]?.["source"]).toBe(`./${PLUGIN_NAME}`) // 包内**不含机器绝对路径**

    expect(existsSync(join(paths.pluginSourceDir, ".codebuddy-plugin", "plugin.json"))).toBe(true)
    expect(existsSync(join(paths.installDir, "hooks", "hooks.json"))).toBe(true)

    const known = readJson(paths.knownMarketplaces)
    const entry = known[MARKETPLACE_NAME] as Record<string, unknown>
    expect(entry["type"]).toBe("directory")
    expect((entry["source"] as Record<string, string>)["path"]).toBeTruthy()

    const installed = readJson(paths.installedPlugins)
    expect(installed["version"]).toBe(2)
    expect((installed["plugins"] as Record<string, unknown>)[pluginKey()]).toBeDefined()

    const settings = readJson(paths.settings)
    expect((settings["enabledPlugins"] as Record<string, unknown>)[pluginKey()]).toBe(true)
    expect((settings["enabledPlugins"] as Record<string, unknown>)["other@market"]).toBe(true) // 保留用户键
    expect(settings["model"]).toBe("x")

    const agentchat = readJson(join(home, "config.json"))
    expect(agentchat["adapters"]).toEqual(["workbuddy"])
  })

  it("幂等：二次安装后所有落盘文件字节等价", async () => {
    const wbHome = tempDir("agentchat-wb-home-")
    const home = tempDir("agentchat-home-")
    const source = pluginSource()
    const paths = installerPaths(wbHome)
    mkdirSync(wbHome, { recursive: true })
    writeFileSync(paths.settings, `${JSON.stringify(settingsSeed(), null, 2)}\n`)

    expect((await run(["--plugin-dir", source, "--force"], { wbHome, home })).code).toBe(0)
    const snapshot = [
      readFileSync(paths.settings, "utf8"),
      readFileSync(paths.knownMarketplaces, "utf8"),
      readFileSync(paths.installedPlugins, "utf8"),
      readFileSync(paths.marketplaceManifest, "utf8"),
      readFileSync(join(home, "config.json"), "utf8"),
    ]
    expect((await run(["--plugin-dir", source, "--force"], { wbHome, home })).code).toBe(0)
    expect([
      readFileSync(paths.settings, "utf8"),
      readFileSync(paths.knownMarketplaces, "utf8"),
      readFileSync(paths.installedPlugins, "utf8"),
      readFileSync(paths.marketplaceManifest, "utf8"),
      readFileSync(join(home, "config.json"), "utf8"),
    ]).toEqual(snapshot)
  })

  it("--dry-run 只打印、不落盘、不产生备份", async () => {
    const wbHome = tempDir("agentchat-wb-home-")
    const home = tempDir("agentchat-home-")
    const source = pluginSource()
    const paths = installerPaths(wbHome)
    mkdirSync(wbHome, { recursive: true })
    const before = `${JSON.stringify(settingsSeed(), null, 2)}\n`
    writeFileSync(paths.settings, before)

    const result = await run(["--plugin-dir", source, "--dry-run"], { wbHome, home })
    expect(result.code).toBe(0)
    expect(readFileSync(paths.settings, "utf8")).toBe(before)
    expect(existsSync(`${paths.settings}.agentchat.bak`)).toBe(false)
    expect(existsSync(paths.marketplaceDir)).toBe(false)
    expect(existsSync(join(home, "config.json"))).toBe(false)
    expect(result.stdout).toContain("marketplace.json")
    expect(result.stderr).toContain("--dry-run")
  })

  it("--uninstall 字节级还原（含删掉本安装器创建的文件，不留空壳）", async () => {
    const wbHome = tempDir("agentchat-wb-home-")
    const home = tempDir("agentchat-home-")
    const source = pluginSource()
    const paths = installerPaths(wbHome)
    mkdirSync(wbHome, { recursive: true })
    const settingsBefore = `${JSON.stringify(settingsSeed(), null, 2)}\n`
    writeFileSync(paths.settings, settingsBefore)

    expect((await run(["--plugin-dir", source], { wbHome, home })).code).toBe(0)
    expect(existsSync(paths.knownMarketplaces)).toBe(true)

    const result = await run(["--uninstall"], { wbHome, home })
    expect(result.code).toBe(0)
    expect(readFileSync(paths.settings, "utf8")).toBe(settingsBefore) // 字节级还原
    expect(existsSync(paths.knownMarketplaces)).toBe(false) // 本安装器创建 → 删掉
    expect(existsSync(paths.installedPlugins)).toBe(false)
    expect(existsSync(paths.marketplaceDir)).toBe(false)
    expect(existsSync(paths.installDir)).toBe(false)
    expect(result.stdout).toContain("restored")
    expect(readJson(join(home, "config.json"))["adapters"]).toEqual([])
  })

  it("用户改过配置 → 精确移除自己的键 + 告警（不静默损毁改动）", async () => {
    const wbHome = tempDir("agentchat-wb-home-")
    const home = tempDir("agentchat-home-")
    const source = pluginSource()
    const paths = installerPaths(wbHome)
    mkdirSync(wbHome, { recursive: true })
    writeFileSync(paths.settings, `${JSON.stringify(settingsSeed(), null, 2)}\n`)
    expect((await run(["--plugin-dir", source], { wbHome, home })).code).toBe(0)

    // 第三方（用户或别的工具）在安装之后又改了同一个文件
    const mutated = readJson(paths.settings)
    mutated["addedLater"] = "by-user"
    writeFileSync(paths.settings, `${JSON.stringify(mutated, null, 2)}\n`)

    const result = await run(["--uninstall"], { wbHome, home })
    expect(result.code).toBe(0)
    expect(result.stderr).toContain("无法字节级还原")
    const settings = readJson(paths.settings)
    expect(settings["addedLater"]).toBe("by-user") // 用户改动被保留
    expect((settings["enabledPlugins"] as Record<string, unknown>)[pluginKey()]).toBeUndefined()
    expect((settings["enabledPlugins"] as Record<string, unknown>)["other@market"]).toBe(true)
  })

  it("未知参数 / 缺插件源 / 目标已存在（未 --force）→ 非 0 退出并给出可诊断信息", async () => {
    const wbHome = tempDir("agentchat-wb-home-")
    const home = tempDir("agentchat-home-")

    const unknown = await run(["--nope"], { wbHome, home })
    expect(unknown.code).not.toBe(0)
    expect(unknown.stderr).toContain("未知参数")

    const missing = await run(["--plugin-dir", join(tempDir(), "nope")], { wbHome, home })
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain("不存在")

    const source = pluginSource()
    expect((await run(["--plugin-dir", source], { wbHome, home })).code).toBe(0)
    const again = await run(["--plugin-dir", source], { wbHome, home })
    expect(again.code).not.toBe(0)
    expect(again.stderr).toContain("--force")
    expect((await run(["--plugin-dir", source, "--force"], { wbHome, home })).code).toBe(0)
  })

  it("--help 打印用法且退出码 0", async () => {
    const result = await run(["--help"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("AgentChat WorkBuddy 安装器")
    expect(result.stdout).toContain("--uninstall")
  })
})
