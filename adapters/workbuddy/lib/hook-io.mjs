/**
 * hook 侧 I/O 管道：stdin JSON 读取、stdout 决策输出、以及「任何失败都不阻塞宿主」的入口包裹。
 *
 * 纪律：hook 的 stdout 是**宿主协议通道**（Stop 的决策 JSON / SessionStart 的 additionalContext），
 * 除本模块的 {@link emit} 外**不得**向 stdout 写任何东西（诊断一律走 {@link import("./log.mjs")}）。
 */
import { errorMessage, isRecord } from "./util.mjs"

/** 读全部 stdin 并解析为 JSON 对象；空/非法 → `{}`（hook 继续，不因坏载荷退出）。 */
export async function readStdinJson() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString("utf8").trim()
  if (text === "") return {}
  try {
    const value = JSON.parse(text)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

/** 向 stdout 输出宿主决策 JSON（唯一允许的 stdout 写入口）。 */
export function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/** 规范化 hook 载荷的公共字段（各事件都有，但类型不保证）。 */
export function hookInput(input) {
  return {
    sessionId: typeof input["session_id"] === "string" ? input["session_id"] : undefined,
    cwd: typeof input["cwd"] === "string" ? input["cwd"] : undefined,
    event: typeof input["hook_event_name"] === "string" ? input["hook_event_name"] : undefined,
  }
}

/**
 * hook 入口包裹：任何异常与本地文件问题都只记日志，退出码恒 0。
 * 这是「不得阻塞/非零退出影响宿主」纪律的单一落点。
 */
export async function runHook(name, log, task) {
  try {
    await task()
  } catch (error) {
    log(`${name} failed: ${errorMessage(error)}`)
  }
  process.exitCode = 0
}
