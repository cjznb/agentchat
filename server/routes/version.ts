/**
 * 版本面与更新检查路由（U1/task-16）：`GET /api/version`（只读、无鉴权，与 `/api/health`
 * 同级）与 `POST /api/version/check`（**显式触发**，无后台轮询）。
 *
 * 本模块只做「本地版本事实 + 选项解析 + 路由」；semver 单源在 `version-semver.ts`，
 * 远端读取/超时/上限/缓存/失败姿态在 `version-check.ts`。
 * （CONTRIBUTING.md:80「单文件 ≤ 250 纯行」——三者按职责拆分。）
 *
 * - Hub 版本读仓库 `package.json`，**import 时读一次**；读不到 = `"unknown"`，绝不崩。
 * - 适配器版本来自**进程内注册表**（`recordAdapterVersion`，不建表/不迁移）：适配器在
 *   `register` 的 `adapter_version`（additive）里上报；老适配器不带 → 显示 `null` 不报错。
 *   `bundledVersion` 读 `adapters/<vendor>/package.json`。
 * - 检查只做读取与呈现：不执行 git/npm、不写文件、不返回可执行升级动作。
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Hono } from "hono"
import { CONFIG_FILE_NAME, config } from "../config"
import {
  DEFAULT_REPO_URL,
  DEFAULT_UPDATE_URL,
  lastCheckAt,
  runUpdateCheck,
  type UpdateCheckOptions,
} from "./version-check"
import { compareVersionStrings } from "./version-semver"

// 单入口再导出：适配器上报（task-14 在 register 路径调用）、测试隔离、semver 单源都从本模块取。
export { clearUpdateCache, lastCheckAt } from "./version-check"
export type { UpdateCheckError, UpdateCheckOutcome, UpdateCheckSuccess } from "./version-check"
export {
  compareSemver,
  compareVersionStrings,
  extractTags,
  latestTag,
  normalizeVersion,
  parseSemver,
} from "./version-semver"

/** 厂商 id 白名单：拼 `adapters/<vendor>/package.json` 前挡住路径穿越。 */
const VENDOR_ID = /^[a-z0-9][a-z0-9._-]*$/i

// ── Hub 自身版本 ─────────────────────────────────────────────────

export interface HubManifest {
  readonly name: string
  readonly version: string
}

function readHubManifest(): HubManifest {
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
    const record = parsed as { name?: unknown; version?: unknown }
    return {
      name: typeof record.name === "string" && record.name !== "" ? record.name : "agentchat",
      version: typeof record.version === "string" && record.version !== "" ? record.version : "unknown",
    }
  } catch {
    return { name: "agentchat", version: "unknown" }
  }
}

/** Hub 自身清单（import 时读一次；文件缺失/损坏 → `agentchat@unknown`，不崩）。 */
export const HUB_MANIFEST: HubManifest = readHubManifest()

/** `adapters/<vendor>/package.json` 的 version（不存在/不可解析 → null）。 */
export function bundledAdapterVersion(vendor: string): string | null {
  if (!VENDOR_ID.test(vendor)) return null
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL(`../../adapters/${vendor}/package.json`, import.meta.url), "utf8"),
    )
    const version = (parsed as { version?: unknown }).version
    return typeof version === "string" && version !== "" ? version : null
  } catch {
    return null
  }
}

// ── 适配器版本注册表（进程内；register 路径调用，见 task-14） ──────

export interface AdapterVersionRecord {
  readonly version: string
  readonly reportedAt: number
}

const adapterVersions = new Map<string, AdapterVersionRecord>()

/** 记录适配器上报的版本（`vendor`/`version` 为空即忽略；重复上报覆盖）。 */
export function recordAdapterVersion(vendor: string, version: string, now: number = Date.now()): void {
  const trimmedVendor = vendor.trim()
  const trimmedVersion = version.trim()
  if (trimmedVendor === "" || trimmedVersion === "") return
  adapterVersions.set(trimmedVendor, { version: trimmedVersion, reportedAt: now })
}

export function adapterVersionRecord(vendor: string): AdapterVersionRecord | undefined {
  return adapterVersions.get(vendor)
}

/** 测试隔离：清空进程内注册表（生产进程只增不改，无需清理）。 */
export function clearAdapterVersions(): void {
  adapterVersions.clear()
}

// ── 选项与解析 ───────────────────────────────────────────────────

export interface VersionRoutesOptions {
  /** 数据源；缺省 env `AGENTCHAT_UPDATE_URL` > `<home>/config.json` 的 `updateCheck.url` > 默认。 */
  readonly updateUrl?: string
  /** 仓库主页（比较链接基址）。 */
  readonly repoUrl?: string
  /** fetch 注入（测试用；缺省全局 fetch）。 */
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  /** 展示的适配器厂商（缺省 `config.adapters`；注册表里有上报的厂商恒包含）。 */
  readonly vendors?: readonly string[]
  /** 读 `<home>/config.json` 的目录（缺省 `config.home`）。 */
  readonly homeDir?: string
  readonly cacheTtlMs?: number
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

function firstText(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value.trim()
  }
  return undefined
}

