/**
 * 「设置」面板（rail 第 5 个 tab）：数据/日志位置展示、清除本地界面状态、恢复出厂设置。
 *
 * - 恢复出厂设置需**手工逐字输入 `RESET`** 才可提交 → 调 `POST /api/admin/reset`
 * - 成功后自动清 `localStorage` 的 `agentchat:` 键并提示「请重启 Hub」
 * - 失败按服务端错误码给中文提示（`settings.ts` 的 `resetErrorMessage`）
 * API 经 props 注入（缺省真实实现），便于组件级测试。
 */
import { useCallback, useEffect, useState } from "react"
import type { AdminInfo, ResetResult } from "../../../shared/contracts"
import { loadAdminInfo, pruneSessions, resetHub, type PruneSessionsResult } from "../adminApi"
import { ApiError } from "../api"
import { MdScopeBlock } from "./MdScopeBlock"
import {
  clearAgentchatLocalStorage,
  isResetConfirmed,
  resetErrorMessage,
  resetRequestPayload,
  RESET_CONFIRM_WORD,
  type ResetRequest,
} from "../settings"

export interface SettingsApi {
  readonly loadInfo: () => Promise<AdminInfo>
  readonly reset: (request: ResetRequest) => Promise<ResetResult>
  readonly prune: (execute: boolean) => Promise<PruneSessionsResult>
}

const defaultApi: SettingsApi = {
  loadInfo: () => loadAdminInfo(),
  reset: (request) => resetHub(request.confirm, request.keepBackups),
  prune: (execute) => pruneSessions(execute),
}

function clearBrowserLocalState(): number {
  return typeof localStorage === "undefined" ? 0 : clearAgentchatLocalStorage(localStorage)
}

