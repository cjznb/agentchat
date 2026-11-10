/**
 * 「版本与更新」卡片（UI-1 ⑥；设置页内）——当前 Hub 版本 / 各适配器内置 vs 上报版本 /
 * 「检查更新」结果。**只读展示 + 手动升级步骤，不提供一键升级**（没有升级动作）。
 *
 * - API 经 props 注入（缺省真实实现），组件级测试不触碰网络
 * - 「检查更新」请求中按钮 disabled + 加载文案；失败**按 error 码给文案**，不 toast 成服务器错误
 * - 适配器 `outdated:true` 标红；`version:null`（从未上报）显示"未上报"，不猜
 */
import { useCallback, useEffect, useState } from "react"
import { checkVersion as realCheck, loadVersion as realLoad } from "../versionApi"
import {
  adapterStateLabel,
  adapterStateOf,
  adapterVersionText,
  formatCheckedAt,
  MANUAL_UPGRADE_STEPS,
  updateErrorMessage,
  type CheckOutcome,
  type VersionInfo,
} from "../version"

export interface VersionApi {
  readonly load: (signal?: AbortSignal) => Promise<VersionInfo>
  readonly check: (signal?: AbortSignal) => Promise<CheckOutcome>
}

const defaultApi: VersionApi = { load: realLoad, check: realCheck }

export function VersionCard({ api = defaultApi }: { readonly api?: VersionApi }) {
  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<CheckOutcome | null>(null)
  const [transportError, setTransportError] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void api
      .load(controller.signal)
      .then((value) => setInfo(value))
      .catch(() => setLoadFailed(true))
    return () => controller.abort()
  }, [api])

  const runCheck = useCallback(() => {
    if (checking) return
    setChecking(true)
    setTransportError(false)
    setResult(null)
    void api
      .check()
      .then((outcome) => setResult(outcome))
      .catch(() => setTransportError(true))
      .finally(() => setChecking(false))
  }, [api, checking])

  return (
    <section className="settings-block" data-testid="version-card">
      <h2>版本与更新</h2>
      {loadFailed ? (
        <p className="settings-hint" data-testid="version-load-error">
          无法读取版本信息（Hub 未响应或接口不可用）。
        </p>
      ) : info === null ? (
        <p className="settings-hint" data-testid="version-loading">
          正在读取版本…
        </p>
      ) : (
        <>
          <p className="version-line">
            当前 Hub 版本：
            <b data-testid="version-hub">v{info.hub.version}</b>
            <a
              className="version-link"
              data-testid="version-compare-link"
              href={info.hub.compareUrl}
              target="_blank"
              rel="noreferrer"
            >
              更新源
            </a>
          </p>
          <ul className="version-adapters" data-testid="version-adapters">
            {info.adapters.map((adapter) => {
              const state = adapterStateOf(adapter)
              return (
                <li
                  className="version-adapter"
                  data-testid="version-adapter"
                  data-vendor={adapter.vendor}
                  data-state={state}
                  key={adapter.vendor}
                >
                  <span className="version-adapter-name">{adapter.vendor}</span>
                  <span className="version-adapter-version">{adapterVersionText(adapter)}</span>
                  <span
                    className="version-adapter-state"
                    data-testid="version-adapter-state"
                    data-state={state}
                    title={state === "unknown" ? "适配器尚未上报版本" : undefined}
                  >
                    {adapterStateLabel(state)}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <div className="version-actions">
        <button
          type="button"
          className="settings-action"
          data-testid="version-check"
          disabled={checking}
          onClick={runCheck}
        >
          {checking ? "检查中…" : "检查更新"}
        </button>
      </div>

      {transportError ? (
        <p className="settings-error" role="alert" data-testid="version-check-error">
          无法连接 Hub 获取更新信息，请稍后重试。
        </p>
      ) : null}
      {result !== null && !result.ok ? (
        <p className="settings-error" role="alert" data-testid="version-check-error">
          {updateErrorMessage(result.code)}
          <span className="version-error-code" data-testid="version-error-code">
            （{result.code}）
          </span>
        </p>
      ) : null}
      {result !== null && result.ok ? (
        <div className="version-result" data-testid="version-result" data-cached={result.value.cached}>
          <p className="version-line">
            最新版本：<b data-testid="version-latest">v{result.value.latest}</b>
            <span
              className="version-flag"
              data-testid="version-update-available"
              data-available={result.value.updateAvailable}
            >
              {result.value.updateAvailable ? "有可用更新" : "已是最新"}
            </span>
          </p>
          <p className="settings-hint">
            比对 <code>{result.value.current}</code> → <code>{result.value.latest}</code>（检查
            {result.value.tagsChecked} 个 tag{result.value.cached ? "；10 分钟内已查过，结果来自缓存" : ""}）
          </p>
          <p className="version-line">
            差异对比：
            <a
              className="version-link"
              data-testid="version-result-compare"
              href={result.value.compareUrl}
              target="_blank"
              rel="noreferrer"
            >
              {result.value.compareUrl}
            </a>
          </p>
          <p className="settings-hint" data-testid="version-checked-at">
            检查时间：{formatCheckedAt(result.value.checkedAt)}
          </p>
          {result.value.adaptersOutdated.length > 0 ? (
            <ul className="version-outdated" data-testid="version-outdated">
              {result.value.adaptersOutdated.map((adapter) => (
                <li key={adapter.vendor}>
                  {adapter.vendor}：{adapterVersionText(adapter)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-hint" data-testid="version-outdated-empty">
              所有适配器都没有落后版本。
            </p>
          )}
          <div className="version-manual" data-testid="version-manual">
            <p className="settings-hint">
              <b>没有一键升级</b>：请手动执行以下步骤（升级动作不在本界面）。
            </p>
            <ol className="version-steps">
              {MANUAL_UPGRADE_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      ) : null}
    </section>
  )
}
