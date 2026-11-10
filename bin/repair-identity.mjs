/**
 * `agentchat repair-identity` —— 修复"容器身份冒用"造成的**存量数据**（U2）。
 *
 * 背景：旧代码允许 `role_tag='container'` 的分组容器节点入群/发言，于是库里留下了
 * 「容器 participant / 容器 read_states / 容器 wake_jobs / 容器署名的消息」。新代码
 * （P7）不再产生这类行，本脚本负责把**已经产生**的清干净。
 *
 * 设计约束（与 `server/routes/admin.ts` 的快照写法同源；本文件不 import server TS，避免把
 * 服务端代码拖进 CLI）：
 * - **缺省 dry-run 零写入**；只有 `--apply` 才写，且写前必须 `VACUUM INTO` 快照，失败即中止。
 * - **不丢消息**：容器署名的**非 system** 消息只**标注**
 *   `messages.meta.legacy_identity="container"`（合并进既有 meta JSON，保留其它键，幂等），
 *   不删除也不改正文。容器署名的 `kind='system'` 消息**不标注**（system 的作者是运行记账，
 *   不代表"身份使用"），只单独计数列出供人工判断。
 * - 容器 `agents` / `agent_keys` 行**保留**（层级与注册仍需要）；容器创建的群只报告不删
 *   （删群会丢其它成员的历史，属破坏性动作，须人工确认）。
 * - 单 `BEGIN IMMEDIATE` 事务；`PRAGMA foreign_keys=ON`，且提交前 `foreign_key_check`
 *   必须为空 —— 不通过即抛错回滚，绝不留下半修状态。
 * - 只碰数据库；**不碰** `<home>/agents/` 下的运行时身份文件，只在报告里给诊断与指引。
 *
 * 本文件为纯 ESM（除 better-sqlite3 无第三方依赖），所有 IO 可注入，供 vitest 直接导入。
 */
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import Database from "better-sqlite3"
import { REPAIR_HELP_TEXT, parseRepairArgs } from "./repair-args.mjs"
import { resolveHome } from "./reset-io.mjs"

/** 退出码语义（--check 自检用；文档与帮助文本同源）。 */
export const REPAIR_EXIT = { OK: 0, RESIDUE: 1, ERROR: 2 }

/** 容器身份判据（与 `core/messaging.isContainer` 同一口径：`role_tag === "container"`）。 */
export const CONTAINER_ROLE_TAG = "container"

/** 历史身份标注字段：UI 据此显示"历史身份未区分"（P7 约定）。 */
export const LEGACY_IDENTITY_KEY = "legacy_identity"
export const LEGACY_IDENTITY_VALUE = "container"

const CONTAINER_SUBQUERY = "SELECT id FROM agents WHERE role_tag = ?"

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 解析既有 meta JSON 为普通对象。
 * 返回 `{ ok: true, value }`（无 meta → 空对象）或 `{ ok: false }`（非法 JSON / 非对象）。
 * 后者**不覆盖**原值（宁可留着不标，也不破坏数据）。
 */
function parseMetaObject(raw) {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: {} }
  if (typeof raw !== "string") return { ok: false }
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, value: parsed }
    }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

/** 合并标注后的 meta 文本；已标注或 meta 非法（不可安全合并）→ `undefined`（跳过）。 */
function mergeLegacyMarker(raw) {
  const parsed = parseMetaObject(raw)
  if (!parsed.ok) return undefined
  if (parsed.value[LEGACY_IDENTITY_KEY] === LEGACY_IDENTITY_VALUE) return undefined
  return JSON.stringify({ ...parsed.value, [LEGACY_IDENTITY_KEY]: LEGACY_IDENTITY_VALUE })
}

function preview(body, max = 40) {
  const text = typeof body === "string" ? body.replaceAll(/\s+/gu, " ").trim() : ""
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 只读打开（dry-run / --check 用）。WAL 库在缺 -shm 或其索引不可初始化时只读会失败，
 * 此时回落为读写连接 —— 本模式不执行任何变更语句，数据不变（回落事实写进报告 warnings）。
 */
function openForRead(dbPath) {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    db.pragma("busy_timeout = 5000")
    return { db, readonly: true, fallback: false }
  } catch {
    const db = new Database(dbPath, { fileMustExist: true })
    db.pragma("busy_timeout = 5000")
    return { db, readonly: false, fallback: true }
  }
}

