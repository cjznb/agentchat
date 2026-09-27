/**
 * JSONC 解析：剥离注释与尾逗号（字符串感知），供 OpenCode 安装器就地合并用户配置。
 *
 * 与合并策略（`install.mjs`）分离，使两文件各自单一职责且均在纯行上限内。
 * 改写后的活动文件为标准 JSON——原文可在 `<config>.bak` 找回。纯 JS；无第三方依赖。
 */

/** 剥离 `//` 行注释、`/* *\/` 块注释与尾逗号（字符串感知，不误伤字符串内的注释符）。 */
export function stripJsonc(text) {
  let out = ""
  let i = 0
  let inString = false
  let inLine = false
  let inBlock = false
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (ch === "\n") {
        inLine = false
        out += ch
      }
      i += 1
      continue
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += next ?? ""
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === "/" && next === "/") {
      inLine = true
      i += 2
      continue
    }
    if (ch === "/" && next === "*") {
      inBlock = true
      i += 2
      continue
    }
    if (ch === "}" || ch === "]") out = out.replace(/,\s*$/, "")
    out += ch
    i += 1
  }
  return out
}

/** 解析 JSONC 为对象（顶层非对象即报错，拒绝改写）。 */
export function parseConfig(text) {
  try {
    return JSON.parse(stripJsonc(text))
  } catch (error) {
    throw new Error(`目标配置不是合法 JSON/JSONC：${error instanceof Error ? error.message : String(error)}`)
  }
}
