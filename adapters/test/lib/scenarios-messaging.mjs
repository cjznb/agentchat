/**
 * 场景库（消息流）：`dm` / `group` / `busy` / `refused`。
 *
 * 自 `scenarios.mjs` 按主题拆出（本仓红线「单文件 ≤ 250 纯行」）；共享件在 `scenario-kit.mjs`，
 * 注册表在 `scenarios.mjs`。断言口径与 task-6 描述逐条对齐，全程只走真实代码路径
 * （MCP 工具 + `/internal/*` 真闭环 + `/api/test/*` 测试面驱动真实 core）。
 */
import { shortId } from "./report.mjs"
import {
  CLOCK_SKEW_MS,
  REFUSAL_LIMIT,
  dueEvidence,
  expectDeliveredExactlyOnce,
  isDue,
  jobRow,
  jobText,
  row,
  setup,
  sleep,
  waitFor,
} from "./scenario-kit.mjs"

// ── dm：A→B 单聊，排队 → flush 送达 → 去重 → ack 已读 ──────────────────
export async function scenarioDm(ctx) {
  const { host, report } = ctx
  const { sessions } = await setup(ctx, ["dm-a", "dm-b"])
  const a = sessions["dm-a"]
  const b = sessions["dm-b"]
  report.step(`A=${shortId(a.agentId)} B=${shortId(b.agentId)}（都 online）`)
  const sent = await host.send(a.taskRef, { to: b.agentId, body: "dm-hello" })
  const messageId = sent.message.id
  const seq = sent.message.seq
  report.check(
    "发送回执 B=queued（无 job 行也恒 queued：发送即排队）",
    sent.receipts.some((receipt) => receipt.agentId === b.agentId && receipt.stage === "queued"),
    JSON.stringify(sent.receipts),
  )
  const job = jobRow(await host.dump(), seq, b.agentId)
  report.check("发送后 B 的 wake_jobs=pending（=排队）", job?.state === "pending", jobText(job))
  await row(ctx, "A send 后", messageId, seq, b.agentId, a.taskRef)

  report.check("B flush 返回 true（Hub 往返成功）", (await host.flush(b.agentId, b.agentId)) === true)
  await row(ctx, "B flush 后", messageId, seq, b.agentId, a.taskRef)
  expectDeliveredExactlyOnce(ctx, "dm", [{ session: b, count: messageId }])
  report.check("注入文本含正文 dm-hello", host.inboxOf(b.agentId)[0]?.includes("dm-hello") === true)
  const accepted = await host.jobOf(seq, b.agentId)
  report.check("wake_jobs=accepted（=已送达）", accepted?.state === "accepted", jobText(accepted))
  const afterFlush = await host.receiptsOf([messageId], a.taskRef)
  report.check(
    "A 侧 message_status：B=delivered",
    afterFlush.get(`${messageId}:${b.agentId}`) === "delivered",
    String(afterFlush.get(`${messageId}:${b.agentId}`)),
  )

  const before = host.deliveries.length
  await host.flush(b.agentId, b.agentId)
  report.check("二次 flush 不重复注入（seen 去重）", host.deliveries.length === before, `deliveries=${host.deliveries.length}`)

  await host.ack(b.taskRef, [messageId])
  const afterAck = await host.receiptsOf([messageId], a.taskRef)
  report.check(
    "B ack 后 stage=read（四级回执闭环）",
    afterAck.get(`${messageId}:${b.agentId}`) === "read",
    String(afterAck.get(`${messageId}:${b.agentId}`)),
  )
  await row(ctx, "B ack 后", messageId, seq, b.agentId, a.taskRef)

  // 真实 `IdlePoller` 路径（CLI 的 --poll-ms 即此处间隔）：B 开着轮询时，新消息无需人工 flush。
  const intervalMs = ctx.args.pollMs ?? 200
  const stopPolling = host.startPolling(b.agentId, b.agentId, { intervalMs })
  const polled = await host.send(a.taskRef, { to: b.agentId, body: "dm-polled" })
  const arrived = await waitFor(() => host.injectedIdsOf(b.agentId).includes(polled.message.id))
  stopPolling()
  report.check(
    `IdlePoller（${intervalMs}ms 间隔）自动取件送达，无需人工 flush`,
    arrived && (await host.jobOf(polled.message.seq, b.agentId))?.state === "accepted",
    `injected=${host.injectedIdsOf(b.agentId).length} 条`,
  )
  await row(ctx, "轮询自动送达", polled.message.id, polled.message.seq, b.agentId, a.taskRef)
}