export function Settings({ api = defaultApi }: { readonly api?: SettingsApi }) {
  const [info, setInfo] = useState<AdminInfo | null>(null)
  const [confirmWord, setConfirmWord] = useState("")
  const [keepBackups, setKeepBackups] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [localNotice, setLocalNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prunePreview, setPrunePreview] = useState<PruneSessionsResult | null>(null)
  const [pruneError, setPruneError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .loadInfo()
      .then((value) => {
        if (!cancelled) setInfo(value)
      })
      .catch(() => {
        if (!cancelled) setInfo(null)
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const clearLocal = useCallback(() => {
    setLocalNotice(`已清除本地界面状态 ${clearBrowserLocalState()} 项。`)
  }, [])

  const canReset = isResetConfirmed(confirmWord) && !busy

  const startPrune = useCallback(() => {
    if (busy) return
    setBusy(true)
    setPruneError(null)
    void api
      .prune(false)
      .then((preview) => {
        if (preview.count === 0) {
          setLocalNotice("没有可清理的离线历史会话。")
        } else {
          setPrunePreview(preview)
        }
      })
      .catch((reason: unknown) => {
        setPruneError(`预览失败：${reason instanceof ApiError ? reason.code : "unknown"}`)
      })
      .finally(() => setBusy(false))
  }, [api, busy])

  const confirmPrune = useCallback(() => {
    if (prunePreview === null || busy) return
    setBusy(true)
    setPruneError(null)
    void api
      .prune(true)
      .then((result) => {
        setPrunePreview(null)
        setLocalNotice(`已退役 ${result.count} 个历史会话节点。`)
      })
      .catch((reason: unknown) => {
        setPruneError(`清理失败：${reason instanceof ApiError ? reason.code : "unknown"}`)
      })
      .finally(() => setBusy(false))
  }, [api, busy, prunePreview])

  const doReset = useCallback(() => {
    if (!isResetConfirmed(confirmWord) || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    void api
      .reset(resetRequestPayload(confirmWord, keepBackups))
      .then(() => {
        clearBrowserLocalState()
        setNotice("已重置，请重启 Hub。")
        setConfirmWord("")
      })
      .catch((reason: unknown) => {
        setError(resetErrorMessage(reason instanceof ApiError ? reason.code : undefined))
      })
      .finally(() => setBusy(false))
  }, [api, busy, confirmWord, keepBackups])

  const home = info?.home ?? "（未能读取，默认 ~/.agentchat）"
  const logs = info?.logsDir ?? "（未能读取，默认 ~/.agentchat/logs）"

  return (
    <section className="settings-panel" data-testid="settings-panel">
      <header className="view-header">
        <div>
          <p>本机数据</p>
          <h1 id="view-title">设置</h1>
        </div>
        <span className="mode-code">SETTINGS</span>
      </header>
      <div className="settings-body">
        <section className="settings-block">
          <h2>数据位置</h2>
          <dl className="settings-paths">
            <dt>数据目录</dt>
            <dd data-testid="settings-home">{home}</dd>
            <dt>日志目录</dt>
            <dd data-testid="settings-logs">{logs}</dd>
          </dl>
          <p className="settings-hint">
            查看日志：<code>tail -f {logs}/*.log</code>（Windows PowerShell：<code>Get-Content -Wait &lt;日志文件&gt;</code>）
          </p>
        </section>

        <section className="settings-block">
          <h2>清除本地状态</h2>
          <p className="settings-hint">清除浏览器保存的展开态、选人器等界面状态（不影响 Hub 数据）。</p>
          <button type="button" className="settings-action" data-testid="settings-clear-local" onClick={clearLocal}>
            清除本地状态
          </button>
          {localNotice !== null ? (
            <p className="settings-notice" data-testid="settings-local-notice">
              {localNotice}
            </p>
          ) : null}
        </section>

        <section className="settings-block">
          <h2>数据清理</h2>
          <p className="settings-hint">
            批量退役超过 1 小时无活动的历史测试会话节点（不可恢复；这些会话在 OpenCode 中重新打开时会注册为新节点）。
          </p>
          <button
            type="button"
            className="settings-action"
            data-testid="settings-prune"
            disabled={busy}
            onClick={startPrune}
          >
            清理离线历史会话
          </button>
          {prunePreview !== null ? (
            <div className="settings-confirm" role="alertdialog" data-testid="settings-prune-confirm">
              <p>
                将退役 {prunePreview.count} 个历史会话节点：
                {prunePreview.names.slice(0, 8).join("、")}
                {prunePreview.count > 8 ? "…" : ""}
              </p>
              <p className="settings-hint">退役不可恢复；这些会话在 OpenCode 中重新打开时会注册为新节点。</p>
              <button
                type="button"
                className="settings-danger"
                data-testid="settings-prune-confirm-btn"
                disabled={busy}
                onClick={confirmPrune}
              >
                确认清理
              </button>
              <button
                type="button"
                className="settings-action"
                data-testid="settings-prune-cancel"
                disabled={busy}
                onClick={() => setPrunePreview(null)}
              >
                取消
              </button>
            </div>
          ) : null}
          {pruneError !== null ? (
            <p className="settings-error" role="alert" data-testid="settings-prune-error">
              {pruneError}
            </p>
          ) : null}
        </section>

        <MdScopeBlock />

        <section className="settings-block is-danger">
          <h2>恢复出厂设置</h2>
          <p className="settings-hint">
            清除全部会话、节点与令牌，恢复为空库（Hub 会先做一致性快照）。请先备份，重置后**必须重启 Hub**。
          </p>
          <label className="settings-check">
            <input
              type="checkbox"
              data-testid="settings-keep-backups"
              checked={keepBackups}
              onChange={(event) => setKeepBackups(event.target.checked)}
            />
            <span>保留 backups/ 目录（不勾则一并清除）</span>
          </label>
          <label className="settings-confirm">
            <span>
              输入 <code>{RESET_CONFIRM_WORD}</code> 以确认
            </span>
            <input
              className="settings-input"
              data-testid="settings-reset-input"
              value={confirmWord}
              placeholder={RESET_CONFIRM_WORD}
              onChange={(event) => setConfirmWord(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="settings-danger"
            data-testid="settings-reset-button"
            disabled={!canReset}
            onClick={doReset}
          >
            恢复出厂设置
          </button>
          {notice !== null ? (
            <p className="settings-notice" role="status" data-testid="settings-reset-notice">
              {notice}
            </p>
          ) : null}
          {error !== null ? (
            <p className="settings-error" role="alert" data-testid="settings-reset-error">
              {error}
            </p>
          ) : null}
        </section>
      </div>
    </section>
  )
}
