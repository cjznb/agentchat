#!/usr/bin/env node
/**
 * 测试适配器 B：**真机可跑的步骤化场景运行器**（`adapters/test/cli.mjs`）。
 *
 * 用法：
 *   node adapters/test/cli.mjs --scenario <dm|group|busy|refused|lease|offline|shout|logical|states|all>
 *        [--spawn] [--home <dir>] [--url <baseUrl>] [--poll-ms 200]
 *        [--hold-ms 600] [--lease-wait-ms 31500] [--verbose]
 *
 * - `--spawn`：自己拉起真实 Hub（`tsx server/main.ts`，注入 `AGENTCHAT_HOME` = 一次性临时目录、
 *   `AGENTCHAT_TEST_API=1`、`AGENTCHAT_NO_OPEN=1`、`AGENTCHAT_ADAPTERS=""`、空闲端口），
 *   结束时**杀整棵进程树并删临时目录**（见 `lib/hub-process.mjs`）。
 * - 不带 `--spawn`：连接既有 Hub（地址取 `--url` 或 `AGENTCHAT_URL`/`AGENTCHAT_PORT`）；
 *   token 从 `--home`（或 `AGENTCHAT_HOME`）下的 `hub_token` 读 —— 故连接既有 Hub 应显式给
 *   `--home`，否则会拿临时目录的空 token 换回 401。
 * - 每个场景打印一张状态迁移表（回执阶段用真 `message_status` 派生 + `wake_jobs` 原始行），
 *   逐条判定的 `✔/✘` 行可直接贴进报告；退出码 = **失败场景数**。
 * - **绝不写用户真实 `~/.agentchat`**：`--spawn` 拒绝真实目录；未给 `--home` 时用一次性临时
 *   目录并在结束时清理（仓库有历史事故）。
 */
import { randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import { resolve } from "node:path"
import { createTestHost } from "./lib/host.mjs"
import { clockText, createReporter } from "./lib/report.mjs"
import { SCENARIOS, SCENARIO_NAMES, CLAIM_TIMEOUT_MS } from "./lib/scenarios.mjs"
import {
  assertNotRealHome,
  freePort,
  makeTempHome,
  prepareHubToken,
  startHubProcess,
  waitForHealth,
} from "./lib/hub-process.mjs"

const USAGE = `AgentChat 测试适配器场景运行器（task-6 T6）

用法：
  node adapters/test/cli.mjs --scenario <name> [--spawn] [--home <dir>] [--url <baseUrl>] [--verbose]

场景：${SCENARIO_NAMES.join(" | ")} | all
参数：
  --scenario <name>     必填（--scenario all 顺序跑全部 9 个）
  --spawn               自己拉起 Hub（临时 AGENTCHAT_HOME + AGENTCHAT_TEST_API=1，结束杀树清目录）
  --home <dir>          数据目录（token 来源）；--spawn 未给则自动建一次性临时目录
  --url <baseUrl>       既有 Hub 地址（缺省 http://127.0.0.1:\${AGENTCHAT_PORT ?? 4646}）
  --poll-ms <ms>        轮询间隔（保留给 startPolling；缺省 200）
  --hold-ms <ms>        busy 场景"不 flush 观察窗"（缺省 600）
  --lease-wait-ms <ms>  lease 场景真实等待租约到期（缺省 ${CLAIM_TIMEOUT_MS + 1500}）
  --verbose             透传 Hub 进程日志与 host 日志
`

const FLAGS = {
  "--scenario": "scenario",
  "--home": "home",
  "--url": "url",
  "--poll-ms": "pollMs",
  "--hold-ms": "holdMs",
  "--lease-wait-ms": "leaseWaitMs",
  "--spawn": "spawn",
  "--verbose": "verbose",
  "--help": "help",
  "-h": "help",
}
const BOOLEAN_KEYS = new Set(["spawn", "verbose", "help"])
const NUMBER_KEYS = new Set(["pollMs", "holdMs", "leaseWaitMs"])

function parseArgs(argv) {
  const args = {
    scenario: "all",
    spawn: false,
    verbose: false,
    help: false,
    pollMs: 200,
    holdMs: 600,
    leaseWaitMs: CLAIM_TIMEOUT_MS + 1_500,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const key = FLAGS[argv[index]]
    if (key === undefined) throw new Error(`未知参数：${argv[index]}`)
    if (BOOLEAN_KEYS.has(key)) {
      args[key] = true
      continue
    }
    const raw = argv[index + 1]
    if (raw === undefined || raw.startsWith("--")) throw new Error(`参数 ${argv[index]} 缺值`)
    index += 1
    if (NUMBER_KEYS.has(key)) {
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0) throw new Error(`参数 ${argv[index - 1]} 需要非负数字，收到 ${raw}`)
      args[key] = value
    } else {
      args[key] = raw
    }
  }
  return args
}