/** 读写打开（--apply 用）：与 `server/db.openDb` 同一套安全 PRAGMA。 */
function openForWrite(dbPath) {
  const db = new Database(dbPath, { fileMustExist: true })
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")
  return db
}

/**
 * 扫描全部身份遗留（纯读）。返回结构化发现 + 诊断。
 * @param {import("better-sqlite3").Database} db
 * @param {string} home
 */
export function scanIdentity(db, home) {
  const containers = db
    .prepare(
      `SELECT id, name, custom_name AS customName, status, created_at AS createdAt
         FROM agents WHERE role_tag = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(CONTAINER_ROLE_TAG)
    .map((row) => ({
      id: row.id,
      name: row.name,
      displayName: row.customName ?? row.name,
      status: row.status,
    }))

  const participants = db
    .prepare(
      `SELECT p.conversation_id AS conversationId, p.agent_id AS agentId, p.role,
              c.kind AS conversationKind, c.name AS conversationName, c.key AS conversationKey
         FROM participants p JOIN conversations c ON c.id = p.conversation_id
        WHERE p.agent_id IN (${CONTAINER_SUBQUERY})
        ORDER BY p.conversation_id ASC, p.agent_id ASC`,
    )
    .all(CONTAINER_ROLE_TAG)

  const readStates = db
    .prepare(
      `SELECT r.conversation_id AS conversationId, r.agent_id AS agentId,
              r.last_read_seq AS lastReadSeq
         FROM read_states r WHERE r.agent_id IN (${CONTAINER_SUBQUERY})
        ORDER BY r.conversation_id ASC`,
    )
    .all(CONTAINER_ROLE_TAG)

  const wakeJobs = db
    .prepare(
      `SELECT w.id AS id, w.message_id AS messageId, w.agent_id AS agentId, w.state AS state
         FROM wake_jobs w WHERE w.agent_id IN (${CONTAINER_SUBQUERY})
        ORDER BY w.id ASC`,
    )
    .all(CONTAINER_ROLE_TAG)

  // 容器署名消息：非 system 的"身份使用"→ 待标注；system 的作者是运行记账 → 只计数列出。
  const messageRows = db
    .prepare(
      `SELECT seq, id, conversation_id AS conversationId, from_agent_id AS agentId,
              kind, body, meta
         FROM messages WHERE from_agent_id IN (${CONTAINER_SUBQUERY})
        ORDER BY seq ASC`,
    )
    .all(CONTAINER_ROLE_TAG)
  const unmarkedMessages = []
  const containerSystemMessages = []
  let markedCount = 0
  let unmergeableCount = 0
  for (const row of messageRows) {
    if (row.kind === "system") {
      containerSystemMessages.push({
        seq: row.seq,
        id: row.id,
        conversationId: row.conversationId,
        agentId: row.agentId,
        bodyPreview: preview(row.body),
      })
      continue
    }
    const parsed = parseMetaObject(row.meta)
    if (parsed.ok && parsed.value[LEGACY_IDENTITY_KEY] === LEGACY_IDENTITY_VALUE) {
      markedCount += 1
      continue
    }
    if (!parsed.ok) unmergeableCount += 1
    unmarkedMessages.push({
      seq: row.seq,
      id: row.id,
      conversationId: row.conversationId,
      agentId: row.agentId,
      kind: row.kind,
      bodyPreview: preview(row.body),
      meta: row.meta,
      mergeable: parsed.ok,
    })
  }

  const containerAgentKeys = db
    .prepare(
      `SELECT k.agent_id AS agentId, k.join_token_hash AS joinTokenHash
         FROM agent_keys k WHERE k.agent_id IN (${CONTAINER_SUBQUERY})
        ORDER BY k.agent_id ASC`,
    )
    .all(CONTAINER_ROLE_TAG)

  const containerCreatedGroups = db
    .prepare(
      `SELECT c.id AS id, c.name AS name, c.key AS key,
              (SELECT COUNT(*) FROM participants p WHERE p.conversation_id = c.id) AS memberCount
         FROM conversations c
        WHERE c.kind = 'group' AND c.created_by IN (${CONTAINER_SUBQUERY})
        ORDER BY c.created_at ASC`,
    )
    .all(CONTAINER_ROLE_TAG)

  // 因删掉容器 participant 而"不足两人"的 DM（含 0 人）——保留会话与历史，仅报告供 UI 标注。
  // 用 CTE 收口容器集合：同一子查询在此需要出现 4 次，逐个 `?` 极易漏绑参数（用 WITH 只绑一次）。
  const singleMemberDms = db
    .prepare(
      `WITH containers(id) AS (${CONTAINER_SUBQUERY})
       SELECT c.id AS conversationId, c.name AS name, c.key AS key,
              (SELECT COUNT(*) FROM participants p2
                WHERE p2.conversation_id = c.id
                  AND p2.agent_id NOT IN (SELECT id FROM containers)) AS remainingParticipantCount,
              (SELECT p2.agent_id FROM participants p2
                WHERE p2.conversation_id = c.id
                  AND p2.agent_id NOT IN (SELECT id FROM containers)
                ORDER BY p2.joined_at ASC LIMIT 1) AS remainingAgentId
         FROM conversations c
        WHERE c.kind = 'dm'
          AND EXISTS (SELECT 1 FROM participants p
                       WHERE p.conversation_id = c.id
                         AND p.agent_id IN (SELECT id FROM containers))
          AND (SELECT COUNT(*) FROM participants p2
                WHERE p2.conversation_id = c.id
                  AND p2.agent_id NOT IN (SELECT id FROM containers)) <= 1
        ORDER BY c.created_at ASC`,
    )
    .all(CONTAINER_ROLE_TAG)

  const foreignKeyViolations = db.pragma("foreign_key_check")

  const warnings = []
  if (containers.length > 0) {
    const topLevel = db
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE parent_id IS NULL AND kind = 'runtime'")
      .get().n
    const dshCurrent = join(home, "agents", "dsh.current")
    const dshId = join(home, "agents", "dsh.id")
    if (!existsSync(dshCurrent)) {
      // 启发式诊断（不碰运行时文件）：真正修法由 P7/适配器决定，这里只给指引。
      warnings.push(
        `运行时身份文件缺失：${dshCurrent} 不存在（${dshId} ${existsSync(dshId) ? "存在" : "也不存在"}）。` +
          (topLevel >= 2
            ? ` 当前顶层 runtime 节点 ${topLevel} 个（≥2，启发式）：请开启 nativeTools，或只保留一个顶层会话后再注册。`
            : ` 当前顶层 runtime 节点 ${topLevel} 个：如遇身份复用异常，请检查适配器注册流程。`),
      )
    }
  }
  if (unmergeableCount > 0) {
    warnings.push(
      `${unmergeableCount} 条容器署名消息的 meta 非 JSON 对象，无法安全合并标注（已跳过，未改动其 meta）。`,
    )
  }
  if (containerSystemMessages.length > 0) {
    warnings.push(
      `容器署名的 system 消息 ${containerSystemMessages.length} 条：按约定**不标注**（作者是运行记账，非身份使用），仅列出供人工判断。`,
    )
  }
  if (containerCreatedGroups.length > 0) {
    warnings.push(
      `容器创建的群 ${containerCreatedGroups.length} 个：本脚本只报告**不删除**（删群会丢其它成员的历史）；` +
        `如需清理请人工确认后用会话删除流程处理。`,
    )
  }

  return {
    containers,
    participants,
    readStates,
    wakeJobs,
    messages: {
      total: messageRows.length,
      marked: markedCount,
      unmarked: unmarkedMessages,
      unmergeable: unmergeableCount,
      system: containerSystemMessages,
    },
    containerAgentKeys,
    containerCreatedGroups,
    singleMemberDms,
    foreignKeyViolations,
    warnings,
  }
}

/**
 * 残留计数 = `--check` 判据（lead 确认的 5 项；任一项 > 0 即退出码 1）。
 * `foreignKeyViolations` **不在这 5 项内**：它不是身份遗留，而是库完整性；
 * 存在即视为"无法修干净"→ 退出码 2。
 */
export function residueOf(scan) {
  return {
    participants: scan.participants.length,
    readStates: scan.readStates.length,
    wakeJobs: scan.wakeJobs.length,
    unmarkedMessages: scan.messages.unmarked.length,
    containerCreatedGroups: scan.containerCreatedGroups.length,
  }
}

export function hasResidue(residue) {
  return Object.values(residue).some((count) => count > 0)
}

/**
 * 快照（`VACUUM INTO`，与 `server/routes/admin.ts` 的写法一致，含单引号转义）。
 * 目录名 `<home>.bak-identity-<ISO 时间戳>`；失败抛错（调用方据此中止，库未被改动）。
 */
export function snapshotDb(db, home, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-")
  const backupDir = `${home}.bak-identity-${stamp}`
  const snapshotPath = join(backupDir, "agentchat.db")
  mkdirSync(backupDir, { recursive: true })
  db.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`)
  return snapshotPath
}

