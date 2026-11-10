/**
 * `agentchat --check-update` 的 IO 与呈现（U1/task-16）。
 *
 * 分工：`bin/cli-args.mjs` 只解析参数；本模块负责「找到运行中的 Hub → POST
 * `/api/version/check` → 打印报告 → 返回退出码（0=已最新、1=有更新、2=检查失败）」。
 * **只检查、绝不自动 pull/install**：升级步骤只作为提示文本给出。
 *
 * 纯函数（`resolveHubBase` / `formatUpdateReport` / `updateExitCode` / `portOf` / `filePort`）
 * 与 IO（`runUpdateCheckCommand`）分开导出，便于 vitest 直接断言；IO 依赖可注入（deps）。
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** 与 `server/config.ts` 的 `DEFAULT_PORT` 对齐（CLI 不 import TS 源码）。 */
export const DEFAULT_PORT = 4646
export const REQUEST_TIMEOUT_MS = 10_000

const DEFAULT_HOME = join(homedir(), ".agentchat")

/** 非空字符串取值（trim）。 */
function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 端口文本 → 0..65535 整数；非法 → undefined。 */
export function portOf(raw) {
  const value = text(raw)
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const port = Number(value)
  return port <= 65535 ? port : undefined
}

/** `<home>/config.json` 的 `port`（缺失/非法 → undefined；绝不因坏文件失败）。 */
export function filePort(homeDir) {
  const home = text(homeDir) ?? DEFAULT_HOME
  const path = join(home, "config.json")
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (parsed === null || typeof parsed !== "object") return undefined
    const port = parsed.port
    return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined
  } catch {
    return undefined
  }
}

/** Hub 基址：`AGENTCHAT_URL` > `--port`/`AGENTCHAT_PORT` > `config.json` 的 port > 默认端口。 */
export function resolveHubBase(input = {}) {
  const env = input.env ?? process.env
  const explicit = text(input.url) ?? text(env["AGENTCHAT_URL"])
  if (explicit !== undefined) return explicit.replace(/\/+$/, "")
  const port =
    input.port ??
    portOf(env["AGENTCHAT_PORT"]) ??
    filePort(input.home ?? env["AGENTCHAT_HOME"]) ??
    DEFAULT_PORT
  return `http://127.0.0.1:${port}`
}

/** 退出码：检查失败 → 2；有更新 → 1；已最新 → 0。 */
export function updateExitCode(payload) {
  if (payload === null || typeof payload !== "object" || payload.ok !== true) return 2
  return payload.updateAvailable === true ? 1 : 0
}

/** 报告文本（人能直接贴进 issue）：成功给 current/latest/适配器/手动升级步骤；失败给错误码。 */
export function formatUpdateReport(payload) {
  if (payload === null || typeof payload !== "object" || payload.ok !== true) {
    const error = typeof payload?.error === "string" ? payload.error : "unknown_error"
    const lines = ["AgentChat 更新检查：失败", `  错误码    ${error}`]
    if (typeof payload?.detail === "string") lines.push(`  详情      ${payload.detail}`)
    if (typeof payload?.source === "string") lines.push(`  数据源    ${payload.source}`)
    lines.push("  提示      仅读取远端 tag；检查失败不影响 Hub 运行，可稍后重试。")
    return `${lines.join("\n")}\n`
  }
  const outdated = Array.isArray(payload.adaptersOutdated) ? payload.adaptersOutdated : []
  const lines = [
    "AgentChat 更新检查",
    `  当前版本   ${payload.current}`,
    `  最新版本   ${payload.latest}`,
    `  更新可用   ${payload.updateAvailable === true ? "是" : "否"}`,
    `  检查来源   ${payload.source}（共 ${payload.tagsChecked} 个 tag${payload.cached ? "，缓存命中" : ""}）`,
    `  比较链接   ${payload.compareUrl}`,
    `  适配器     ${outdated.length === 0 ? "无需更新（或未上报版本）" : outdated.join("、")}`,
  ]
  if (payload.updateAvailable === true) {
    lines.push(
      "手动升级（本命令不会自动执行）：",
      "  git pull --ff-only",
      "  npm install",
      "  npm run build",
      "  重启 Hub：agentchat",
    )
  } else {
    lines.push("已是最新版本，无需操作。")
  }
  return `${lines.join("\n")}\n`
}

/**
 * 请求运行中的 Hub 并打印报告；返回退出码。
 * Hub 不可达 → stderr 给出清晰指引 + 退出码 2（不抛异常，不自动升级）。
 */
export async function runUpdateCheckCommand(parsed, deps = {}) {
  const env = deps.env ?? process.env
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const base = resolveHubBase({ port: parsed?.port, home: parsed?.home, env })
  let payload
  try {
    const response = await fetchImpl(`${base}/api/version/check`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    payload = await response.json()
  } catch (error) {
    stderr.write(`[agentchat] 更新检查失败：无法连接 Hub（${base}）：${message(error)}\n`)
    stderr.write("[agentchat] 请先启动 Hub（`agentchat`），或用 AGENTCHAT_URL 指向已运行实例。\n")
    return 2
  }
  stdout.write(formatUpdateReport(payload))
  return updateExitCode(payload)
}
