/**
 * `agentchat --check-update` 的纯逻辑与 IO 测试（`bin/update-check.mjs`）。
 *
 * 零网络、零进程：fetch 注入；`stdout`/`stderr` 用内存 sink；临时 home 造 `config.json`。
 * 锁死：基址解析优先级、退出码（0=已最新 / 1=有更新 / 2=失败）、报告文本（含手动升级步骤、
 * 失败给错误码）、以及 Hub 不可达时的失败姿态。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_PORT,
  filePort,
  formatUpdateReport,
  portOf,
  resolveHubBase,
  runUpdateCheckCommand,
  updateExitCode,
} from "../../bin/update-check.mjs"

let home = ""

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentchat-update-cli-"))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function sink() {
  const chunks: string[] = []
  return { chunks, write: (chunk: unknown) => void chunks.push(String(chunk)) }
}

/** 成功载荷（字段与 `/api/version/check` 一致）。 */
function successPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    current: "0.2.0",
    latest: "0.3.0",
    updateAvailable: true,
    adaptersOutdated: ["dsh"],
    tagsChecked: 3,
    source: "https://api.github.com/repos/cjznb/agentchat/tags",
    checkedAt: 1_000,
    cached: false,
    compareUrl: "https://github.com/cjznb/agentchat/compare/v0.2.0...v0.3.0",
    ...overrides,
  }
}

describe("端口与基址解析", () => {
  it("portOf 只接受 0..65535 的十进制整数", () => {
    expect(portOf("5000")).toBe(5000)
    expect(portOf("0")).toBe(0)
    expect(portOf("65535")).toBe(65535)
    expect(portOf("65536")).toBeUndefined()
    expect(portOf("abc")).toBeUndefined()
    expect(portOf("")).toBeUndefined()
    expect(portOf(undefined)).toBeUndefined()
  })

  it("filePort 读 <home>/config.json；坏文件/错类型不抛", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 5001 }))
    expect(filePort(home)).toBe(5001)

    writeFileSync(join(home, "config.json"), "{ not json")
    expect(filePort(home)).toBeUndefined()

    writeFileSync(join(home, "config.json"), JSON.stringify({ port: "5001" }))
    expect(filePort(home)).toBeUndefined()

    expect(filePort(join(home, "missing"))).toBeUndefined()
  })

  it("resolveHubBase：AGENTCHAT_URL > 显式端口 > env 端口 > config.json > 默认", () => {
    expect(resolveHubBase({ env: { AGENTCHAT_URL: "http://127.0.0.1:9999/" } })).toBe(
      "http://127.0.0.1:9999",
    )
    expect(resolveHubBase({ port: 5002, env: { AGENTCHAT_PORT: "5003" } })).toBe(
      "http://127.0.0.1:5002",
    )
    expect(resolveHubBase({ env: { AGENTCHAT_PORT: "5003" } })).toBe("http://127.0.0.1:5003")

    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 5004 }))
    expect(resolveHubBase({ home, env: {} })).toBe("http://127.0.0.1:5004")
    expect(resolveHubBase({ env: { AGENTCHAT_HOME: home } })).toBe("http://127.0.0.1:5004")
    expect(resolveHubBase({ env: {} })).toBe(`http://127.0.0.1:${DEFAULT_PORT}`)
  })
})

describe("退出码与报告文本", () => {
  it("updateExitCode：1=有更新、0=已最新、2=检查失败", () => {
    expect(updateExitCode(successPayload())).toBe(1)
    expect(updateExitCode(successPayload({ updateAvailable: false }))).toBe(0)
    expect(updateExitCode(successPayload({ updateAvailable: null }))).toBe(0)
    expect(updateExitCode({ ok: false, error: "no_tags" })).toBe(2)
    expect(updateExitCode(null)).toBe(2)
    expect(updateExitCode(undefined)).toBe(2)
  })

  it("成功且有更新：给 current/latest/适配器/比较链接与手动升级步骤", () => {
    const report = formatUpdateReport(successPayload())
    expect(report).toContain("当前版本   0.2.0")
    expect(report).toContain("最新版本   0.3.0")
    expect(report).toContain("更新可用   是")
    expect(report).toContain("适配器     dsh")
    expect(report).toContain("compare/v0.2.0...v0.3.0")
    expect(report).toContain("手动升级（本命令不会自动执行）")
    expect(report).toContain("git pull --ff-only")
    expect(report).toContain("npm run build")
  })

  it("已最新：不出现手动升级步骤；缓存命中会标注", () => {
    const report = formatUpdateReport(successPayload({ updateAvailable: false, cached: true }))
    expect(report).toContain("更新可用   否")
    expect(report).toContain("缓存命中")
    expect(report).toContain("已是最新版本")
    expect(report).not.toContain("手动升级")
  })

  it("失败：给错误码与详情，并说明不影响 Hub 运行", () => {
    const report = formatUpdateReport({
      ok: false,
      error: "no_tags",
      detail: "远端没有可解析的 tag",
      source: "https://example.test/tags",
    })
    expect(report).toContain("更新检查：失败")
    expect(report).toContain("错误码    no_tags")
    expect(report).toContain("远端没有可解析的 tag")
    expect(report).toContain("不影响 Hub 运行")
    expect(formatUpdateReport(null)).toContain("unknown_error")
  })
})

describe("runUpdateCheckCommand", () => {
  it("POST 到解析出的基址，打印报告并返回退出码", async () => {
    const stdout = sink()
    const seen: string[] = []
    const code = await runUpdateCheckCommand(
      { port: undefined, home: undefined, checkUpdate: true },
      {
        env: { AGENTCHAT_URL: "http://127.0.0.1:4321" },
        stdout,
        fetchImpl: async (url: string, init: { method?: string }) => {
          seen.push(`${init.method ?? "GET"} ${url}`)
          return new Response(JSON.stringify(successPayload()), { status: 200 })
        },
      },
    )
    expect(seen).toEqual(["POST http://127.0.0.1:4321/api/version/check"])
    expect(code).toBe(1)
    expect(stdout.chunks.join("")).toContain("最新版本   0.3.0")
  })

  it("已最新 → 退出码 0", async () => {
    const stdout = sink()
    const code = await runUpdateCheckCommand(
      {},
      {
        env: { AGENTCHAT_URL: "http://127.0.0.1:4321" },
        stdout,
        fetchImpl: async () =>
          new Response(JSON.stringify(successPayload({ updateAvailable: false })), { status: 200 }),
      },
    )
    expect(code).toBe(0)
    expect(stdout.chunks.join("")).toContain("已是最新版本")
  })

  it("Hub 不可达 / 非 2xx → 退出码 2 + stderr 指引，不抛异常", async () => {
    const stderr = sink()
    const unreachable = await runUpdateCheckCommand(
      {},
      {
        env: { AGENTCHAT_URL: "http://127.0.0.1:4321" },
        stderr,
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED")
        },
      },
    )
    expect(unreachable).toBe(2)
    expect(stderr.chunks.join("")).toContain("无法连接 Hub")
    expect(stderr.chunks.join("")).toContain("请先启动 Hub")

    const badStatus = sink()
    expect(
      await runUpdateCheckCommand(
        {},
        {
          env: { AGENTCHAT_URL: "http://127.0.0.1:4321" },
          stderr: badStatus,
          fetchImpl: async () => new Response("nope", { status: 502 }),
        },
      ),
    ).toBe(2)
    expect(badStatus.chunks.join("")).toContain("HTTP 502")
  })
})
