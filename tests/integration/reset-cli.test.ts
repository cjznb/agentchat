/**
 * `agentchat reset` CLI 集成测试（`bin/reset.mjs` + `bin/reset-io.mjs`）：
 * - 先快照后清空：备份含原始内容，home 被清空但目录仍在
 * - `--keep-backups` 保留 backups/、清其余
 * - Hub 运行中拒绝（未 `--force`）/ `--force` 继续
 * - 非交互缺少 `--yes` 拒绝
 * - 快照失败时中止且**不触碰原始数据**（clear 未被调用）
 * - `--uninstall-adapters`：注入 run 断言调用；真子进程用例断言两个安装器清掉了临时 config
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { parseResetArgs } from "../../bin/reset-args.mjs"
import { uninstallAdapters } from "../../bin/reset-io.mjs"
import { runReset } from "../../bin/reset.mjs"

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 造一个含各类出厂态条目的 home。 */
function seedHome(): string {
  const home = tempDir("agentchat-reset-home-")
  writeFileSync(join(home, "agentchat.db"), "DB-ORIGINAL")
  writeFileSync(join(home, "hub_token"), "tok")
  writeFileSync(join(home, "config.json"), '{"adapters":["opencode"]}')
  mkdirSync(join(home, "agents"), { recursive: true })
  writeFileSync(join(home, "agents", "opencode.id"), "a1")
  mkdirSync(join(home, "logs"), { recursive: true })
  writeFileSync(join(home, "logs", "opencode-adapter.log"), "log")
  mkdirSync(join(home, "backups"), { recursive: true })
  writeFileSync(join(home, "backups", "agentchat-daily-2026-09-01.db"), "BACKUP")
  mkdirSync(join(home, "tokens"), { recursive: true })
  writeFileSync(join(home, "tokens", "x.token"), "t")
  return home
}

function siblingBackups(home: string): string[] {
  const prefix = `${basename(home)}.bak-`
  return readdirSync(tmpdir()).filter((name) => name.startsWith(prefix))
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  // 清掉可能产生的 <home>.bak-* 兄弟目录
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith("agentchat-reset-home-.bak-")) rmSync(join(tmpdir(), name), { recursive: true, force: true })
  }
})

describe("runReset（先快照后清空）", () => {
  it("快照含原始内容，home 被清空但目录仍在；退出码 0", async () => {
    const home = seedHome()
    const lines: string[] = []
    const outcome = await runReset(parseResetArgs(["--yes"]), {
      env: { AGENTCHAT_HOME: home },
      now: Date.parse("2026-09-29T10:00:00.000Z"),
      probe: async () => false,
      log: (line: string) => void lines.push(line),
    })

    expect(outcome.code).toBe(0)
    expect(outcome.snapshotPath).toBe(`${home}.bak-2026-09-29T10-00-00-000Z`)
    expect(readFileSync(join(outcome.snapshotPath as string, "agentchat.db"), "utf8")).toBe("DB-ORIGINAL")

    for (const name of ["agentchat.db", "hub_token", "config.json", "agents", "logs", "backups", "tokens"]) {
      expect(existsSync(join(home, name))).toBe(false)
    }
    expect(existsSync(home)).toBe(true)
    expect(lines.some((line) => line.includes("已快照到"))).toBe(true)
    expect(lines.some((line) => line.includes("--uninstall-adapters"))).toBe(true)
  })

  it("--keep-backups 保留 backups/、清其余", async () => {
    const home = seedHome()
    const outcome = await runReset(parseResetArgs(["--yes", "--keep-backups"]), {
      env: { AGENTCHAT_HOME: home },
      probe: async () => false,
      log: () => {},
    })

    expect(outcome.code).toBe(0)
    expect(outcome.removed).not.toContain("backups")
    expect(existsSync(join(home, "backups", "agentchat-daily-2026-09-01.db"))).toBe(true)
    expect(existsSync(join(home, "agentchat.db"))).toBe(false)
    expect(existsSync(join(home, "config.json"))).toBe(false)
  })
})

