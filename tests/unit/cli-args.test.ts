/**
 * `agentchat` CLI 纯参数解析测试（`bin/cli-args.mjs`）：
 * 覆盖端口/目录/开关/帮助/版本/`--` 透传/非法输入的完整矩阵，以及 `childEnv` 映射。
 * 解析与映射均为纯函数，不触碰真实环境或子进程。
 */
import { describe, expect, it } from "vitest"
import { childEnv, parseArgs } from "../../bin/cli-args.mjs"

const parse = (...argv: string[]) => parseArgs(argv)

describe("parseArgs", () => {
  it("yields defaults for an empty argv", () => {
    const parsed = parse()
    expect(parsed.port).toBeUndefined()
    expect(parsed.home).toBeUndefined()
    expect(parsed.noOpen).toBe(false)
    expect(parsed.build).toBe(false)
    expect(parsed.help).toBe(false)
    expect(parsed.version).toBe(false)
    expect(parsed.passthrough).toEqual([])
    expect(parsed.errors).toEqual([])
  })

  it("parses --port in both separated and inline forms, including 0", () => {
    expect(parse("--port", "5000").port).toBe(5000)
    expect(parse("--port=5000").port).toBe(5000)
    expect(parse("--port", "0").port).toBe(0)
    expect(parse("--port=0").port).toBe(0)
  })

  it("rejects invalid or out-of-range ports", () => {
    expect(parse("--port", "abc").errors.some((e) => e.includes("整数"))).toBe(true)
    expect(parse("--port", "-1").errors.some((e) => e.includes("整数"))).toBe(true)
    expect(parse("--port", "70000").errors.some((e) => e.includes("65535"))).toBe(true)
    expect(parse("--port=1.5").errors.length).toBeGreaterThan(0)
  })

  it("reports a missing value for --port", () => {
    expect(parse("--port").errors.some((e) => e.includes("缺少取值"))).toBe(true)
    expect(parse("--port=").errors.some((e) => e.includes("缺少取值"))).toBe(true)
  })

  it("parses --home in both forms and rejects an empty value", () => {
    expect(parse("--home", "/tmp/a b").home).toBe("/tmp/a b")
    expect(parse("--home=./data").home).toBe("./data")
    expect(parse("--home=").errors.some((e) => e.includes("缺少取值"))).toBe(true)
  })

  it("recognizes the boolean switches", () => {
    const parsed = parse("--no-open", "--build")
    expect(parsed.noOpen).toBe(true)
    expect(parsed.build).toBe(true)
  })

  it("recognizes help and version in short and long forms", () => {
    expect(parse("-h").help).toBe(true)
    expect(parse("--help").help).toBe(true)
    expect(parse("-v").version).toBe(true)
    expect(parse("--version").version).toBe(true)
  })

  it("passes everything after -- through verbatim and stops parsing", () => {
    const parsed = parse("--port", "1", "--", "--no-open", "positional")
    expect(parsed.port).toBe(1)
    expect(parsed.noOpen).toBe(false)
    expect(parsed.passthrough).toEqual(["--no-open", "positional"])
    expect(parsed.errors).toEqual([])
  })

  it("flags unknown arguments before --", () => {
    expect(parse("--wat").errors.some((e) => e.includes("无法识别"))).toBe(true)
    expect(parse("positional").errors.some((e) => e.includes("无法识别"))).toBe(true)
  })
})

describe("childEnv", () => {
  it("maps home/port/noOpen to AGENTCHAT_* overrides", () => {
    const env = childEnv(
      { home: "/tmp/h", port: 5000, noOpen: true },
      { KEEP: "1", AGENTCHAT_HOME: "old" },
    )
    expect(env["AGENTCHAT_HOME"]).toBe("/tmp/h")
    expect(env["AGENTCHAT_PORT"]).toBe("5000")
    expect(env["AGENTCHAT_NO_OPEN"]).toBe("1")
    expect(env["KEEP"]).toBe("1")
  })

  it("does not override when options are absent", () => {
    const base = { AGENTCHAT_PORT: "1111" }
    const env = childEnv({ home: undefined, port: undefined, noOpen: false }, base)
    expect(env["AGENTCHAT_PORT"]).toBe("1111")
    expect(env["AGENTCHAT_HOME"]).toBeUndefined()
    expect(env["AGENTCHAT_NO_OPEN"]).toBeUndefined()
  })

  it("leaves the base environment untouched", () => {
    const base = { AGENTCHAT_HOME: "old" }
    childEnv({ home: "new", port: undefined, noOpen: false }, base)
    expect(base.AGENTCHAT_HOME).toBe("old")
  })
})
