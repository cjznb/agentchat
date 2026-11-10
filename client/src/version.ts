/**
 * 「版本与更新」纯逻辑（UI-1 ⑥）——Hub `GET /api/version` / `POST /api/version/check` 的
 * 出参解析、更新源错误码文案、展示派生。零副作用、零 fetch（网络在 `versionApi.ts`）。
 *
 * 契约（Hub 侧 `feat/version` 已落地，UI 只按此消费）：
 * - `GET /api/version` → `{ok:true, hub:{name,version,compareUrl}, adapters:[…], checkedAt}`
 * - `POST /api/version/check` → `{ok:true, current, latest, updateAvailable, adaptersOutdated,
 *   tagsChecked, source, checkedAt, cached, compareUrl}`；**失败也是 HTTP 200** →
 *   `{ok:false, error:"network|timeout|no_tags|invalid_url|http_error|too_large"}`
 *
 * schema 就近定义在本模块：`shared/contracts.ts` 属 Hub 契约的单一源，本轮 UI 任务不允许改它。
 */
import { z } from "zod"

/** `GET /api/version` 的适配器条目。 */
export const adapterVersionSchema = z.object({
  vendor: z.string(),
  /** 适配器**上报**的版本；从未上报 → null。 */
  version: z.string().nullable(),
  /** 随 Hub 内置的版本（用于对照）。 */
  bundledVersion: z.string().nullable(),
  /** null = 无法判定（未上报/内置版本未知）；true = 落后。 */
  outdated: z.boolean().nullable(),
  reportedAt: z.number().int().nonnegative().nullable(),
})
export type AdapterVersion = z.infer<typeof adapterVersionSchema>

export const versionInfoSchema = z.object({
  ok: z.literal(true),
  hub: z.object({
    name: z.string(),
    version: z.string(),
    compareUrl: z.string(),
  }),
  adapters: z.array(adapterVersionSchema),
  checkedAt: z.number().int().nonnegative().nullable(),
})
export type VersionInfo = z.infer<typeof versionInfoSchema>

export const versionCheckSchema = z.object({
  ok: z.literal(true),
  current: z.string(),
  latest: z.string(),
  updateAvailable: z.boolean(),
  adaptersOutdated: z.array(adapterVersionSchema),
  tagsChecked: z.number().int().nonnegative(),
  source: z.string(),
  checkedAt: z.number().int().nonnegative(),
  cached: z.boolean(),
  compareUrl: z.string(),
})
export type VersionCheck = z.infer<typeof versionCheckSchema>

/** 检查更新的失败码（HTTP 200 的 `{ok:false,error}`）。 */
export const UPDATE_ERROR_CODES = [
  "network",
  "timeout",
  "no_tags",
  "invalid_url",
  "http_error",
  "too_large",
] as const
export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number]

export const versionErrorSchema = z.object({ ok: z.literal(false), error: z.string() })

/** 检查更新失败的判别联合（组件按 `ok` 分流，绝不 toast 成"服务器错误"）。 */
export type CheckOutcome = { readonly ok: true; readonly value: VersionCheck } | { readonly ok: false; readonly code: string }

/** 失败码 → 用户可自诊文案（未知码回落通用文案，不谎报成功）。 */
export function updateErrorMessage(code: string | undefined): string {
  switch (code) {
    case "no_tags":
      return "更新源仓库还没有发布任何 tag，暂时无法比较版本。"
    case "network":
      return "网络不可用（无法访问更新源），请稍后重试。"
    case "timeout":
      return "更新源响应超时，请稍后重试。"
    case "invalid_url":
      return "更新源地址不合法：必须使用 https。"
    case "http_error":
      return "更新源返回了错误状态，请稍后重试。"
    case "too_large":
      return "更新源响应过大，已放弃解析。"
    default:
      return "检查更新失败，请稍后重试。"
  }
}

/** 适配器版本状态（①）：已上报且落后 → outdated；未上报 → unknown。 */
export type AdapterState = "outdated" | "current" | "unknown"

export function adapterStateOf(adapter: AdapterVersion): AdapterState {
  if (adapter.version === null) return "unknown"
  if (adapter.outdated === true) return "outdated"
  return "current"
}

/** 适配器状态文案：outdated 走红字，确定最新走中性，未上报明确写"未上报"。 */
export function adapterStateLabel(state: AdapterState): string {
  if (state === "outdated") return "有更新"
  if (state === "current") return "最新"
  return "未上报"
}

/** 适配器版本展示（`内置 vX · 上报 vY / 未上报`）。 */
export function adapterVersionText(adapter: AdapterVersion): string {
  const bundled = adapter.bundledVersion === null ? "未知" : `v${adapter.bundledVersion}`
  const reported = adapter.version === null ? "未上报" : `v${adapter.version}`
  return `内置 ${bundled} · 上报 ${reported}`
}

/** 本地时刻 `YYYY-MM-DD HH:MM`（`checkedAt` 展示）。 */
export function formatCheckedAt(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** ③ 手动升级步骤（**不做一键升级**：UI 没有升级动作，只给可复制的步骤）。 */
export const MANUAL_UPGRADE_STEPS = [
  "在 Hub 检出目录执行 git pull（或切到目标 tag）",
  "重新安装依赖并构建：npm install && npm run build",
  "重启 Hub 进程；适配器侧重新安装以同步内置版本",
] as const