/**
 * 执行修复（调用前必须已完成快照）。单 `BEGIN IMMEDIATE` 事务；提交前 `foreign_key_check`
 * 不通过即抛错回滚（不留半修状态）。返回真实 `.changes` 与修复后的复核扫描。
 */
export function applyRepair(db, home) {
  const tx = db.transaction(() => {
    // 事务内重扫：BEGIN IMMEDIATE 已握写锁，扫描结果即本次删除的判据。
    const scan = scanIdentity(db, home)

    const deletedParticipants = db
      .prepare(`DELETE FROM participants WHERE agent_id IN (${CONTAINER_SUBQUERY})`)
      .run(CONTAINER_ROLE_TAG).changes
    const deletedReadStates = db
      .prepare(`DELETE FROM read_states WHERE agent_id IN (${CONTAINER_SUBQUERY})`)
      .run(CONTAINER_ROLE_TAG).changes
    const deletedWakeJobs = db
      .prepare(`DELETE FROM wake_jobs WHERE agent_id IN (${CONTAINER_SUBQUERY})`)
      .run(CONTAINER_ROLE_TAG).changes

    const updateMeta = db.prepare("UPDATE messages SET meta = ? WHERE seq = ?")
    let messagesMarked = 0
    for (const row of scan.messages.unmarked) {
      const merged = mergeLegacyMarker(row.meta)
      if (merged === undefined) continue
      updateMeta.run(merged, row.seq)
      messagesMarked += 1
    }

    const violations = db.pragma("foreign_key_check")
    if (violations.length > 0) {
      const error = new Error(
        `foreign_key_check 不通过（${violations.length} 行）—— 已回滚，库未改动。可能是修复前就已存在的悬挂引用。`,
      )
      error.violations = violations
      throw error
    }

    return {
      applied: { deletedParticipants, deletedReadStates, deletedWakeJobs, messagesMarked },
      after: scanIdentity(db, home),
    }
  })
  return tx.immediate()
}

