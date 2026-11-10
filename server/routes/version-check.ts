/**
 * 更新检查的**远端读取层**（U1/task-16）：拉 GitHub tags、解析、缓存、失败姿态。
 *
 * 本模块不 import 注册表/`config`（避免与 `version.ts` 形成环）：数据源 URL、当前
 * Hub 版本、仓库基址、落后适配器集合全部由调用方注入。硬约束：
 * - **必须 https**（非 https → `invalid_url`，不出网）；
 * - 5s 超时（`AbortSignal.timeout`）、响应体分段读取并封顶（默认 512KB）；
 * - `/releases` 端点 404 或无可解析条目 → 回落同仓库 `/tags`；
 * - 失败一律 `{ok:false,error}`（由路由层以 HTTP 200 返回），**绝不** 500；
 * - 成功结果内存缓存 10 分钟（同源命中）；失败不缓存（下次可重试）；
 * - 只读远端：不执行 git/npm、不写文件、不返回可执行升级动作。
 */
import {
  compareVersionStrings,
  extractTags,
  latestTag,
  normalizeVersion,
} from "./version-semver"

/** 缺省数据源（GitHub tags；fork/镜像用 env `AGENTCHAT_UPDATE_URL` 或 `<home>/config.json` 换）。 */
export const DEFAULT_UPDATE_URL = "https://api.github.com/repos/cjznb/agentchat/tags"
/** 缺省仓库主页（比较链接基址）。 */
export const DEFAULT_REPO_URL = "https://github.com/cjznb/agentchat"
export const UPDATE_TIMEOUT_MS = 5_000
export const MAX_RESPONSE_BYTES = 512 * 1024
export const UPDATE_CACHE_TTL_MS = 600_000

const USER_AGENT = "agentchat-hub-version-check"
const RELEASES_ENDPOINT = /\/releases(\?.*)?$/

export type UpdateCheckError =
  | "invalid_url"
  | "network"
  | "timeout"
  | "too_large"
  | "http_error"
  | "no_tags"

export interface UpdateCheckSuccess {
  readonly ok: true
  readonly current: string
  readonly latest: string
  readonly updateAvailable: boolean | null
  readonly adaptersOutdated: readonly string[]
  readonly tagsChecked: number
  readonly source: string
  readonly checkedAt: number
  readonly cached: boolean
  readonly compareUrl: string
}

export interface UpdateCheckFailure {
  readonly ok: false
  readonly error: UpdateCheckError
  readonly detail?: string
  readonly current: string
  readonly source: string
  readonly checkedAt: number
}

export type UpdateCheckOutcome = UpdateCheckSuccess | UpdateCheckFailure

export interface UpdateCheckOptions {
  /** 已解析的数据源 URL（调用方负责 env / `<home>/config.json` / 默认的合并）。 */
  readonly source: string
  /** 当前 Hub 版本（`updateAvailable` 的左侧）。 */
  readonly current: string
  readonly repoUrl: string
  /** 落后适配器供应函数（注入以免本模块反向依赖注册表）。 */
  readonly outdatedVendors?: (latest: string) => readonly string[]
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly cacheTtlMs?: number
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

interface CacheEntry {
  readonly source: string
  readonly at: number
  readonly result: UpdateCheckSuccess
}

let cache: CacheEntry | undefined
let lastCheckedAt: number | undefined

/** 最近一次**成功**检查的时间（`/api/version` 的 `checkedAt`）；从未成功 → undefined。 */
export function lastCheckAt(): number | undefined {
  return lastCheckedAt
}

/** 测试隔离：清空检查缓存（生产进程只读该缓存，无需清理）。 */
export function clearUpdateCache(): void {
  cache = undefined
  lastCheckedAt = undefined
}

function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:"
  } catch {
    return false
  }
}

function isReleasesEndpoint(url: string): boolean {
  return RELEASES_ENDPOINT.test(url)
}