describe("runReset（安全检查与失败保留原状）", () => {
  it("Hub 运行中拒绝执行且不改动数据（退出码 3）", async () => {
    const home = seedHome()
    let clearCalled = false
    const outcome = await runReset(parseResetArgs(["--yes"]), {
      env: { AGENTCHAT_HOME: home },
      probe: async () => true,
      clear: () => {
        clearCalled = true
        return []
      },
      log: () => {},
    })

    expect(outcome.code).toBe(3)
    expect(clearCalled).toBe(false)
    expect(existsSync(join(home, "agentchat.db"))).toBe(true)
    expect(siblingBackups(home)).toHaveLength(0)
  })

  it("--force 在 Hub 运行中继续执行", async () => {
    const home = seedHome()
    const outcome = await runReset(parseResetArgs(["--yes", "--force"]), {
      env: { AGENTCHAT_HOME: home },
      probe: async () => true,
      log: () => {},
    })

    expect(outcome.code).toBe(0)
    expect(existsSync(join(home, "agentchat.db"))).toBe(false)
    expect(outcome.snapshotPath).toBeDefined()
  })

  it("非交互环境缺少 --yes 拒绝（退出码 4）", async () => {
    const home = seedHome()
    const outcome = await runReset(parseResetArgs([]), {
      env: { AGENTCHAT_HOME: home },
      probe: async () => false,
      isTTY: false,
      log: () => {},
    })

    expect(outcome.code).toBe(4)
    expect(existsSync(join(home, "agentchat.db"))).toBe(true)
    expect(siblingBackups(home)).toHaveLength(0)
  })

  it("快照失败即中止且不调用 clear（原始数据保留，退出码 1）", async () => {
    const home = seedHome()
    let clearCalled = false
    const outcome = await runReset(parseResetArgs(["--yes"]), {
      env: { AGENTCHAT_HOME: home },
      probe: async () => false,
      snapshot: () => {
        throw new Error("disk full")
      },
      clear: () => {
        clearCalled = true
        return []
      },
      log: () => {},
    })

    expect(outcome.code).toBe(1)
    expect(clearCalled).toBe(false)
    expect(existsSync(join(home, "agentchat.db"))).toBe(true)
  })
})

describe("runReset（--uninstall-adapters）", () => {
  it("注入 run：调用两个安装器并汇总退出码", async () => {
    const home = seedHome()
    const calls: string[] = []
    const outcome = await runReset(parseResetArgs(["--yes", "--uninstall-adapters"]), {
      env: { AGENTCHAT_HOME: home },
      probe: async () => false,
      uninstall: () => [
        { id: "claude-code", code: 0 },
        { id: "opencode", code: 0 },
      ],
      log: (line: string) => void calls.push(line),
    })

    expect(outcome.code).toBe(0)
    expect(outcome.uninstall).toEqual([
      { id: "claude-code", code: 0 },
      { id: "opencode", code: 0 },
    ])
    expect(calls.filter((line) => line.includes("--uninstall 退出码"))).toHaveLength(2)
  })

  it("真子进程：两个安装器的 --uninstall 清掉临时 config 中的条目", async () => {
    const repoRoot = join(import.meta.dirname, "..", "..")
    const home = seedHome()
    const claudeDir = tempDir("agentchat-reset-claude-")
    const opencodeConfig = join(tempDir("agentchat-reset-opencode-"), "opencode.json")
    writeFileSync(join(claudeDir, "settings.json"), "{}\n")
    writeFileSync(join(claudeDir, ".claude.json"), "{}\n")
    writeFileSync(opencodeConfig, "{}\n")
    const env = {
      ...process.env,
      AGENTCHAT_HOME: home,
      CLAUDE_CONFIG_DIR: claudeDir,
      OPENCODE_CONFIG: opencodeConfig,
    }
    const runInstaller = (script: string, installerEnv: NodeJS.ProcessEnv) =>
      ({ code: spawnSync(process.execPath, [script, "--uninstall"], { env: installerEnv, stdio: "pipe" }).status ?? 1 })

    // 先安装（把条目写进临时 config + home/config.json）
    for (const script of ["adapters/claude-code/install.mjs", "adapters/opencode/install.mjs"]) {
      const result = spawnSync(process.execPath, [join(repoRoot, script)], { env, stdio: "pipe" })
      expect(result.status, `${script} 安装应成功`).toBe(0)
    }
    expect(JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")).hooks).toBeDefined()

    // 再 reset --uninstall-adapters
    const outcome = await runReset(parseResetArgs(["--yes", "--uninstall-adapters"]), {
      env,
      probe: async () => false,
      uninstall: () => uninstallAdapters(env, runInstaller),
      log: () => {},
    })

    expect(outcome.code).toBe(0)
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"))
    expect(settings.hooks).toBeUndefined()
    const opencode = JSON.parse(readFileSync(opencodeConfig, "utf8"))
    expect(opencode.mcp?.agentchat).toBeUndefined()
  })
})