/** 人类可读报告（`--json` 时改走 JSON.stringify）。 */
export function formatReportLines(report) {
  const lines = []
  const modeLabel =
    report.mode === "apply"
      ? "apply（执行修复）"
      : report.mode === "check"
        ? "check（只读自检）"
        : "dry-run（只读，零写入）"
  lines.push(`[repair-identity] 模式：${modeLabel}`)
  lines.push(`[repair-identity] 数据目录：${report.home}`)
  if (!report.dbExists) {
    lines.push("[repair-identity] 未找到 agentchat.db —— 无存量数据需要修复。")
    return lines
  }
  const names = report.containers.map((c) => `${c.displayName}(${c.id.slice(0, 8)})`).join("、")
  lines.push(`[repair-identity] 容器节点：${report.containers.length} 个${names === "" ? "" : `：${names}`}`)
  lines.push("[repair-identity] 发现：")
  lines.push(`  - participants：${report.findings.participants.length} 行（容器永不可收件）`)
  lines.push(`  - read_states：${report.findings.readStates.length} 行（容器从不取件）`)
  lines.push(`  - wake_jobs：${report.findings.wakeJobs.length} 行（以容器为唤醒目标）`)
  lines.push(
    `  - 容器署名消息：${report.findings.messages.total} 条（已标注 ${report.findings.messages.marked}、` +
      `待标注 ${report.findings.messages.unmarked.length}、system 不标注 ${report.findings.messages.system.length}）`,
  )
  for (const row of report.findings.messages.unmarked.slice(0, 20)) {
    lines.push(`      seq=${row.seq} ${row.kind} 「${row.bodyPreview}」${row.mergeable ? "" : "（meta 非法，跳过）"}`)
  }
  if (report.findings.messages.unmarked.length > 20) {
    lines.push(`      …另有 ${report.findings.messages.unmarked.length - 20} 条（--json 查看全部）`)
  }
  const applied = report.applied
  if (applied !== undefined) {
    lines.push(
      `[repair-identity] 已写入：participants ${applied.deletedParticipants}、read_states ${applied.deletedReadStates}、` +
        `wake_jobs ${applied.deletedWakeJobs}、消息标注 ${applied.messagesMarked} 条`,
    )
    if (report.snapshotPath !== undefined) lines.push(`[repair-identity] 修复前快照：${report.snapshotPath}`)
  }
  lines.push(
    `[repair-identity] 保留：容器 agents 行 ${report.containers.length} 个、agent_keys ${report.findings.containerAgentKeys.length} 行；` +
      `容器创建的群 ${report.findings.containerCreatedGroups.length} 个（只报告不删）`,
  )
  if (report.findings.singleMemberDms.length > 0) {
    lines.push(
      `[repair-identity] 清掉容器后不足两人的 DM：${report.findings.singleMemberDms.length} 条（会话与历史保留，供 UI 标注）：`,
    )
    for (const dm of report.findings.singleMemberDms) {
      lines.push(`      ${dm.conversationId}（剩 ${dm.remainingParticipantCount} 人：${dm.remainingAgentId ?? "无"}）`)
    }
  }
  const residue = report.residue
  lines.push(
    `[repair-identity] 残留：participants ${residue.participants}、read_states ${residue.readStates}、` +
      `wake_jobs ${residue.wakeJobs}、未标注消息 ${residue.unmarkedMessages}、容器创建的群 ${residue.containerCreatedGroups}`,
  )
  lines.push(
    `[repair-identity] 外键检查：${
      report.foreignKeyViolations.length === 0
        ? "OK（无悬挂引用）"
        : `不通过 ${report.foreignKeyViolations.length} 行（退出码 2）`
    }`,
  )
  for (const warning of report.warnings) lines.push(`[repair-identity] 提示：${warning}`)
  if (report.mode === "check") {
    lines.push(
      hasResidue(residue)
        ? "[repair-identity] 自检结果：仍有残留（退出码 1）—— 执行 `--apply`（先停 Hub）后复跑。"
        : "[repair-identity] 自检结果：干净（退出码 0）。",
    )
  }
  if (report.mode === "dry-run") {
    lines.push("[repair-identity] 以上为预演，未改动数据库；执行修复请加 --apply（写前自动快照）。")
  }
  if (report.mode === "apply" && applied !== undefined && applied.deletedParticipants + applied.deletedReadStates + applied.deletedWakeJobs + applied.messagesMarked === 0) {
    lines.push("[repair-identity] 无残留，未写库、未生成新快照（幂等）。")
  }
  return lines
}

