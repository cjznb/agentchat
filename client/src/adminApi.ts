/**
 * 管理端点客户端（设置面板用）：`GET /api/admin/info`、`POST /api/admin/reset`、
 * `POST /api/admin/prune-sessions`（离线历史会话清理，预览/执行两态）。
 * 与 `api.ts` 同法边界解析；单独成文件以免把通用 API 客户端推过纯行上限。
 */
import { z } from "zod"
import {
  adminInfoSchema,
  resetResultSchema,
  type AdminInfo,
  type ResetResult,
} from "../../shared/contracts"
import { ApiError } from "./api"

const RESET_PATH = "/api/admin/reset"
const PRUNE_PATH = "/api/admin/prune-sessions"

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

/** prune 端点候选条目（预览 `candidates` / 执行 `retired` 共用形状）。 */
const pruneEntrySchema = z.object({ id: z.string(), name: z.string(), lastSeen: z.number().optional() })
const pruneResultSchema = z.object({
  ok: z.literal(true),
  count: z.number(),
  candidates: z.array(pruneEntrySchema).optional(),
  retired: z.array(pruneEntrySchema).optional(),
})

export interface PruneSessionsResult {
  readonly count: number
  readonly names: readonly string[]
}

/**
 * 清理离线历史会话：`execute:false` 预览候选（零写入），`true` 逐个退役（不可恢复）。
 * 统一返回 `{count, names}` 供设置面板渲染确认弹层与成功提示。
 */
export async function pruneSessions(execute: boolean): Promise<PruneSessionsResult> {
  const response = await fetch(PRUNE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ execute }),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new ApiError(PRUNE_PATH, response.status, errorCodeOf(body))
  const parsed = pruneResultSchema.parse(body)
  const entries = parsed.retired ?? parsed.candidates ?? []
  return { count: parsed.count, names: entries.map((entry) => entry.name) }
}