async function runScenarios(names, home, baseUrl, args) {
  const results = []
  for (const name of names) {
    process.stdout.write(`\n=== 场景 ${name} ${"=".repeat(Math.max(0, 46 - name.length))}\n`)
    const report = createReporter()
    const host = createTestHost({
      home,
      baseUrl,
      namePrefix: `${name}-${randomBytes(2).toString("hex")}`,
      log: args.verbose ? (message) => report.note(`host: ${message}`) : undefined,
    })
    let error
    try {
      await SCENARIOS[name]({ host, report, args })
    } catch (thrown) {
      error = thrown
      report.check(`场景 ${name} 未抛异常`, false, thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      host.close()
    }
    report.table(`场景 ${name} 状态迁移表`)
    if (error instanceof Error && error.stack !== undefined) report.note(error.stack.split("\n").slice(0, 4).join(" | "))
    const ok = report.verdict(name)
    results.push({ name, ok, passed: report.passed, total: report.checks.length })
  }
  return results
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const names = args.scenario === "all" ? SCENARIO_NAMES : [args.scenario]
  const unknown = names.filter((name) => SCENARIOS[name] === undefined)
  if (unknown.length > 0) {
    process.stderr.write(`未知场景：${unknown.join(", ")}\n\n${USAGE}`)
    return 2
  }

  let home = args.home === undefined ? undefined : resolve(args.home)
  let tempHome = false
  let hubProcess
  let baseUrl = args.url
  try {
    if (args.spawn) {
      if (home === undefined) {
        home = makeTempHome()
        tempHome = true
      }
      assertNotRealHome(home)
      const port = await freePort()
      prepareHubToken(home) // 先写票：Hub 的 hub_token 是惰性创建的，双方必须用同一张
      hubProcess = await startHubProcess({
        home,
        port,
        log: args.verbose ? (line) => process.stdout.write(`[hub] ${line}\n`) : undefined,
      })
      baseUrl = hubProcess.url
      await waitForHealth(baseUrl, { timeoutMs: 30_000, logs: hubProcess.logs })
      process.stdout.write(
        `${clockText()}  拉起 Hub：${baseUrl}（pid=${hubProcess.pid}）  AGENTCHAT_HOME=${home}` +
          `${tempHome ? "（一次性临时目录，结束即清理）" : ""}\n`,
      )
    } else if (home === undefined) {
      tempHome = true
      home = makeTempHome()
      process.stdout.write(
        `${clockText()}  未给 --home：用一次性临时目录 ${home} 解析 hub_token` +
          "（连接既有 Hub 请用 --home 指向它的数据目录，否则会 401）\n",
      )
    }

    const results = await runScenarios(names, home, baseUrl, args)
    const failed = results.filter((result) => !result.ok).length
    process.stdout.write(`\n=== 汇总：${results.length - failed}/${results.length} 场景 PASS ===\n`)
    for (const result of results) {
      process.stdout.write(`  ${result.ok ? "PASS" : "FAIL"}  ${result.name}  检查 ${result.passed}/${result.total}\n`)
    }
    return failed
  } finally {
    if (hubProcess !== undefined) await hubProcess.stop()
    if (tempHome && home !== undefined) rmSync(home, { recursive: true, force: true })
  }
}

main()
  .then((code) => {
    process.exitCode = code
    // 100ms 收尾：给 stdout 冲管时间，同时避免 undici keep-alive 把进程挂住。
    setTimeout(() => process.exit(code), 100)
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(2)
  })
