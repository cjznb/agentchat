/**
 * 场景库（生命周期与广播）：`lease` / `offline` / `shout` / `logical` / `states`。
 *
 * 自 `scenarios.mjs` 按主题拆出（本仓红线「单文件 ≤ 250 纯行」）；共享件在 `scenario-kit.mjs`，
 * 注册表在 `scenarios.mjs`。全程只走真实代码路径（MCP 工具 + `/internal/*` 真闭环）。
 */
import { shortId } from "./report.mjs"
import {
  CLAIM_TIMEOUT_MS,
  CLOCK_SKEW_MS,
  agentRow,
  dueEvidence,
  expectDeliveredExactlyOnce,
  isDue,
  jobRow,
  jobText,
  row,
  setup,
  sleep,
  warmPull,
} from "./scenario-kit.mjs"

// ── lease：注入成功但"崩在回报执前"，租约内不重认领、过期后只补回执 ──
export async function scenarioLease(ctx) {
  const { host, report } = ctx
  const waitMs = ctx.args.leaseWaitMs ?? CLAIM_TIMEOUT_MS + 1_500
  const { sessions } = await setup(ctx, ["lease-a", "lease-b"])
  const a = sessions["lease-a"]
  const b = sessions["lease-b"]
  const sent = await host.send(a.taskRef, { to: b.agentId, body: "lease-hello" })
  const messageId = sent.message.id
  const seq = sent.message.seq

  host.deliver.suppressReceiptNext(1)
  await host.flush(b.agentId, b.agentId)
  const claimed = await host.jobOf(seq, b.agentId)
  const claimedStage = (await host.receiptsOf([messageId], a.taskRef)).get(`${messageId}:${b.agentId}`)
  report.check(
    "注入成功但未回报执 → job 停在 sending（在途租约，绝不算 delivered）",
    claimed?.state === "sending",
    jobText(claimed),
  )
  report.check("回执阶段 = sending（唤醒中）", claimedStage === "sending", String(claimedStage))
  report.check("注入已发生 1 次", host.injectionsOf(b.agentId).length === 1)
  // 方向性时钟判据也走容差：retry_at 由 Hub 的时钟写，客户端采样恒晚一点。
  const nowAtClaim = Date.now()
  report.check(
    `租约时限 ≈ now+CLAIM_TIMEOUT_MS(${CLAIM_TIMEOUT_MS}ms)（跨进程时钟按 ±${CLOCK_SKEW_MS}ms 容差判）`,
    claimed.retry_at > nowAtClaim + CLAIM_TIMEOUT_MS - CLOCK_SKEW_MS,
    `clientNow=${nowAtClaim} serverRetryAt=${claimed.retry_at} 剩余=${claimed.retry_at - nowAtClaim}ms`,
  )
  await row(ctx, "崩溃未回报执", messageId, seq, b.agentId, a.taskRef)

  await host.flush(b.agentId, b.agentId)
  report.check(
    "租约有效期内再 flush：不重复认领、不重复注入",
    host.injectionsOf(b.agentId).length === 1,
    `injections=${host.injectionsOf(b.agentId).length}`,
  )
  if (typeof ctx.advanceLease === "function") {
    await ctx.advanceLease()
    report.note("租约推进方式：测试注入（改 wake_jobs.retry_at，等价于把 now 推过租约）")
  } else {
    report.note(`租约推进方式：真实等待 ${waitMs}ms（CLAIM_TIMEOUT_MS=${CLAIM_TIMEOUT_MS}）`)
    await sleep(waitMs)
  }
  const expired = await host.jobOf(seq, b.agentId)
  const nowAfterWait = Date.now()
  report.check(
    "推过租约后 job 可重投（已回 pending，或 sending 且租约已过期；跨进程时钟按容差判）",
    expired?.state === "pending" || (expired?.state === "sending" && isDue(expired, nowAfterWait)),
    expired?.state === "sending" ? dueEvidence(expired, nowAfterWait) : jobText(expired),
  )

  await host.flush(b.agentId, b.agentId)
  const after = await host.jobOf(seq, b.agentId)
  report.check(
    "过期重投：seen 去重保证不重复注入已注入内容",
    host.injectionsOf(b.agentId).length === 1,
    `injections=${host.injectionsOf(b.agentId).length}`,
  )
  report.check("只补回执 → job accepted", after?.state === "accepted", jobText(after))
  const stage = (await host.receiptsOf([messageId], a.taskRef)).get(`${messageId}:${b.agentId}`)
  report.check("A 侧 B=delivered", stage === "delivered", String(stage))
  await row(ctx, "租约过期 + 补回执后", messageId, seq, b.agentId, a.taskRef)
}

