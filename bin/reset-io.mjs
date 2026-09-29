/**
 * `agentchat reset` 的 IO 层（快照 / 清空 / 端口探测 / 调用安装器）——纯 Node，无第三方依赖。
 *
 * 与 `server/routes/admin.ts` 的清库逻辑**有意分家**：CLI 在**停止态**直接删文件，
 * Hub 端点必须**在运行中**先 `VACUUM INTO` 快照、再就地清空 SQLite（Windows 锁文件。
 * 二者的目标文件清单一致，改动时请同步两处（注释互指）。
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** 出厂态应清空的 home 直属条目（`backups` 受 `--keep-backups` 控制）。 */
export const RESET_TARGETS = [
  "agentchat.db",
  "agentchat.db-wal",
  "agentchat.db-shm",
  "hub_token",
  "tokens",
  "agents",
  "logs",
  "backups",
  "config.json",
]

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 两个适配器安装器（复用其 `--uninstall`，不重复实现卸载逻辑）。 */
export const INSTALLERS = [
  { id: "claude-code", script: join(PACKAGE_ROOT, "adapters", "claude-code", "install.mjs") },
  { id: "opencode", script: join(PACKAGE_ROOT, "adapters", "opencode", "install.mjs") },
]

/** Hub 数据目录：`AGENTCHAT_HOME`（非空）否则 `~/.agentchat`（与 Hub/安装器一致）。 */
export function resolveHome(env) {
  const home = env.AGENTCHAT_HOME
  return home !== undefined && home !== "" ? home : join(homedir(), ".agentchat")
}

/** 端口：`AGENTCHAT_PORT`（非空数字）→ `<home>/config.json` 的 `port` → 4646。 */
export function resolvePort(env, home) {
  const raw = env.AGENTCHAT_PORT
  if (raw !== undefined && /^\d+$/.test(raw)) return Number(raw)
  try {
    const parsed = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
    if (typeof parsed === "object" && parsed !== null && typeof parsed.port === "number") {
      return parsed.port
    }
  } catch {
    // 无配置文件 / 非法 JSON：回落默认端口（探测失败等价「未运行」）
  }
  return 4646
}

/**
 * 快照整个数据目录到 `<home>.bak-<ISO 时间戳>`（同毫秒重名时追加 `-N`）。
 * 目录不存在 → `undefined`（无数据可备份）。复制失败抛错（调用方据此中止、保留原状）。
 */
export function snapshotHome(home, now) {
  if (!existsSync(home)) return undefined
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-")
  let dest = `${home}.bak-${stamp}`
  for (let n = 1; existsSync(dest); n += 1) dest = `${home}.bak-${stamp}-${n}`
  cpSync(home, dest, { recursive: true })
  return dest
}

/** 清空出厂态条目；返回实际移除的条目名列表（`backups` 在 `keepBackups` 时跳过）。 */
export function clearHome(home, { keepBackups }) {
  const removed = []
  for (const name of RESET_TARGETS) {
    if (name === "backups" && keepBackups) continue
    const target = join(home, name)
    if (!existsSync(target)) continue
    rmSync(target, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

/** 端口探测：`GET /api/health` 返回 `{status:'ok'}` 视为 Hub 在运行（超时/拒绝/异常 = 未运行）。 */
export async function probeHubRunning(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    })
    if (!response.ok) return false
    const body = await response.json()
    return body !== null && typeof body === "object" && body.status === "ok"
  } catch {
    return false
  }
}

/** 默认安装器执行器：`node <script> --uninstall`（继承给定 env）。 */
export function defaultRunInstaller(script, env) {
  const result = spawnSync(process.execPath, [script, "--uninstall"], { env, stdio: "inherit" })
  return { code: result.status ?? 1 }
}

/** 依次对两个安装器跑 `--uninstall`；`run` 可注入（测试不 spawn）。返回 `[{id, code}]`。 */
export function uninstallAdapters(env, run = defaultRunInstaller) {
  return INSTALLERS.map(({ id, script }) => {
    const result = run(script, env)
    return { id, code: result.code }
  })
}

/** 快照目录名（供输出/测试引用）。 */
export function snapshotBaseName(home) {
  return `${basename(home)}.bak-`
}