function tagsEndpoint(url: string): string {
  return url.replace(RELEASES_ENDPOINT, "/tags")
}

/** 分段读取并按字节数封顶（超限 → undefined，绝不把整个响应吃进内存）。 */
async function readBoundedText(response: Response, limit: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) return undefined
  const body = response.body
  if (body === null) {
    const text = await response.text()
    return new TextEncoder().encode(text).byteLength > limit ? undefined : text
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function compareUrlOf(latest: string, options: UpdateCheckOptions): string {
  const repo = options.repoUrl.replace(/\/+$/, "")
  const current = normalizeVersion(options.current)
  const target = normalizeVersion(latest)
  return current === undefined || target === undefined
    ? repo
    : `${repo}/compare/v${current}...v${target}`
}

/** 单次远端读取（含 `/releases` → `/tags` 的一次回落）；不做缓存。 */
async function fetchTags(options: UpdateCheckOptions): Promise<UpdateCheckOutcome> {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? UPDATE_TIMEOUT_MS
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES
  const fetchImpl = options.fetchImpl ?? fetch
  let url = options.source
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fail = (error: UpdateCheckError, detail?: string): UpdateCheckFailure => ({
      ok: false,
      error,
      current: options.current,
      source: url,
      checkedAt: now(),
      ...(detail === undefined ? {} : { detail }),
    })
    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ""
      const detail = error instanceof Error ? error.message : String(error)
      return name === "TimeoutError" || name === "AbortError"
        ? fail("timeout", `超过 ${timeoutMs}ms 未响应`)
        : fail("network", detail)
    }
    const fallback = attempt === 0 && isReleasesEndpoint(url)
    if (!response.ok) {
      if (fallback) {
        url = tagsEndpoint(url)
        continue
      }
      return fail("http_error", `HTTP ${response.status}`)
    }
    const text = await readBoundedText(response, maxBytes)
    if (text === undefined) return fail("too_large", `响应超过 ${maxBytes} 字节`)
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      payload = undefined
    }
    const tags = extractTags(payload)
    if (tags.length === 0) {
      if (fallback) {
        url = tagsEndpoint(url)
        continue
      }
      return fail("no_tags", "远端没有可解析的 tag")
    }
    const latest = latestTag(tags)
    if (latest === undefined) return fail("no_tags", "tag 都不是 semver")
    const compared = compareVersionStrings(options.current, latest)
    return {
      ok: true,
      current: options.current,
      latest,
      updateAvailable: compared === undefined ? null : compared < 0,
      adaptersOutdated: (options.outdatedVendors ?? (() => []))(latest),
      tagsChecked: tags.length,
      source: url,
      checkedAt: now(),
      cached: false,
      compareUrl: compareUrlOf(latest, options),
    }
  }
  return {
    ok: false,
    error: "network",
    detail: "更新检查未完成",
    current: options.current,
    source: url,
    checkedAt: now(),
  }
}

/**
 * 执行一次更新检查：命中缓存（同源、TTL 内）直接返回上次成功结果并置 `cached:true`；
 * 失败不缓存（下次可重试）。**只读远端 tags，不做任何写操作。**
 */
export async function runUpdateCheck(options: UpdateCheckOptions): Promise<UpdateCheckOutcome> {
  const now = options.now ?? Date.now
  if (!isHttpsUrl(options.source)) {
    return {
      ok: false,
      error: "invalid_url",
      detail: "更新检查数据源必须是 https URL",
      current: options.current,
      source: options.source,
      checkedAt: now(),
    }
  }
  const ttl = options.cacheTtlMs ?? UPDATE_CACHE_TTL_MS
  if (cache !== undefined && cache.source === options.source && now() - cache.at < ttl) {
    return { ...cache.result, cached: true }
  }
  const outcome = await fetchTags(options)
  if (outcome.ok) {
    cache = { source: options.source, at: outcome.checkedAt, result: outcome }
    lastCheckedAt = outcome.checkedAt
  }
  return outcome
}
