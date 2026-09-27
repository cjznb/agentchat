/**
 * 厂商适配器接缝（spec §10 `VendorAdapter` + 计划文件结构「接口 + 注册表」）。
 *
 * - `start()` / `inject()`：hub → 适配器（dispatcher 经进程内接口调用，测试注入 fake）
 * - `reportState()`：适配器 → hub 的状态上报入口（fake 直连 `/internal/state` 同款处理器，
 *   真实适配器在独立进程经 `POST /internal/state` 上报）
 * - 注册表按 `agents.vendor` 匹配适配器 id；无适配器 = 无推送通道
 *   （收件方消息由 `POST /internal/wake` 拉取时补建 job，见 store/wake）
 * - `mode`：`"push"`（默认，dispatcher 主动注入）/ `"pull"`（进程外适配器自行拉取，
 *   dispatcher 只登记可用性、绝不注入，job 留给 `/internal/wake` 认领）
 */
import { z } from "zod"
import type { Message } from "../store/messages"

/** 适配器上报状态（spec §10：回合始/终上报；`idle` 在 hub 侧映射为 `online`）。 */
export const ADAPTER_STATES = ["online", "busy", "idle", "offline"] as const
export type AdapterState = (typeof ADAPTER_STATES)[number]
export const adapterStateSchema = z.enum(ADAPTER_STATES)

/** 注入结果（spec §10：`inject` 是唯一“打进宿主”入口）。 */
export type AdapterInjectResult = "delivered" | "refused"

/** 适配器投递模式：`push` = hub 主动注入；`pull` = 进程外自行拉取（dispatcher 不注入）。 */
export const ADAPTER_MODES = ["push", "pull"] as const
export type AdapterMode = (typeof ADAPTER_MODES)[number]

export interface VendorAdapter {
  readonly id: string
  /** 缺省 `"push"`（既有 fake 行为零变更）。 */
  readonly mode?: AdapterMode
  start(): void
  reportState(nodeId: string, state: AdapterState): void
  inject(nodeId: string, msgs: readonly Message[]): Promise<AdapterInjectResult>
}

// 进程内适配器注册表（单进程 hub；测试 `clearAdapters()` 隔离）。
const registry = new Map<string, VendorAdapter>()

export function registerAdapter(adapter: VendorAdapter): void {
  registry.set(adapter.id, adapter)
}

/** 按 `agents.vendor` 查找适配器；未注册 → 无推送通道。 */
export function adapterFor(vendor: string): VendorAdapter | undefined {
  return registry.get(vendor)
}

/**
 * 进程外 pull 占位适配器：仅表达“该厂商适配器可用，消息由适配器自行拉取”。
 * dispatcher 见 `mode === "pull"` 即跳过注入，故 `inject` 永不被调用；
 * 兜底返回 `"refused"`（若被误调也绝不挂起）。
 */
export function pullAdapter(id: string): VendorAdapter {
  return {
    id,
    mode: "pull",
    start: () => {},
    reportState: () => {},
    inject: () => Promise.resolve("refused"),
  }
}

/**
 * 按配置把每个 vendor 注册为 pull 占位（可用性登记）。
 * 已注册同 id 的适配器不覆盖——测试可先注册 push fake 抢占。
 */
export function registerConfiguredAdapters(config: {
  readonly adapters: readonly string[]
}): void {
  for (const id of config.adapters) {
    if (!registry.has(id)) registry.set(id, pullAdapter(id))
  }
}

export function clearAdapters(): void {
  registry.clear()
}
