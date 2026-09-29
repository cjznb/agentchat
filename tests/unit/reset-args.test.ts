/**
 * `agentchat reset` 纯参数解析测试（`bin/reset-args.mjs`）：
 * 覆盖 `--yes`/`--keep-backups`/`--uninstall-adapters`/`--force` 的语义与组合、
 * 帮助、以及未知参数报错。纯函数，不触碰真实环境或子进程。
 */
import { describe, expect, it } from "vitest"
import { parseResetArgs } from "../../bin/reset-args.mjs"

const parse = (...argv: string[]) => parseResetArgs(argv)

describe("parseResetArgs", () => {
  it("默认全部为 false、无错误", () => {
    const parsed = parse()
    expect(parsed.yes).toBe(false)
    expect(parsed.keepBackups).toBe(false)
    expect(parsed.uninstallAdapters).toBe(false)
    expect(parsed.force).toBe(false)
    expect(parsed.help).toBe(false)
    expect(parsed.errors).toEqual([])
  })

  it("识别四个布尔开关（含任意顺序与组合）", () => {
    const parsed = parse("--uninstall-adapters", "--keep-backups", "--force", "--yes")
    expect(parsed.yes).toBe(true)
    expect(parsed.keepBackups).toBe(true)
    expect(parsed.uninstallAdapters).toBe(true)
    expect(parsed.force).toBe(true)
    expect(parsed.errors).toEqual([])
  })

  it("识别 -h / --help", () => {
    expect(parse("-h").help).toBe(true)
    expect(parse("--help").help).toBe(true)
  })

  it("未知参数 / 位置参数记为错误", () => {
    expect(parse("--nope").errors.some((e) => e.includes("无法识别"))).toBe(true)
    expect(parse("extra").errors.some((e) => e.includes("无法识别"))).toBe(true)
  })
})
