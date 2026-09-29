/**
 * join_token 文件读写（spec §5.2/§7；控制器裁决：`<home>/agents/opencode.token`）。
 *
 * 0600 **尽力而为**：Windows 上 `chmodSync` 调用成功但权限位可能不生效（与 server 侧
 * `writeTokenFile` 同策略，见 task-3 报告）。读失败（不存在/不可读）一律视为「无 token」，
 * 写失败返回 `{ok:false}` 由调用方报告后继续（不得因此中断注册）。
 *
 * `AGENTCHAT_HOME` 解析在 `home.ts`（`log.ts` 与本模块都要用，抽离以**避免 `token ↔ log` 循环依赖**）。
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { createFileLog } from "./log"

/** 本适配器的 join_token 落盘路径。 */
export function tokenPath(home: string): string {
  return join(home, "agents", "opencode.token")
}

/**
 * 本适配器注册得到的**节点 agent id** 落盘路径。
 *
 * 供本地 MCP 桥（`mcp-bridge.mjs`）**逐请求**读作 `x-agent-id`：MCP 会话（LLM 侧工具）
 * 需要节点身份才能 `send`/`respond_ask`，而该 id 在 `register` 后才由 Hub 分配且对同一
 * `join_token` 稳定，故落盘一次、后续读盘（见 docs/adapters-opencode.md）。
 */
export function agentIdPath(home: string): string {
  return join(home, "agents", "opencode.id")
}

export interface ReadTokenOptions {
  /** 总尝试次数（含首次）；默认 3。 */
  readonly attempts?: number
  /** 相邻尝试间隔毫秒；默认 20。 */
  readonly delayMs?: number
  /** 可注入读取器（单测用）；默认 `readFileSync`。 */
  readonly read?: (path: string, encoding: BufferEncoding) => string
  /** 可注入失败日志；默认落 `<home>/logs/opencode-adapter.log`（`[plugin]` 行）。 */
  readonly log?: (message: string) => void
}

/**
 * 从落盘路径反推数据目录：`<home>/agents/x` → `<home>`、`<home>/hub_token` → `<home>`
 * （两种布局都覆盖，供失败日志定位 `<home>/logs/`）。
 */
function homeForPath(path: string): string {
  const parent = dirname(path)
  return basename(parent) === "agents" ? dirname(parent) : parent
}

/** 提取 Node fs 错误码（`error.code`）；非对象/无码 → `undefined`。 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/** 同步等待（Node 主线程 / worker 均允许 `Atomics.wait`）；`ms <= 0` 立即返回。 */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 读 token / 节点 id。**`ENOENT` = 未注册 / 无 token** → 直接 `undefined`（保持既有静默语义，
 * **不重试**）；其它错误（Windows 上新建文件被 Defender 瞬时抢占的 `EPERM`/`EACCES` 等）→ 有限重试；
 * 重试仍失败则**记一条含错误码的日志**后按「无」处理（绝不抛断宿主）。
 */
export function readToken(path: string, options: ReadTokenOptions = {}): string | undefined {
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 20
  const read = options.read ?? ((target: string, encoding: BufferEncoding) => readFileSync(target, encoding))
  const log = options.log ?? createFileLog({ AGENTCHAT_HOME: homeForPath(path) }, "plugin")
  for (let attempt = 1; ; attempt += 1) {
    try {
      const value = read(path, "utf8").trim()
      return value === "" ? undefined : value
    } catch (error) {
      const code = errorCode(error)
      if (code === "ENOENT" || attempt >= attempts) {
        if (code !== "ENOENT") {
          log(`readToken: ${path} unreadable after ${attempt} attempt(s): ${code ?? String(error)}`)
        }
        return undefined
      }
      sleepSync(delayMs)
    }
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

/** 清除陈旧 token（文件不存在视为成功）；供 `invalid_join_token` 回退路径使用。 */
export function clearToken(path: string): WriteTokenResult {
  try {
    rmSync(path, { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
