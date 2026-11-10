/**
 * 测试适配器输出层（`adapters/test/lib/report.mjs`）：把每一步压成**人能直接贴进报告**的一行，
 * 并把 (消息 × 收件方) 的回执与 `wake_jobs` 行拼成一张状态迁移表。
 *
 * 纪律：
 * - 每行带毫秒时刻（`HH:MM:SS.mmm`）+ 短码（id 前 8 位），失败行以 `✘` 标出；
 * - `check()` 一律记录（不因失败中断），场景跑完再汇总 PASS/FAIL —— 首个失败不应吞掉后续证据；
 * - 退出码由 CLI 依据 `failed` 计算（失败场景数）。
 */

/** id 短码（报告用；前 8 位足以在单场景内区分）。 */
export function shortId(id) {
  if (typeof id !== "string") return String(id)
  return id.length > 8 ? id.slice(0, 8) : id
}

/** 时刻文本（本地时区无关的 UTC 毫秒片段，便于贴进报告对齐）。 */
export function clockText(ts = Date.now()) {
  return new Date(ts).toISOString().slice(11, 23)
}

/**
 * 建报告器。
 *
 * @param {{out?: (line: string) => void}} [options] `out` 缺省逐行写 stdout（CLI 用）。
 */
export function createReporter(options = {}) {
  const out = options.out ?? ((line) => process.stdout.write(`${line}\n`))
  const checks = []
  const transitions = []
  let stepNo = 0

  const reporter = {
    get checks() {
      return checks
    },
    get transitions() {
      return transitions
    },
    get failed() {
      return checks.filter((check) => !check.ok).length
    },
    get passed() {
      return checks.length - reporter.failed
    },
    /** 一个步骤（带序号与时刻）。 */
    step(text) {
      stepNo += 1
      out(`${clockText()}  ${String(stepNo).padStart(2, "0")}. ${text}`)
      return reporter
    },
    /** 补充说明（缩进，不参与判定）。 */
    note(text) {
      out(`${clockText()}      · ${text}`)
      return reporter
    },
    /** 判定一条断言；返回是否通过（便于 `if (!report.check(...)) return`）。 */
    check(name, ok, detail) {
      const passed = ok === true
      checks.push({ name, ok: passed, detail })
      const suffix = detail === undefined ? "" : ` — ${detail}`
      out(`${clockText()}      ${passed ? "✔" : "✘"} ${name}${suffix}`)
      return passed
    },
    /** 记录一条状态迁移（由 `table()` 统一渲染成表）。 */
    transition(row) {
      transitions.push(row)
      return reporter
    },
    /** 打印状态迁移表（列宽自适应；无行则跳过）。 */
    table(title = "状态迁移表") {
      if (transitions.length === 0) return reporter
      const header = ["时刻", "阶段", "消息", "收件方", "回执阶段", "wake_jobs"]
      const rows = transitions.map((row) => [
        clockText(row.at),
        row.label,
        `msg:${shortId(row.messageId)}`,
        `${shortId(row.agentId)}`,
        row.stage,
        row.job === undefined
          ? "无 job 行"
          : `${row.job.state}(attempts=${row.job.attempts}${row.job.pending_reason === null ? "" : `,reason=${row.job.pending_reason}`})`,
      ])
      const widths = header.map((cell, index) =>
        Math.max(cell.length, ...rows.map((row) => [...row[index]].length)),
      )
      const render = (cells) =>
        cells.map((cell, index) => `${cell}${" ".repeat(widths[index] - [...cell].length)}`).join("  ")
      out("")
      out(`┌─ ${title} ─`)
      out(`  ${render(header)}`)
      out(`  ${widths.map((width) => "-".repeat(width)).join("  ")}`)
      for (const row of rows) out(`  ${render(row)}`)
      out("")
      return reporter
    },
    /** 场景结论行（PASS/FAIL + 通过数）。 */
    verdict(name) {
      const ok = reporter.failed === 0
      out(
        `${clockText()}  [${ok ? "PASS" : "FAIL"}] ${name}  检查 ${reporter.passed}/${checks.length} 通过` +
          (ok ? "" : `（失败 ${reporter.failed}）`),
      )
      return ok
    },
  }
  return reporter
}
