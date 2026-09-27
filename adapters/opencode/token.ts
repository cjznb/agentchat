/**
 * join_token 文件读写（spec §5.2/§7；控制器裁决：`<home>/agents/opencode.token`）。
 *
 * 0600 **尽力而为**：Windows 上 `chmodSync` 调用成功但权限位可能不生效（与 server 侧
 * `writeTokenFile` 同策略，见 task-3 报告）。读失败（不存在/不可读）一律视为「无 token」，
 * 写失败返回 `{ok:false}` 由调用方报告后继续（不得因此中断注册）。
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** `AGENTCHAT_HOME`（空串视同未设）→ 数据目录；默认 `~/.agentchat`（与 server 一致）。 */
export function resolveHome(env: Readonly<Record<string, string | undefined>>): string {
  const home = env["AGENTCHAT_HOME"]
  return home === undefined || home === "" ? join(homedir(), ".agentchat") : home
}

/** 本适配器的 join_token 落盘路径。 */
export function tokenPath(home: string): string {
  return join(home, "agents", "opencode.token")
}

export function readToken(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim()
    return value === "" ? undefined : value
  } catch {
    return undefined
  }
}

export interface WriteTokenResult {
  readonly ok: boolean
  readonly error?: string
}

export function writeToken(path: string, token: string): WriteTokenResult {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, token, { mode: 0o600 })
    chmodSync(path, 0o600)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
