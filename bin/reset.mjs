/**
 * `agentchat reset` 编排层：解析参数 → 安全检查（Hub 运行中 / 非交互）→ 先快照后清空 → 可选卸载适配器。
 *
 * 关键不变式：**先快照、后清空**；快照失败立即中止且**不触碰原始数据**（本层不删除任何东西，
 * 只调用注入的 `snapshot`/`clear`）。所有 IO 均可注入，便于单测不落盘。
 */
import { RESET_HELP_TEXT, parseResetArgs } from "./reset-args.mjs"
import {
  clearHome,
  probeHubRunning,
  resolveHome,
  resolvePort,
  snapshotHome,
  uninstallAdapters,
} from "./reset-io.mjs"

/** 退出码语义（文档与 README 同源）。 */
export const RESET_EXIT = { OK: 0, ERROR: 1, USAGE: 2, HUB_RUNNING: 3, NO_TTY: 4, DECLINED: 5 }

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 交互确认（仅 TTY）：要求输入 `RESET`。 */
async function interactiveConfirm() {
  const { createInterface } = await import("node:readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question("输入 RESET 以确认恢复出厂设置（其它输入取消）：")).trim() === "RESET"
  } finally {
    rl.close()
  }
}

/**
 * 执行一次 reset。
 * @param {import("./reset-args.mjs").ParsedResetArgs} parsed
 * @param {object} [deps] 注入点（缺省真实实现）
 * @returns {Promise<{ code: number, home: string, snapshotPath?: string, removed?: string[], uninstall?: {id:string,code:number}[] }>}
 */
export async function runReset(parsed, deps = {}) {
  const env = deps.env ?? process.env
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`))
  const home = resolveHome(env)

  if (!parsed.force) {
    const port = resolvePort(env, home)
    const running = await (deps.probe ?? probeHubRunning)(port)
    if (running) {
      log(`[agentchat] 检测到 Hub 正在 127.0.0.1:${port} 运行，已拒绝 reset（在线删库可能损坏数据）。`)
      log("[agentchat] 请先停止 Hub；确要在运行中继续请加 --force（有风险）。")
      return { code: RESET_EXIT.HUB_RUNNING, home }
    }
  } else {
    log("[agentchat] 警告：--force 已跳过「Hub 未运行」检查，运行中清库可能损坏数据。")
  }

  if (!parsed.yes) {
    const isTTY = deps.isTTY ?? process.stdin.isTTY === true
    if (!isTTY) {
      log("[agentchat] 非交互环境必须显式加 --yes 才能执行 reset（已拒绝）。")
      return { code: RESET_EXIT.NO_TTY, home }
    }
    const confirmed = await (deps.confirm ?? interactiveConfirm)()
    if (!confirmed) {
      log("[agentchat] 已取消，未做任何改动。")
      return { code: RESET_EXIT.DECLINED, home }
    }
  }

  log(`[agentchat] 数据目录：${home}`) // 先打印解析出的 home：避免误对默认 home 执行销毁
  let snapshotPath
  try {
    snapshotPath = (deps.snapshot ?? snapshotHome)(home, deps.now ?? Date.now())
  } catch (error) {
    log(`[agentchat] 快照失败，已中止（原始数据未改动）：${errorText(error)}`)
    return { code: RESET_EXIT.ERROR, home }
  }
  const removed = (deps.clear ?? clearHome)(home, { keepBackups: parsed.keepBackups })

  if (snapshotPath === undefined) {
    log(`[agentchat] 数据目录不存在（${home}），无需清理。`)
  } else {
    log(`[agentchat] 已快照到 ${snapshotPath}`)
    log(`[agentchat] 已清空 ${removed.length} 项：${removed.length === 0 ? "（无匹配内容）" : removed.join(", ")}`)
  }
  if (parsed.keepBackups) log("[agentchat] 已按 --keep-backups 保留 backups/。")

  let uninstall
  if (parsed.uninstallAdapters) {
    uninstall = (deps.uninstall ?? (() => uninstallAdapters(env)))()
    for (const result of uninstall) {
      log(`[agentchat] 适配器 ${result.id} --uninstall 退出码 ${result.code}`)
    }
  } else {
    log("[agentchat] 未卸载适配器配置；如需移除 hooks/插件/MCP 条目，请加 --uninstall-adapters。")
  }
  log("[agentchat] 出厂态不含 config.json，下次启动/安装器会按需再生成。")
  return {
    code: RESET_EXIT.OK,
    home,
    ...(snapshotPath === undefined ? {} : { snapshotPath }),
    removed,
    ...(uninstall === undefined ? {} : { uninstall }),
  }
}

/** CLI 入口：解析 `agentchat reset` 之后的参数并执行；返回进程退出码。 */
export async function runResetCommand(argv) {
  const parsed = parseResetArgs(argv)
  if (parsed.errors.length > 0) {
    for (const message of parsed.errors) process.stderr.write(`[agentchat] ${message}\n`)
    process.stderr.write("运行 `agentchat reset --help` 查看用法。\n")
    return RESET_EXIT.USAGE
  }
  if (parsed.help) {
    process.stdout.write(RESET_HELP_TEXT)
    return RESET_EXIT.OK
  }
  const outcome = await runReset(parsed)
  return outcome.code
}