// ── group：群内 @全体，逐个成员 flush；记录"没 flush 就没回执" ─────────
export async function scenarioGroup(ctx) {
  const { host, report } = ctx
  const { sessions } = await setup(ctx, ["grp-a", "grp-b", "grp-c", "grp-d"])
  const a = sessions["grp-a"]
  const b = sessions["grp-b"]
  const c = sessions["grp-c"]
  const d = sessions["grp-d"]
  const group = await host.createGroup("t6-group", [a, b, c, d].map((session) => session.agentId))
  const conversationId = group.conversation.id
  const members = (await host.dump()).participants.filter((p) => p.conversation_id === conversationId)
  report.check("群成员 = human owner + 4 名会话（5 行 participants）", members.length === 5, `participants=${members.length}`)

  const sent = await host.send(a.taskRef, { to: conversationId, body: "@* 群内发言", mentions: ["*"] })
  const messageId = sent.message.id
  const seq = sent.message.seq
  report.check(
    "mentions 回声 scope=all（@全体命中 4 名会话 + human owner）",
    sent.mentions?.scope === "all" && sent.receipts.length === 4,
    `scope=${sent.mentions?.scope} wakeIds=${sent.receipts.length}`,
  )
  const jobs = (await host.dump()).wakeJobs.filter((job) => job.message_id === seq)
  report.check(
    "B/C/D 各建 1 个 job 且都 pending（human 为 logical：不建 job）",
    jobs.length === 3 && jobs.every((job) => job.state === "pending"),
    jobs.map((job) => `${shortId(job.agent_id)}:${job.state}`).join(","),
  )
  for (const session of [b, c]) await host.flush(session.agentId, session.agentId)
  expectDeliveredExactlyOnce(ctx, "group", [{ session: b }, { session: c }])
  const dumpMid = await host.dump()
  const dJob = jobRow(dumpMid, seq, d.agentId)
  const stages = await host.receiptsOf([messageId], a.taskRef)
  report.check(
    "D 未 flush → 一直没有回执：job 仍 pending、stage=queued",
    dJob?.state === "pending" && stages.get(`${messageId}:${d.agentId}`) === "queued",
    `job=${jobText(dJob)} stage=${stages.get(`${messageId}:${d.agentId}`)}`,
  )
  report.note("结构性证据：唤醒是 pull（等收件方 flush/轮询）——不跑轮询的成员永远停在 queued，发送方也永远看不到 delivered")
  for (const session of [b, c, d]) {
    await row(ctx, `B/C 已 flush、D 未 flush（${shortId(session.agentId)}）`, messageId, seq, session.agentId, a.taskRef)
  }
  await host.flush(d.agentId, d.agentId)
  expectDeliveredExactlyOnce(ctx, "group", [{ session: d }])
  report.check("D flush 后送达", (await host.jobOf(seq, d.agentId))?.state === "accepted")
  await row(ctx, "D flush 后", messageId, seq, d.agentId, a.taskRef)
}

