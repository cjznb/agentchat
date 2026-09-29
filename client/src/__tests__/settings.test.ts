/**
 * 设置面板纯函数单测（`client/src/settings.ts`）：
 * 确认词精确匹配、`agentchat:` 前缀 localStorage 清理（不误删他人键）、错误码中文映射。
 */
import { describe, expect, it } from "vitest"
import {
  clearAgentchatLocalStorage,
  isResetConfirmed,
  LOCAL_STORAGE_PREFIX,
  RESET_CONFIRM_WORD,
  resetErrorMessage,
  resetRequestPayload,
  type LocalStorageLike,
} from "../settings"

/** 内存版 storage（保持插入顺序、`key(i)` 按序返回）。 */
function fakeStorage(entries: Readonly<Record<string, string>>): LocalStorageLike & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(entries))
  return {
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  }
}

describe("确认词门槛", () => {
  it("常量与精确匹配", () => {
    expect(RESET_CONFIRM_WORD).toBe("RESET")
    expect(isResetConfirmed("RESET")).toBe(true)
    expect(isResetConfirmed("reset")).toBe(false)
    expect(isResetConfirmed(" RESET")).toBe(false)
    expect(isResetConfirmed("RESET ")).toBe(false)
    expect(isResetConfirmed("")).toBe(false)
  })
})

describe("localStorage 清理", () => {
  it("只清 agentchat: 前缀键，保留他人键；返回清理数量", () => {
    const storage = fakeStorage({
      "agentchat:expandedRoots": "[]",
      "agentchat:expandedTree:v2": "[]",
      "agentchat:expandedPicker": "[]",
      other: "keep",
      "user:setting": "keep",
    })
    const removed = clearAgentchatLocalStorage(storage)
    expect(removed).toBe(3)
    expect(storage.dump()).toEqual({ other: "keep", "user:setting": "keep" })
    expect(LOCAL_STORAGE_PREFIX).toBe("agentchat:")
  })

  it("无匹配键时返回 0 且不改动", () => {
    const storage = fakeStorage({ other: "keep" })
    expect(clearAgentchatLocalStorage(storage)).toBe(0)
    expect(storage.dump()).toEqual({ other: "keep" })
  })
})

describe("恢复出厂请求体（keepBackups）", () => {
  it("不勾选 → 省略 keepBackups 键（与端点可选语义一致 = 清 backups/）", () => {
    const payload = resetRequestPayload("RESET", false)
    expect(payload).toEqual({ confirm: "RESET" })
    expect(payload).not.toHaveProperty("keepBackups")
  })

  it("勾选 → 显式 keepBackups: true", () => {
    expect(resetRequestPayload("RESET", true)).toEqual({ confirm: "RESET", keepBackups: true })
  })

  it("确认词门槛不受影响（仍要求精确 RESET）", () => {
    expect(isResetConfirmed("RESET")).toBe(true)
    expect(isResetConfirmed("reset")).toBe(false)
    expect(resetRequestPayload("RESET", true).confirm).toBe(RESET_CONFIRM_WORD)
  })
})

describe("错误码中文映射", () => {
  it("已知错误码给出对应中文提示", () => {
    expect(resetErrorMessage("forbidden")).toContain("本机")
    expect(resetErrorMessage("invalid_body")).toContain("RESET")
    expect(resetErrorMessage("snapshot_failed")).toContain("快照")
    expect(resetErrorMessage("db_clear_failed")).toContain("数据库")
  })

  it("未知/缺失错误码回落到通用提示", () => {
    expect(resetErrorMessage(undefined)).toContain("重试")
    expect(resetErrorMessage("mystery")).toContain("重试")
  })
})