// ── offline：offline 收件方仍建 job（如实记录）；回 online 后补投 ──────
export async function scenarioOffline(ctx) {
  const { host, report } = ctx
  await host.reset()
  const root = await host.registerRoot({ name: "root" })
  const a = await host.registerSession({ taskRef: "off-a", name: "off-a" })
  // 子节点永不可 offline（409 child_never_offline）→ B 用"不挂父的 runtime 根"承载 offline。
  const b = await host.registerSession({ taskRef: "off-b", name: "off-b", parentRef: null })
  await warmPull(ctx, root.agentId) // 预热 pull 登记：dispatcher 不再 defer 本场景的 job
  report.step(`A=${shortId(a.agentId)}（子会话） B=${shortId(b.agentId)}（独立 runtime 根，故可 offline）`)
  const offline = await host.setState(b.agentId, "offline")
  report.check("root-session B 上报 offline → 200（子节点此路径为 409）", offline.status === 200, `status=${offline.status}`)

  const sent = await host.send(a.taskRef, { to: b.agentId, body: "offline-hello" })
  const messageId = sent.message.id
  const seq = sent.message.seq
  const job = jobRow(await host.dump(), seq, b.agentId)
  report.check(
    "实现事实：offline 的 runtime 收件方**仍建 job**（enqueueWakeJobs 只按 kind/retired 过滤，见 store/wake.ts:160）",
    job !== undefined && job.state === "pending",
    jobText(job),
  )
  report.note(
    `offline 的 pending_reason 建行时为 null（store/wake.ts:177 只对 busy 写 'busy'）；` +
      `只有 dispatcher 的 defer（server/core/dispatcher.ts:275-277）才会补写成 'offline'——` +
      `本场景已预热 pull（dispatcher 不介入），故实测恒为 ${job?.pending_reason}`,
  )
  const stage = (await host.receiptsOf([messageId], a.taskRef)).get(`${messageId}:${b.agentId}`)
  report.check("offline 期间 A 侧 B=queued（未送达）", stage === "queued", String(stage))
  report.check("offline 期间零注入", host.deliveries.length === 0)
  await row(ctx, "offline 中（未 flush）", messageId, seq, b.agentId, a.taskRef)

  const online = await host.setState(b.agentId, "online")
  const due = await host.jobOf(seq, b.agentId)
  const nowAfterOnline = Date.now() // 采样点在响应之后；判据走跨进程容差
  report.check(
    `回 online → 200 且 makeJobsDue 已生效（跨进程时钟按 ±${CLOCK_SKEW_MS}ms 容差判）`,
    online.status === 200 && isDue(due, nowAfterOnline),
    `status=${online.status} ${dueEvidence(due, nowAfterOnline)}`,
  )
  await host.flush(b.agentId, b.agentId)
  report.check("补投送达 accepted", (await host.jobOf(seq, b.agentId))?.state === "accepted")
  await row(ctx, "回 online + flush 后", messageId, seq, b.agentId, a.taskRef)
  report.note("注意：offline 只挡 dispatcher 的 push 投递；`/internal/wake` 的 pull 认领不看 status（job 存在即可认领）")
}

// ── shout：广播会话（无 participants）对每个 runtime 收件方各建 job ────
export async function scenarioShout(ctx) {
  const { host, report } = ctx
  const { root, sessions } = await setup(ctx, ["sh-a", "sh-b", "sh-c"])
  const members = ["sh-a", "sh-b", "sh-c"].map((key) => sessions[key])
  const result = await host.shoutAsHuman("shout-hello")
  const messageId = result.message.id
  const seq = result.message.seq
  const dump = await host.dump()
  const shout = dump.conversations.find((conversation) => conversation.key === "shout")
  report.check(
    "广播会话 key='shout' 且无 participants 行",
    shout !== undefined && dump.participants.filter((p) => p.conversation_id === shout.id).length === 0,
  )
  const jobs = dump.wakeJobs.filter((job) => job.message_id === seq)
  report.check(
    "每个 runtime 收件方各建 1 个 job（容器根 role_tag='container' 被排除，human 为 logical 不建 job）",
    jobs.length === 3 && jobs.every((job) => job.state === "pending"),
    `jobs=${jobs.map((job) => `${shortId(job.agent_id)}:${job.state}`).join(",")} root=${shortId(root.agentId)}`,
  )
  for (const session of members) {
    await host.flush(session.agentId, session.agentId)
    await row(ctx, "逐成员 flush 后", messageId, seq, session.agentId, "sh-a")
  }
  expectDeliveredExactlyOnce(ctx, "shout", members.map((session) => ({ session })))
  const stages = await host.receiptsOf([messageId], "sh-a")
  report.check(
    "全部 accepted + A 侧回执 delivered",
    members.every((session) => stages.get(`${messageId}:${session.agentId}`) === "delivered"),
    members.map((session) => `${shortId(session.agentId)}=${stages.get(`${messageId}:${session.agentId}`)}`).join(" "),
  )
}

