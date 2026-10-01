/**
 * DSH 安装器的**文本工具 + profile 用户 patch 规划**：托管块组装、块内替换 / 摘除，以及
 * 「保持原文件格式」的序列化（卸载后逐字节还原就靠它们）。
 *
 * 分层（见 `install.mjs` 头部总览）：本模块 = 纯文本/纯规划；`install-plan.mjs` = 其余纯规划
 * （路径、manifest、Hub 登记、`planInstall`/`planUninstall`）；`install-apply.mjs` = 副作用层；
 * `install.mjs` = CLI + 公开再导出。拆分只为满足本仓「单文件 ≤ 250 纯行」（CONTRIBUTING.md）。
 *
 * 本模块**不做任何 fs 访问**：当前文件内容由调用方读好后注入，函数只返回"将要写什么"。
 * 纯 JS（不参与 `tsc`）；无第三方依赖。
 */

/** 托管块起始标记（写入 profile 用户 patch；用户不要手改块内内容）。 */
export const MANAGED_HEAD = "# >>> agentchat adapter (managed) — 由 adapters/dsh/install.mjs 维护，请勿手改"
/** 托管块结束标记。 */
export const MANAGED_TAIL = "# <<< agentchat adapter (managed)"
/** patch 文件由本安装器创建时写的一行说明（卸载时凭它判断"整份文件都是我们建的"→ 删除）。 */
const NEW_PATCH_HEADER =
  "# dsh profile 用户 patch 层（由 adapters/dsh/install.mjs 创建）：顶层是 YAML 数组，在每个 bundle 层之后生效。"

// ── 文本工具（保持原文件格式，便于卸载后逐字节还原）─────────────────

/** 探测换行风格：出现 CRLF 即视为 CRLF，否则 LF。 */
export function eolOf(text) {
  return typeof text === "string" && text.includes("\r\n") ? "\r\n" : "\n"
}

/** 从原文探测缩进单位（DSH 写的是 2 空格；探测失败退回 2 空格）。 */
function indentOf(text) {
  if (typeof text !== "string") return "  "
  const match = /^([ \t]+)"/m.exec(text)
  return match === null ? "  " : match[1]
}

/**
 * 按**原文的缩进 / 换行 / 末尾换行**风格序列化 JSON：卸载时才能逐字节还原。
 * （前提：原文件本身是"该风格下的规范格式"——DSH 生成的 profile manifest 满足这一点。）
 */
export function serializeJsonLike(value, original) {
  const indent = indentOf(original)
  const eol = eolOf(original)
  const trailing = original === undefined || original.endsWith("\n") ? eol : ""
  return `${JSON.stringify(value, null, indent).split("\n").join(eol)}${trailing}`
}

// ── 纯规划：profile 用户 patch（托管块）─────────────────────────────

/** 组装托管块（不含首尾多余空行）。 */
export function buildManagedBlock(nodeExe, bridgePath, eol) {
  const lines = [
    MANAGED_HEAD,
    "- insert:",
    "    - id: agentchat-mcp",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: agentchat",
    "        transport: stdio",
    `        command: '${nodeExe}'`,
    "        args:",
    `          - '${bridgePath}'`,
    MANAGED_TAIL,
  ]
  return lines.join(eol)
}

/** 吃掉一个行尾（LF 或 CRLF），返回新下标；没有行尾则原样返回。 */
function consumeEol(text, index) {
  if (text.startsWith("\r\n", index)) return index + 2
  return text[index] === "\n" ? index + 1 : index
}

/**
 * 找托管块跨度：`start` = HEAD 标记所在行的行首；`end` = TAIL 标记所在行行尾，
 * 外加安装器写入的那个尾部空行（最多吃两个行尾）。返回 `undefined` = 没有托管块。
 */
function managedSpan(text) {
  let head = text.indexOf(MANAGED_HEAD)
  while (head !== -1 && head !== 0 && text[head - 1] !== "\n") {
    // marker 必须整行起始（避免用户正文里恰好出现同名字符串时误判）
    head = text.indexOf(MANAGED_HEAD, head + 1)
  }
  if (head === -1) return undefined
  const tail = text.indexOf(MANAGED_TAIL, head)
  if (tail === -1) return undefined
  let end = tail + MANAGED_TAIL.length
  for (let n = 0; n < 2; n += 1) {
    const next = consumeEol(text, end)
    if (next === end) break
    end = next
  }
  return { start: head, end }
}

