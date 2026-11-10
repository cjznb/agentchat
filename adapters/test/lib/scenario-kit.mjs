/**
 * 场景库共享工具（`adapters/test/lib/scenario-kit.mjs`）—— 拆出自 `scenarios.mjs` 的通用件：
 * 生产常量镜像、dump 行读取、状态迁移记录、夹具装配与"各注入恰一次"断言。
 *
 * 拆文件的原因：本仓红线「单文件 ≤ 250 纯行」（CONTRIBUTING.md）；场景本体按主题分到
 * `scenarios-messaging.mjs`（dm/群/忙碌/拒收）与 `scenarios-lifecycle.mjs`（租约/离线/
 * 喊话/逻辑/状态）。三个模块**无环**：只有 kit 被场景模块 import，kit 不 import 场景。
 */
import { shortId } from "./report.mjs"

/** 在途租约（与 `server/store/wake.ts:42` 的 `CLAIM_TIMEOUT_MS` 同值；生产冻结常量）。 */
export const CLAIM_TIMEOUT_MS = 30_000
/** 连续拒收达该次数 → 终态 `refused`（与 `server/store/wake.ts:40` 的 `REFUSAL_LIMIT` 同值）。 */
export const REFUSAL_LIMIT = 2

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * **跨进程时钟允许偏斜（ms）**：`retry_at` 由 **Hub 进程**用它的 `Date.now()` 写，客户端采样
 * 必然可能晚几毫秒（HTTP 往返 + 采样点不同）。因此"到期 / 未到期"一律按容差判，
 * **绝不写裸 `job.retry_at <= Date.now()`** —— `--scenario all` 连跑（负载更高）时会随机踩中
 * （task-6 复审实测：单跑全绿、连跑偶发 busy/offline 各掉 1 项）。
 */
export const CLOCK_SKEW_MS = 1_000

/** 到期判据（跨进程安全）：`retry_at <= 客户端 now + CLOCK_SKEW_MS`。 */
export function isDue(job, now = Date.now()) {
  return job !== undefined && job.retry_at <= now + CLOCK_SKEW_MS
}

/** 到期判据的可诊断证据：同时给客户端 `now`、服务端 `retry_at` 与差值（失败时一眼看出谁快谁慢）。 */
export function dueEvidence(job, now = Date.now()) {
  if (job === undefined) return "无 job 行"
  return (
    `clientNow=${now} serverRetryAt=${job.retry_at} ` +
    `delta(client-server)=${now - job.retry_at}ms 容差=${CLOCK_SKEW_MS}ms`
  )
}

/**
 * 预热 pull 登记：对任一已注册节点调一次**真** `/internal/wake`（无消息 → 空返回），
 * Hub 侧 `ensurePullAdapter(vendor)` 随即把该 vendor 登记为 pull 适配器——这正是真实
 * dsh/opencode 适配器首次取件时的行为。此后 dispatcher 把它排除出派发窗口
 * （`core/dispatcher.ts` 的 `dueWakeJobs(..., pullAdapterIds())`），不会再用 2s tick 的
 * `deferWakeJob` 改写我们 job 的 `attempts/retry_at/pending_reason` 而与断言抢时序。
 *
 * 为什么必须预热：`makeJobsDue` 把 `retry_at` 置为服务端 now 后，dispatcher 若在客户端下一次
 * 采样之前 tick 到，会把 `retry_at` 推到 `now + backoff(attempts)`（≥1s，第二次 ≥2s）——
 * 那会让"已到期"断言在**同一台机器上**也随机失败，且与时钟偏斜无关。
 */
export async function warmPull(ctx, agentId) {
  await ctx.host.hub.wake(agentId)
}

/** 轮询等待 `predicate` 为真（真 `IdlePoller` 是定时器驱动，断言必须等而不是立刻读）。 */
export async function waitFor(predicate, timeoutMs = 4_000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await predicate()) === true) return true
    if (Date.now() >= deadline) return false
    await sleep(stepMs)
  }
}

/** dump 的 `wake_jobs` 原始行（列名 snake_case；无行 → undefined）。 */
export function jobRow(dump, seq, agentId) {
  return dump.wakeJobs.find((job) => job.message_id === seq && job.agent_id === agentId)
}

/** dump 的 `agents` 原始行。 */
export function agentRow(dump, agentId) {
  return dump.agents.find((agent) => agent.id === agentId)
}

/** job 行的一行人读文本（报告/断言失败详情用）。 */
export function jobText(job) {
  return job === undefined
    ? "无 job 行"
    : `state=${job.state} attempts=${job.attempts} pending_reason=${job.pending_reason} retry_at=${job.retry_at}`
}

/** 记一条状态迁移（回执阶段用真 `message_status` 派生，job 行取 dump 原始行）。 */
export async function row(ctx, label, messageId, seq, agentId, taskRef) {
  const [dump, stages] = await Promise.all([
    ctx.host.dump(),
    ctx.host.receiptsOf([messageId], taskRef),
  ])
  ctx.report.transition({
    at: Date.now(),
    label,
    messageId,
    agentId,
    stage: stages.get(`${messageId}:${agentId}`) ?? "queued(无 job 行)",
    job: jobRow(dump, seq, agentId),
  })
}

/** 清库 + 建实例根（`role_tag:'container'`）+ 建若干 runtime 会话（默认挂实例根下，都 online）。 */
export async function setup(ctx, taskRefs) {
  await ctx.host.reset()
  const root = await ctx.host.registerRoot({ name: "root" })
  const sessions = {}
  for (const taskRef of taskRefs) {
    sessions[taskRef] = await ctx.host.registerSession({ taskRef, name: taskRef })
  }
  // 预热 pull 登记（见 `warmPull`）：让后续断言不受 dispatcher 2s tick 的 defer 干扰。
  await warmPull(ctx, root.agentId)
  return { root, sessions }
}

/** 断言一组会话的注入各恰一次（可选 `count` = 期望注入文本里出现的 messageId）。 */
export function expectDeliveredExactlyOnce(ctx, label, spec) {
  const { host, report } = ctx
  for (const { session, count } of spec) {
    const injected = host.injectionsOf(session.agentId)
    report.check(
      `${label}：${shortId(session.agentId)} 注入恰 1 次`,
      injected.length === 1,
      `实际 ${injected.length} 次 outcome=${injected.map((entry) => entry.outcome).join(",")}`,
    )
    if (count !== undefined) {
      report.check(`${label}：注入文本含 messageId`, host.injectedIdsOf(session.agentId)[0] === count)
    }
  }
}