/** 组装报告对象（三处输出共用同一形状，避免字段漂移）。 */
function buildReport(mode, home, dbPath, scan, extra) {
  const residue = residueOf(scan)
  const foreignKeyViolations = scan.foreignKeyViolations
  return {
    ok: !hasResidue(residue) && foreignKeyViolations.length === 0,
    mode,
    home,
    dbPath,
    dbExists: true,
    containers: scan.containers,
    findings: {
      participants: scan.participants,
      readStates: scan.readStates,
      wakeJobs: scan.wakeJobs,
      messages: scan.messages,
      containerAgentKeys: scan.containerAgentKeys,
      containerCreatedGroups: scan.containerCreatedGroups,
      singleMemberDms: scan.singleMemberDms,
    },
    residue,
    foreignKeyViolations,
    warnings: scan.warnings,
    ...extra,
  }
}

/**
 * 编排一次修复/检查。
 * @param {import("./repair-args.mjs").ParsedRepairArgs} parsed
 * @param {object} [deps] 注入点（env / now / log / dbPath）
 * @returns {{ code: number, home: string, dbPath: string, report?: object, snapshotPath?: string }}
 */
export function runRepair(parsed, deps = {}) {
  const env = deps.env ?? process.env
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`))
  const now = deps.now ?? Date.now
  const home = parsed.home ?? resolveHome(env)
  const dbPath = deps.dbPath ?? join(home, "agentchat.db")
  const mode = parsed.apply ? "apply" : parsed.check ? "check" : "dry-run"

  const emit = (report) => {
    if (parsed.json) log(JSON.stringify(report, null, 2))
    else for (const line of formatReportLines(report)) log(line)
  }

  if (!existsSync(dbPath)) {
    const report = {
      ok: true,
      mode,
      home,
      dbPath,
      dbExists: false,
      containers: [],
      findings: {
        participants: [],
        readStates: [],
        wakeJobs: [],
        messages: { total: 0, marked: 0, unmarked: [], unmergeable: 0, system: [] },
        containerAgentKeys: [],
        containerCreatedGroups: [],
        singleMemberDms: [],
      },
      residue: { participants: 0, readStates: 0, wakeJobs: 0, unmarkedMessages: 0, containerCreatedGroups: 0 },
      foreignKeyViolations: [],
      warnings: [],
    }
    emit(report)
    return { code: REPAIR_EXIT.OK, home, dbPath, report }
  }

  if (!parsed.apply) {
    let handle
    try {
      handle = openForRead(dbPath)
      const scan = scanIdentity(handle.db, home)
      const report = buildReport(mode, home, dbPath, scan, {
        warnings: [
          ...scan.warnings,
          ...(handle.fallback
            ? ["只读连接不可用（WAL 索引），已回落为读写连接；本模式未执行任何变更语句。"]
            : []),
        ],
      })
      emit(report)
      // --check：先看外键（库不完整 = 失败 2），再看 5 项残留（1）；dry-run 恒 0（成功即 0）。
      const code = !parsed.check
        ? REPAIR_EXIT.OK
        : report.foreignKeyViolations.length > 0
          ? REPAIR_EXIT.ERROR
          : hasResidue(report.residue)
            ? REPAIR_EXIT.RESIDUE
            : REPAIR_EXIT.OK
      return { code, home, dbPath, report }
    } catch (error) {
      log(`[repair-identity] 执行失败：${errorText(error)}`)
      return { code: REPAIR_EXIT.ERROR, home, dbPath }
    } finally {
      handle?.db.close()
    }
  }

  // --apply
  let db
  try {
    db = openForWrite(dbPath)
    const pre = scanIdentity(db, home)
    if (!hasResidue(residueOf(pre))) {
      // 幂等：无残留则**不写、不快照**（第二次 --apply 即此路径）。
      const report = buildReport(mode, home, dbPath, pre, {
        applied: { deletedParticipants: 0, deletedReadStates: 0, deletedWakeJobs: 0, messagesMarked: 0 },
        warnings: [...pre.warnings, "无残留，未写库、未生成新快照（幂等）。"],
      })
      emit(report)
      return { code: REPAIR_EXIT.OK, home, dbPath, report }
    }

    const snapshotPath = snapshotDb(db, home, now())
    const { applied, after } = applyRepair(db, home)
    // findings 展示"修之前发现了什么"；residue/容器等以修复后复核为准。
    // `singleMemberDms` 必须取**修前**扫描：其语义是"清掉容器后会不足两人的 DM"（修后已无容器
    // participant，再查就查不到了），而这条正是给 UI/人工标注用的投影。
    const report = buildReport(mode, home, dbPath, after, {
      snapshotPath,
      applied,
      findings: {
        participants: pre.participants,
        readStates: pre.readStates,
        wakeJobs: pre.wakeJobs,
        messages: {
          ...pre.messages,
          marked: pre.messages.marked + applied.messagesMarked,
          unmarked: after.messages.unmarked,
        },
        containerAgentKeys: after.containerAgentKeys,
        containerCreatedGroups: after.containerCreatedGroups,
        singleMemberDms: pre.singleMemberDms,
      },
    })
    emit(report)
    return { code: REPAIR_EXIT.OK, home, dbPath, report, snapshotPath }
  } catch (error) {
    log(`[repair-identity] 修复失败（已回滚，库保持原状）：${errorText(error)}`)
    return { code: REPAIR_EXIT.ERROR, home, dbPath }
  } finally {
    db?.close()
  }
}

/** CLI 入口：解析参数并执行；返回进程退出码。 */
export function runRepairCommand(argv) {
  const parsed = parseRepairArgs(argv)
  if (parsed.errors.length > 0) {
    for (const message of parsed.errors) process.stderr.write(`[repair-identity] ${message}\n`)
    process.stderr.write("运行 `node bin/repair-identity.mjs --help` 查看用法。\n")
    return REPAIR_EXIT.ERROR
  }
  if (parsed.help) {
    process.stdout.write(REPAIR_HELP_TEXT)
    return REPAIR_EXIT.OK
  }
  return runRepair(parsed).code
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exitCode = runRepairCommand(process.argv.slice(2))
