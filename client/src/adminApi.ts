/**
 * 管理端点客户端（设置面板用）：`GET /api/admin/info` 与 `POST /api/admin/reset`。
 * 与 `api.ts` 同法边界解析；单独成文件以免把通用 API 客户端推过纯行上限。
 */
import {
  adminInfoSchema,
  resetResultSchema,
  type AdminInfo,
  type ResetResult,
} from "../../shared/contracts"
import { ApiError } from "./api"

const RESET_PATH = "/api/admin/reset"

/** 从非 2xx 响应体安全提取服务端错误码（缺失/非字符串 → undefined）。 */
function errorCodeOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const code = (body as { readonly error?: unknown }).error
  return typeof code === "string" ? code : undefined
}

export async function loadAdminInfo(signal?: AbortSignal): Promise<AdminInfo> {
  const response = await fetch("/api/admin/info", signal === undefined ? undefined : { signal })
  if (!response.ok) throw new ApiError("/api/admin/info", response.status)
  return adminInfoSchema.parse(await response.json())
}

/** 恢复出厂设置：`confirm` 必须精确 `RESET`；失败抛携带服务端错误码的 `ApiError`。 */
export async function resetHub(confirm: string, keepBackups?: boolean): Promise<ResetResult> {
  const response = await fetch(RESET_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm, ...(keepBackups === undefined ? {} : { keepBackups }) }),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new ApiError(RESET_PATH, response.status, errorCodeOf(body))
  return resetResultSchema.parse(body)
}