/** `<home>/config.json` 的 `updateCheck.url`（只读、尽力而为；Hub 不创建该文件）。 */
function fileUpdateUrl(homeDir: string): string | undefined {
  const path = join(homeDir, CONFIG_FILE_NAME)
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (parsed === null || typeof parsed !== "object") return undefined
    const updateCheck = (parsed as { updateCheck?: unknown }).updateCheck
    if (updateCheck === null || typeof updateCheck !== "object") return undefined
    const url = (updateCheck as { url?: unknown }).url
    return typeof url === "string" && url.trim() !== "" ? url.trim() : undefined
  } catch {
    return undefined
  }
}

function resolveUpdateUrl(options: VersionRoutesOptions): string {
  return (
    firstText(options.updateUrl, process.env["AGENTCHAT_UPDATE_URL"]) ??
    fileUpdateUrl(options.homeDir ?? config.home) ??
    DEFAULT_UPDATE_URL
  )
}

function resolveRepoUrl(options: VersionRoutesOptions): string {
  return (firstText(options.repoUrl) ?? DEFAULT_REPO_URL).replace(/\/+$/, "")
}

/** 展示的厂商 = 配置厂商 ∪ 已上报厂商（排序去重）。 */
function vendorList(options: VersionRoutesOptions): string[] {
  const vendors = new Set<string>(options.vendors ?? config.adapters)
  for (const vendor of adapterVersions.keys()) vendors.add(vendor)
  return [...vendors].sort()
}

/** 严格更旧（任一侧不可解析 → false）。 */
function comparesAsOlder(value: string | null | undefined, against: string): boolean {
  if (value === null || value === undefined) return false
  const compared = compareVersionStrings(value, against)
  return compared !== undefined && compared < 0
}

/**
 * 检查响应的 `adaptersOutdated`（口径经过实测收敛，见 docs/versioning.md §1）：
 * - **运行版落后于本机内置版** → 列入（运行中的适配器是旧的，与 Hub 版本无关）；
 * - **内置版落后于最新 tag 且 Hub 本身也落后** → 列入（升级 Hub 时一并更新适配器）；
 * - Hub 已是最新时**不**因「适配器版本号与 Hub 不同号」误报（实测：内置 0.1.0 vs Hub 0.2.0）。
 */
function outdatedVendors(latest: string, options: VersionRoutesOptions): string[] {
  const hubBehind = comparesAsOlder(HUB_MANIFEST.version, latest)
  const outdated: string[] = []
  for (const vendor of vendorList(options)) {
    const reported = adapterVersions.get(vendor)?.version
    const bundled = bundledAdapterVersion(vendor)
    const runningStale = reported !== undefined && bundled !== null && comparesAsOlder(reported, bundled)
    const bundleStale = hubBehind && comparesAsOlder(bundled, latest)
    if (runningStale || bundleStale) outdated.push(vendor)
  }
  return outdated
}

// ── GET /api/version ─────────────────────────────────────────────

export interface AdapterVersionView {
  readonly vendor: string
  readonly version: string | null
  readonly bundledVersion: string | null
  readonly outdated: boolean | null
  readonly reportedAt: number | null
}

export interface VersionSnapshot {
  readonly ok: true
  readonly hub: {
    readonly name: string
    readonly version: string
    readonly commit?: string
    readonly compareUrl: string
  }
  readonly adapters: readonly AdapterVersionView[]
  /** 最近一次**成功**更新检查的时间（未检查过 → null）。 */
  readonly checkedAt: number | null
}

/** `/api/version` 载荷：hub 自身版本 + 每个厂商的上报/内置版本与落后判定。 */
export function versionSnapshot(options: VersionRoutesOptions = {}): VersionSnapshot {
  const adapters = vendorList(options).map((vendor): AdapterVersionView => {
    const record = adapterVersions.get(vendor)
    const bundled = bundledAdapterVersion(vendor)
    const compared =
      record === undefined || bundled === null
        ? undefined
        : compareVersionStrings(record.version, bundled)
    return {
      vendor,
      version: record?.version ?? null,
      bundledVersion: bundled,
      outdated: compared === undefined ? null : compared !== 0,
      reportedAt: record?.reportedAt ?? null,
    }
  })
  const commit = firstText(process.env["AGENTCHAT_COMMIT"])
  return {
    ok: true,
    hub: {
      name: HUB_MANIFEST.name,
      version: HUB_MANIFEST.version,
      ...(commit === undefined ? {} : { commit }),
      compareUrl: resolveRepoUrl(options),
    },
    adapters,
    checkedAt: lastCheckAt() ?? null,
  }
}

// ── POST /api/version/check ──────────────────────────────────────

/** 把路由选项映射为远端读取层选项（数据源/当前版本/仓库基址/落后集）。 */
export function updateCheckOptions(options: VersionRoutesOptions = {}): UpdateCheckOptions {
  const base: UpdateCheckOptions = {
    source: resolveUpdateUrl(options),
    current: HUB_MANIFEST.version,
    repoUrl: resolveRepoUrl(options),
    outdatedVendors: (latest) => outdatedVendors(latest, options),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
  }
  return base
}

/**
 * `/api/version*` 路由：GET 只读快照；POST check 显式触发。
 * 检查失败也是 **HTTP 200 + `{ok:false,error}`**（客户端按 body 判定），绝不 500。
 */
export function versionRoutes(options: VersionRoutesOptions = {}): Hono {
  return new Hono()
    .get("/api/version", (c) => c.json(versionSnapshot(options)))
    .post("/api/version/check", async (c) => c.json(await runUpdateCheck(updateCheckOptions(options))))
}
