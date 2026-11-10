/**
 * 测试适配器场景注册表（`adapters/test/lib/scenarios.mjs`）—— CLI 与 vitest 的唯一入口。
 *
 * 每个场景签名 `(ctx) => Promise<void>`，`ctx = {host, report, args, advanceLease?}`：
 * - `host` = `createTestHost` 的无头假宿主（复用 dsh 真客户端 + 真 flush 闭环，只替换"注入宿主"一步）；
 * - `report` = `createReporter` 的报告器（每步一行 + 状态迁移表 + PASS/FAIL）；
 * - `args` = CLI 参数（`holdMs` 忙碌观察窗、`leaseWaitMs` 租约等待，供测试注入时间口径）；
 * - `advanceLease`（可选）= "把 now 推过在途租约"的注入点：CLI 不传（真实等待），
 *   vitest 传（直改 `wake_jobs.retry_at`，等价且不 sleep 30s）。
 *
 * 断言口径与 task-6 描述逐条对齐：**发送即排队（job pending）→ flush/轮询才送达（accepted）**；
 * 全程只走真实代码路径（MCP 工具、`/internal/*`、`/api/test/*` 测试面驱动真实 core）。
 *
 * 拆文件说明（本仓红线「单文件 ≤ 250 纯行」）：场景本体按主题分到
 * `scenarios-messaging.mjs`（dm/group/busy/refused）与 `scenarios-lifecycle.mjs`
 * （lease/offline/shout/logical/states），共享件在 `scenario-kit.mjs`；三模块无环。
 */
import { scenarioBusy, scenarioDm, scenarioGroup, scenarioRefused } from "./scenarios-messaging.mjs"
import {
  scenarioLease,
  scenarioLogical,
  scenarioOffline,
  scenarioShout,
  scenarioStates,
} from "./scenarios-lifecycle.mjs"

export { CLAIM_TIMEOUT_MS, REFUSAL_LIMIT } from "./scenario-kit.mjs"

/** 场景注册表（`all` 按 `SCENARIO_NAMES` 顺序跑）。 */
export const SCENARIOS = {
  dm: scenarioDm,
  group: scenarioGroup,
  busy: scenarioBusy,
  refused: scenarioRefused,
  lease: scenarioLease,
  offline: scenarioOffline,
  shout: scenarioShout,
  logical: scenarioLogical,
  states: scenarioStates,
}

export const SCENARIO_NAMES = [
  "dm",
  "group",
  "busy",
  "refused",
  "lease",
  "offline",
  "shout",
  "logical",
  "states",
]