/** 去掉托管块后剩下的用户正文（用于顶层结构校验与"整份文件都是我们建的？"判断）。 */
function stripManaged(text) {
  const span = managedSpan(text)
  return span === undefined ? text : text.slice(0, span.start) + text.slice(span.end)
}

/** 该剩余内容是否只剩安装器创建时写的那行说明（→ 整份文件都是我们建的）。 */
function isOurPatchOnly(rest) {
  const lines = rest
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  return lines.length === 1 && lines[0] === NEW_PATCH_HEADER
}

/**
 * patch 层顶层必须是 YAML 数组：**只看顶格（第 0 列）的注释外行**是否都以 `-` 开头。
 *
 * 为什么不逐行卡"所有非注释行都以 `-` 开头"：YAML 列表项的**续行**（如 `- id: x` 下面的
 * `  name: ...`、以及本安装器写入的托管块内部缩进行）本来就顶格缩进，逐行卡会把合法文件误判为
 * 非列表——连 DSH 自己生成、或本安装器刚写过的 patch 文件都会被拒。顶格行全部以 `-` 开头，
 * 才等价于"顶层是数组"；若整份文件没有顶格行（全缩进），再退回逐行判断。
 */
function assertTopLevelList(text, path) {
  const meaningful = text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
  if (meaningful.length === 0) return
  const topLevel = meaningful.filter((line) => !/^[ \t]/.test(line))
  const checked = topLevel.length > 0 ? topLevel : meaningful
  const bad = checked.find((line) => !line.startsWith("-"))
  if (bad !== undefined) {
    throw new Error(
      `profile patch 顶层不是 YAML 数组（第 0 列出现非 "-" 开头的行：${bad.trim()}），拒绝改写：${path}`,
    )
  }
}

/**
 * 规划 patch 层（安装）。
 *
 * 卸载后逐字节还原的关键：托管块是**固定形状**，且块前恒定插入**恰好一个行尾**作分隔
 * （与用户正文原本是否以行尾结束无关）——于是卸载时"摘掉托管块 + 恰好一个块前分隔行尾"
 * 就是安装的逆运算，不需要知道原文是否以行尾结尾。用户正文本身从不被重写（只做切片拼接）。
 *
 * @returns {import("./install-plan.mjs").PlannedFile}
 */
export function planPatchInstall(path, current, block) {
  if (current === undefined) {
    return {
      path,
      content: `${NEW_PATCH_HEADER}\n${block}\n\n`,
      existed: false,
      change: true,
      kind: "yaml",
    }
  }
  const eol = eolOf(current)
  assertTopLevelList(stripManaged(current), path)
  const span = managedSpan(current)
  if (span !== undefined) {
    // 已有托管块 → 只替换块内文本（幂等，不会重复追加；块前的分隔行尾保持原样）
    const content = `${current.slice(0, span.start)}${block}${eol}${eol}${current.slice(span.end)}`
    return { path, content, existed: true, change: content !== current, kind: "yaml" }
  }
  if (current === "") {
    return { path, content: `${block}${eol}${eol}`, existed: true, change: true, kind: "yaml" }
  }
  const content = `${current}${eol}${block}${eol}${eol}`
  return { path, content, existed: true, change: true, kind: "yaml" }
}

/** 摘掉末尾恰好一个行尾（LF 或 CRLF）；没有则原样返回。 */
function stripOneEol(text) {
  if (text.endsWith("\r\n")) return text.slice(0, -2)
  return text.endsWith("\n") ? text.slice(0, -1) : text
}

/**
 * 规划 patch 层（卸载）：只摘掉托管块；若整份文件都是我们建的 → 删除该文件。
 *
 * @returns {import("./install-plan.mjs").PlannedFile}
 */
export function planPatchUninstall(path, current) {
  if (current === undefined) {
    return { path, content: null, existed: false, change: false, kind: "yaml" }
  }
  const span = managedSpan(current)
  if (span === undefined) {
    return { path, content: current, existed: true, change: false, kind: "yaml" }
  }
  const after = current.slice(span.end)
  // 块后还有用户内容时保留块前那个分隔行尾（否则用户正文的最后一行会与后文粘连）；
  // 块在文件末尾（后面只剩空白）时，分隔行尾是我们加的，连它一起摘掉才能逐字节还原。
  const before = after.trim() === "" ? stripOneEol(current.slice(0, span.start)) : current.slice(0, span.start)
  const rest = before + (after.trim() === "" ? "" : after)
  if (isOurPatchOnly(rest)) {
    return { path, content: null, existed: true, change: true, kind: "yaml" }
  }
  return { path, content: rest, existed: true, change: rest !== current, kind: "yaml" }
}
