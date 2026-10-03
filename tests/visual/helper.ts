/**
 * 视觉仪器 helper —— 层1 确定性溢出断言（**按轴豁免**，V1.1） + 层2 区域截图产图 + 路由拦截 mock。
 *
 * 层1 按轴白名单（V1.1 冻结设计）：
 * ① **显式垂直滚动容器类清单**（styles.css 中 `overflow-y: auto|scroll` 的容器类，以 grep 为准）：
 *    清单内容器**只豁免 Y 轴**（`scrollHeight>clientHeight` 不报），**X 轴照报** ——
 *    旧「整元素豁免」会把 `.group-info`（overflow-y:auto）的横向溢出一并吞掉，修 1 这类
 *    bug 层1 永远扫不到。
 * ② TEXTAREA/INPUT/SELECT 元素级豁免（不变）。
 * ③ 类名含 composer-mention 豁免（不变）。
 * ④ 非清单内元素维持原判定：该轴非 auto|scroll 时溢出 >1px 即报。
 * 违规输出 {path/tag/class/超出像素} 清单：写入
 * `test-results/visual/<场景>-overflow.json` 并打进断言失败消息。
 * 扫描函数以**真函数**传入 evaluate（闭包外变量禁止）；DOM 访问经
 * globalThis 结构化窄化（不依赖 DOM lib 类型，运行期即真实 document/window）。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page } from "@playwright/test"
import {
  adminInfoResponse,
  agentCardResponse,
  actionableNotifications,
  approvals,
  conversationListResponse,
  groupListResponse,
  messagesByConversation,
  notifications,
  roster,
} from "./fixtures/api-fixtures"

/** 层2 产图根目录（test-results/ 已由 .gitignore 兜住）。 */
const OUT_DIR = join("test-results", "visual")

export interface OverflowOffender {
  readonly path: string
  readonly tag: string
  readonly className: string
  readonly overflowX: number
  readonly overflowY: number
}

/** evaluate 内使用的最小 DOM 结构面（纯类型，零运行期）。 */
interface ScanElement {
  readonly tagName: string
  readonly scrollWidth: number
  readonly clientWidth: number
  readonly scrollHeight: number
  readonly clientHeight: number
  readonly parentElement: ScanElement | null
  getAttribute(name: string): string | null
}

interface ScanScope {
  document: { querySelectorAll(selector: string): ArrayLike<ScanElement> }
  getComputedStyle(element: ScanElement): {
    overflowX: string
    overflowY: string
    textOverflow: string
  }
}

/** 全量路由拦截：spec 内不依赖任何 Hub 进程（绝对隔离）。 */
export async function mockApi(page: Page): Promise<void> {
  await page.route("**/api/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const path = url.pathname
    const respond = (payload: unknown, status = 200): Promise<void> =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) })

    if (method === "GET" && path === "/api/roster") return respond(roster)
    if (method === "GET" && path === "/api/conversations") return respond(conversationListResponse)
    if (method === "GET" && path === "/api/groups") return respond(groupListResponse)
    if (method === "GET" && path === "/api/approvals") return respond(approvals)
    if (method === "GET" && path === "/api/notifications") {
      return respond(
        url.searchParams.get("scope") === "actionable" ? actionableNotifications : notifications,
      )
    }
    if (method === "GET" && path === "/api/admin/info") return respond(adminInfoResponse)
    if (path.startsWith("/api/agents/")) return respond(agentCardResponse)
    const segments = path.split("/")
    if (segments[1] === "api" && segments[2] === "conversations" && segments.length === 5) {
      const conversationId = segments[3] ?? ""
      const tail = segments[4] ?? ""
      if (tail === "messages" && method === "GET") {
        return respond({ messages: messagesByConversation[conversationId] ?? [] })
      }
      if (tail === "read" && method === "POST") return respond({ ok: true, lastReadSeq: 6 })
    }
    return respond({ ok: false, error: "visual_fixture_not_mocked" }, 404)
  })
}

/** 打开应用；带 `conversationId` 时走深链直达会话（绕开列表折叠态不确定性）。 */
export async function openApp(page: Page, conversationId?: string): Promise<void> {
  await mockApi(page)
  await page.goto(conversationId === undefined ? "/" : `/?conversation=${conversationId}`)
  await expect(page.getByTestId("app-shell")).toBeVisible()
}