// ── logical：收件方是 logical → 不建 job，但 flush 无门控仍能取件 ──────
export async function scenarioLogical(ctx) {
  const { host, report } = ctx
  await host.reset()
  const root = await host.registerRoot({ name: "root" })
  const a = await host.registerSession({ taskRef: "lg-a", name: "lg-a" })
  const l = await host.registerLogical({ name: "lg-logical", parentRef: root.agentId })
  report.step(`A=${shortId(a.agentId)} L=${shortId(l.agentId)}（kind=logical, 初始 status=offline）`)
  const sent = await host.send(a.taskRef, { to: l.agentId, body: "logical-hello" })
  const messageId = sent.message.id
  const seq = sent.message.seq
  const before = jobRow(await host.dump(), seq, l.agentId)
  report.check("logical 收件方**不建 job**（enqueueWakeJobs 只收 kind='runtime'）", before === undefined, String(before))
  report.check(
    "但发送回执里 L 仍为 queued（routeWake 的 T 含它，只是无 job 行）",
    sent.receipts.some((receipt) => receipt.agentId === l.agentId && receipt.stage === "queued"),
    JSON.stringify(sent.receipts),
  )
  await row(ctx, "发送后（无 job 行）", messageId, seq, l.agentId, a.taskRef)

  await host.flush(l.agentId, l.agentId)
  report.check("flush 仍能取件（Hub 对 logical **不做投递门控**）：注入 1 次", host.injectionsOf(l.agentId).length === 1)
  const after = await host.jobOf(seq, l.agentId)
  report.check(
    "差异：/internal/result delivered 为 logical 兜底补建 job 行 → accepted（runtime 是发送时就建行）",
    after?.state === "accepted",
    jobText(after),
  )
  const stage = (await host.receiptsOf([messageId], a.taskRef)).get(`${messageId}:${l.agentId}`)
  report.check("A 侧 L=delivered", stage === "delivered", String(stage))
  const injected = host.injectionsOf(l.agentId).length
  await host.flush(l.agentId, l.agentId)
  report.check("二次 flush 不重复注入", host.injectionsOf(l.agentId).length === injected)
  await row(ctx, "flush 后（补建 job 行）", messageId, seq, l.agentId, a.taskRef)
}

// ── states：状态白名单与 409 口径 ────────────────────────────────────
export async function scenarioStates(ctx) {
  const { host, report } = ctx
  const { root, sessions } = await setup(ctx, ["st-s"])
  const s = sessions["st-s"]
  report.step(`root=${shortId(root.agentId)}（container） session=${shortId(s.agentId)}（子节点）`)
  const online = await host.setState(s.agentId, "online")
  report.check("子会话上报 online → 200", online.status === 200, `status=${online.status}`)
  const busy = await host.setState(s.agentId, "busy")
  report.check(
    "上报 busy → 200 且落库 busy",
    busy.status === 200 && agentRow(await host.dump(), s.agentId)?.status === "busy",
    `status=${busy.status}`,
  )
  const idle = await host.setState(s.agentId, "idle")
  const idleRow = agentRow(await host.dump(), s.agentId)
  report.check(
    "上报 idle → 200 且落库为 online（Hub 侧 idle→online 映射）",
    idle.status === 200 && idleRow?.status === "online",
    `status=${idle.status} db=${idleRow?.status}`,
  )
  const childOffline = await host.setState(s.agentId, "offline")
  report.check(
    "子节点上报 offline → 409 child_never_offline",
    childOffline.status === 409 && childOffline.error === "child_never_offline",
    `status=${childOffline.status} error=${childOffline.error}`,
  )
  const rootOffline = await host.setState(root.agentId, "offline")
  report.check(
    "根上报 offline → 200 且落库 offline",
    rootOffline.status === 200 && agentRow(await host.dump(), root.agentId)?.status === "offline",
    `status=${rootOffline.status} db=${agentRow(await host.dump(), root.agentId)?.status}`,
  )
  report.note("口径：offline 仅根可上报（applyAgentState，routes/internal.ts:98）；子节点离线只能由 roster 读路径按 last_seen 落库")
}