// ── busy：busy 期间只排队；量化延迟 ──────────────────────────────────
export async function scenarioBusy(ctx) {
  const { host, report } = ctx
  const holdMs = ctx.args.holdMs ?? 600
  const { sessions } = await setup(ctx, ["busy-a", "busy-b"])
  const a = sessions["busy-a"]
  const b = sessions["busy-b"]
  const busy = await host.setState(b.agentId, "busy")
  report.check("B 上报 busy → 200", busy.status === 200, `status=${busy.status}`)

  const t0 = Date.now()
  const sent = await host.send(a.taskRef, { to: b.agentId, body: "busy-hello" })
  const messageId = sent.message.id
  const seq = sent.message.seq
  const job = jobRow(await host.dump(), seq, b.agentId)
  report.check(
    "busy 收件方仍建 job 且 state=pending / pending_reason='busy'（=消息只能等）",
    job?.state === "pending" && job.pending_reason === "busy",
    jobText(job),
  )
  await sleep(holdMs)
  const held = await host.jobOf(seq, b.agentId)
  report.check(
    `不 flush 观察 ${holdMs}ms 后仍 pending('busy')（消息只能等；本场景已预热 pull，dispatcher 不介入）`,
    held?.state === "pending" && held.pending_reason === "busy",
    jobText(held),
  )
  report.check("busy 期间零注入", host.deliveries.length === 0, `deliveries=${host.deliveries.length}`)
  await row(ctx, "busy 中（未 flush）", messageId, seq, b.agentId, a.taskRef)

  const tIdle = Date.now()
  const idle = await host.setState(b.agentId, "idle")
  const due = await host.jobOf(seq, b.agentId)
  // 采样点放在 setState 响应**之后**，判据走 `isDue` 的跨进程容差（retry_at 由 Hub 用自己的时钟写）。
  const nowAfterIdle = Date.now()
  report.check(
    `setState(idle) → 200 且 makeJobsDue 已生效（job 到期；跨进程时钟按 ±${CLOCK_SKEW_MS}ms 容差判）`,
    idle.status === 200 && isDue(due, nowAfterIdle),
    `status=${idle.status} ${dueEvidence(due, nowAfterIdle)}`,
  )
  await host.flush(b.agentId, b.agentId)
  const tDelivered = Date.now()
  report.check("idle 后 flush 送达 accepted", (await host.jobOf(seq, b.agentId))?.state === "accepted")
  await row(ctx, "idle + flush 后", messageId, seq, b.agentId, a.taskRef)
  report.note(
    `busy 延迟量化：send→观察 ${holdMs}ms→idle 共 ${tIdle - t0}ms 全程 pending；` +
      `idle→送达 ${tDelivered - tIdle}ms；send→送达净 ${tDelivered - t0}ms（延迟由收件方何时转 idle 决定，非固定值）`,
  )
  report.check(
    "A 侧最终 B=delivered",
    (await host.receiptsOf([messageId], a.taskRef)).get(`${messageId}:${b.agentId}`) === "delivered",
  )
}

// ── refused：拒收不写 seen（重投）＋ 达 REFUSAL_LIMIT 转终态 ───────────
export async function scenarioRefused(ctx) {
  const { host, report } = ctx
  const { sessions } = await setup(ctx, ["ref-a", "ref-b"])
  const a = sessions["ref-a"]
  const b = sessions["ref-b"]
  const sent = await host.send(a.taskRef, { to: b.agentId, body: "refuse-hello" })
  const messageId = sent.message.id
  const seq = sent.message.seq
  report.step(`msg=${shortId(messageId)}：让 B 的注入返回 refused`)

  host.deliver.refuseNext(1)
  await host.flush(b.agentId, b.agentId)
  const first = await host.jobOf(seq, b.agentId)
  const firstStage = (await host.receiptsOf([messageId], a.taskRef)).get(`${messageId}:${b.agentId}`)
  report.check("第 1 次拒收：job 不是 accepted", first?.state !== "accepted", jobText(first))
  report.check("第 1 次拒收：job 回 pending（detail 记 refusals=1）", first?.state === "pending", jobText(first))
  report.check("第 1 次拒收：A 侧 B 仍非 delivered", firstStage === "queued", String(firstStage))
  await row(ctx, "第 1 次拒收后", messageId, seq, b.agentId, a.taskRef)

  host.deliver.refuseNext(1)
  await host.flush(b.agentId, b.agentId)
  const second = await host.jobOf(seq, b.agentId)
  report.check(
    "refused 不写 seen → 再 flush 仍会重投（第 2 次注入真实发生）",
    host.injectionsOf(b.agentId).length === 2,
    `injections=${host.injectionsOf(b.agentId).length}`,
  )
  report.check(`连续第 ${REFUSAL_LIMIT} 次拒收 → 终态 refused`, second?.state === "refused", jobText(second))
  const before = host.injectionsOf(b.agentId).length
  await host.flush(b.agentId, b.agentId)
  report.check(
    "终态 refused 后不再重投（wake 不再返回该消息，flush 既不注入也不补回执）",
    host.injectionsOf(b.agentId).length === before && (await host.jobOf(seq, b.agentId))?.state === "refused",
    `injections=${before}→${host.injectionsOf(b.agentId).length}`,
  )
  await row(ctx, "终态 refused 后", messageId, seq, b.agentId, a.taskRef)
  report.note(`口径：REFUSAL_LIMIT=${REFUSAL_LIMIT}（server/store/wake.ts）——两次拒收即终态，不再无限重投`)
}