/** 层1：遍历 DOM，按**按轴**白名单判定溢出违规（阈值超出 clientWidth/Height 1px 即违规）。 */
export async function scanOverflow(page: Page): Promise<readonly OverflowOffender[]> {
  return page.evaluate<OverflowOffender[]>(() => {
    const scope = globalThis as unknown as ScanScope
    const offenders: OverflowOffender[] = []
    const pathOf = (element: ScanElement): string => {
      const parts: string[] = []
      let current: ScanElement | null = element
      let depth = 0
      while (current !== null && depth < 5) {
        const className =
          (current.getAttribute("class") ?? "")
            .trim()
            .split(" ")
            .filter((name) => name.length > 0)
            .slice(0, 2)
            .join(".") ?? ""
        parts.unshift(current.tagName.toLowerCase() + (className.length > 0 ? `.${className}` : ""))
        current = current.parentElement
        depth += 1
      }
      return parts.join(" > ")
    }
    // V1.1 按轴白名单：垂直滚动容器类（styles.css `overflow-y: auto|scroll`，以 grep 为准）。
    // 清单内只豁免 Y 轴，X 轴照报；其余元素维持原判定。
    const verticalScrollClasses = [
      "conversation-list",
      "chat-scroll",
      "org-tree",
      "group-body",
      "group-info",
      "notif-aside",
      "notif-list",
      "settings-body",
    ]
    const elements = scope.document.querySelectorAll("body *")
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index]
      if (element === undefined) continue
      const tag = element.tagName
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") continue
      const className = element.getAttribute("class") ?? ""
      if (className.indexOf("composer-mention") >= 0) continue
      const style = scope.getComputedStyle(element)
      // V1.1 ellipsis 豁免：有意截断（text-overflow: ellipsis）且已渲染（clientWidth>0 门槛）
      // 不报 X 轴；零宽/未布局元素不豁免，防吞真横向溢出。
      const isEllipsisClip = style.textOverflow === "ellipsis" && element.clientWidth > 0
      const canScrollX = style.overflowX === "auto" || style.overflowX === "scroll"
      const canScrollY = style.overflowY === "auto" || style.overflowY === "scroll"
      const excessX = element.scrollWidth - element.clientWidth
      const excessY = element.scrollHeight - element.clientHeight
      const classNames = className.split(" ").filter((name) => name.length > 0)
      const isVerticalContainer = verticalScrollClasses.some((name) => classNames.includes(name))
      // P2-5 方案A 有意延伸：rail 指示条负 right 越过按钮/动作区盒缘至 rail 边缘 —— X 轴白名单豁免。
      const intentionalXClasses = ["rail-button", "rail-actions"]
      const hasIntentionalX = intentionalXClasses.some((name) => classNames.includes(name))
      let overX: boolean
      if (isEllipsisClip || hasIntentionalX) overX = false
      else if (isVerticalContainer) overX = excessX > 1
      else overX = !canScrollX && excessX > 1
      const overY = isVerticalContainer ? false : !canScrollY && excessY > 1
      if (overX || overY) {
        offenders.push({
          path: pathOf(element),
          tag: tag.toLowerCase(),
          className,
          overflowX: overX ? excessX : 0,
          overflowY: overY ? excessY : 0,
        })
      }
    }
    return offenders
  })
}

/** 层1 断言：落盘 offender JSON + 失败消息携带全清单（如实记录，不放水）。 */
export async function expectNoOverflow(page: Page, scenario: string): Promise<void> {
  const offenders = await scanOverflow(page)
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(
    join(OUT_DIR, `${scenario}-overflow.json`),
    `${JSON.stringify(offenders, null, 2)}\n`,
    "utf8",
  )
  expect(
    offenders,
    `层1溢出违规 ${offenders.length} 处（清单：test-results/visual/${scenario}-overflow.json）：\n${JSON.stringify(offenders, null, 2)}`,
  ).toHaveLength(0)
}

/** 层2产图：`test-results/visual/<场景>-<区域>.png`；缺 region = 整页截图。 */
export async function shot(
  page: Page,
  scenario: string,
  region: string,
  target?: Locator,
): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true })
  const file = join(OUT_DIR, `${scenario}-${region}.png`)
  if (target === undefined) await page.screenshot({ path: file, fullPage: true })
  else await target.screenshot({ path: file })
}
