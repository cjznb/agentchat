/**
 * 版本接口访问层（UI-1 ⑥）——`GET /api/version`（只读）与 `POST /api/version/check`（点按钮才出网）。
 *
 * 与 `api.ts` 的差异（有意）：`/api/version/check` **失败也返回 HTTP 200**，错误码在 body 里
 * （`{ok:false,error}`），所以这里必须解析 body 而不是只看状态码；网络层失败（fetch reject）、
 * 非 2xx、body 形状不符 → 抛错，由组件显示"无法读取版本信息"，绝不装作成功。
 */
import { ApiError } from "./api"
import {
  versionCheckSchema,
  versionErrorSchema,
  versionInfoSchema,
  type CheckOutcome,
  type VersionInfo,
} from "./version"

const JSON_HEADERS = { "content-type": "application/json" } as const

/** 读取版本概览（`GET /api/version`；无鉴权、只读）。非 2xx / 形状不符 → 抛 `ApiError`。 */
export async function loadVersion(signal?: AbortSignal): Promise<VersionInfo> {
  const path = "/api/version"
  const response = await fetch(path, signal === undefined ? undefined : { signal })
  if (!response.ok) throw new ApiError(path, response.status)
  const payload: unknown = await response.json().catch(() => undefined)
  const parsed = versionInfoSchema.safeParse(payload)
  if (!parsed.success) throw new ApiError(path, response.status, "invalid_version_payload")
  return parsed.data
}

/**
 * 检查更新（`POST /api/version/check`）。**成功与业务失败都不抛**（返回判别联合），
 * 只有传输层/形状问题才抛错 —— 组件据 `ok` 分流成结果区或错误文案。
 */
export async function checkVersion(signal?: AbortSignal): Promise<CheckOutcome> {
  const path = "/api/version/check"
  const response = await fetch(path, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new ApiError(path, response.status)
  const payload: unknown = await response.json().catch(() => undefined)
  const ok = versionCheckSchema.safeParse(payload)
  if (ok.success) return { ok: true, value: ok.data }
  const failed = versionErrorSchema.safeParse(payload)
  if (failed.success) return { ok: false, code: failed.data.error }
  throw new ApiError(path, response.status, "invalid_version_payload")
}
