/**
 * 消息 Markdown 渲染范围（纯逻辑，无 DOM）：
 * - `agentchat:mdScope`：all / agent / off 三档持久化
 * - `defaultMdView`：范围 × 消息归属 → 单条消息初始视图（md/raw）
 * - `subscribe`/`notify`：范围变更即时广播（设置块改值后触发，无需刷新）
 * 存储容错风格同 accordion.ts：storage 缺失/异常 → 安全默认，不打断交互。
 */
import type { StorageLike } from "./accordion"
import { LOCAL_STORAGE_PREFIX } from "./settings"

/** 渲染范围：全部 / 仅 AI 回复 / 关闭。 */
export type MdScope = "all" | "agent" | "off"

/** 持久化键（沿仓内 `agentchat:` 前缀惯例，前缀归属地为 settings.ts）。 */
export const STORAGE_KEY = `${LOCAL_STORAGE_PREFIX}mdScope`

function isMdScope(value: unknown): value is MdScope {
  return value === "all" || value === "agent" || value === "off"
}

/** 读范围；缺失/非法值/storage 异常 → 回落 "all"。 */
export function readMdScope(storage: StorageLike | null): MdScope {
  if (storage === null) return "all"
  try {
    const raw = storage.getItem(STORAGE_KEY)
    return isMdScope(raw) ? raw : "all"
  } catch {
    return "all"
  }
}

/** 写范围；storage 缺失/配额异常吞掉（不影响交互）。 */
export function writeMdScope(storage: StorageLike | null, scope: MdScope): void {
  if (storage === null) return
  try {
    storage.setItem(STORAGE_KEY, scope)
  } catch {
    /* 存储不可用：忽略 */
  }
}

/** 范围 × 消息归属 → 初始视图：all→md；agent→仅 AI 消息 md；off→raw。 */
export function defaultMdView(scope: MdScope, isAgentMessage: boolean): "md" | "raw" {
  if (scope === "all") return "md"
  if (scope === "agent") return isAgentMessage ? "md" : "raw"
  return "raw"
}

/** 模块级订阅集（订阅方自行退订，防泄漏）。 */
const listeners = new Set<(scope: MdScope) => void>()

/** 订阅范围变更，返回退订函数。 */
export function subscribe(fn: (scope: MdScope) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 广播范围变更（写入后由调用方触发；遍历副本防迭代中增删）。 */
export function notify(scope: MdScope): void {
  for (const fn of [...listeners]) fn(scope)
}
