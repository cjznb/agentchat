/**
 * OpenCode 插件 API 的**最小本地类型声明**（只声明本适配器用到的子集）。
 *
 * 依据（实测，与已安装 `opencode-ai@1.18.32` 同版）：
 * - `@opencode-ai/plugin@1.18.32` `dist/index.d.ts`：`Plugin` / `PluginInput` / `Hooks`
 * - `@opencode-ai/sdk@1.18.32` `dist/gen/types.gen.d.ts`：`Session`、事件联合
 *   （`session.created` / `session.status` / `session.idle` / `session.deleted`）
 *   与 `client.session.promptAsync`（`/session/{id}/prompt_async`，204 受理）
 *
 * 刻意不把 `@opencode-ai/plugin` 加为依赖：它是含 `effect` / `@ai-sdk/provider` 的
 * 重型类型包，而插件只需编译期类型；运行时由宿主 OpenCode 加载本模块、注入 client，
 * 故本地声明即可让 `npm run typecheck` 覆盖（详见 task-2 报告）。
 */

/**
 * 事件里的会话信息（`@opencode-ai/sdk` `Session` 的子集；`parentID` 即子会话父引用）。
 *
 * 注意：**发布类型陈旧**——`@opencode-ai/sdk` 生成的 `dist` 未声明 `slug`/`time.archived`，
 * 但服务端运行期会返回；本适配器需要它们（归档过滤），故在此本地补声明。
 */
export interface OpencodeSession {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
  readonly slug?: string
  readonly directory?: string
  readonly time?: {
    readonly created?: number
    readonly updated?: number
    readonly compacting?: number
    readonly archived?: number
  }
}

/** 本适配器关心的事件子集（判别字段 `type`）。 */
export type OpencodeEvent =
  | { readonly type: "session.created"; readonly properties: { readonly info: OpencodeSession } }
  | { readonly type: "session.updated"; readonly properties: { readonly info: OpencodeSession } }
  | { readonly type: "session.deleted"; readonly properties: { readonly info: OpencodeSession } }
  | { readonly type: "session.idle"; readonly properties: { readonly sessionID: string } }
  | {
      readonly type: "session.status"
      readonly properties: {
        readonly sessionID: string
        readonly status: { readonly type: "idle" | "busy" | "retry" }
      }
    }

/**
 * `client.session.list` 的 query。
 *
 * **发布类型陈旧**：生成的类型只声明 `directory?`，但服务端实际支持 `scope`（`"project"` = 整个项目，
 * 否则由 client 自动注入 `?directory=<实例目录>`）、`roots`（仅根会话）、`limit`（默认 100，按
 * `time.updated` 倒序），另支持 `start`/`search`。运行期多传 query 会被序列化；此处本地补全形状，
 * 以免使用类型断言。
 */
export interface SessionListQuery {
  readonly directory?: string
  readonly scope?: "project"
  readonly roots?: boolean
  readonly limit?: number
  readonly start?: number
  readonly search?: string
}

/**
 * 注入与查询入口。`promptAsync` 为注入；`list`/`get` **在旧宿主可能缺失**，故声明为可选并在
 * 调用侧降级（**发布类型未声明 `list`/`get`**，服务端实为 `GET /session` 与 `GET /session/{id}`）。
 */
export interface OpencodeClient {
  readonly session: {
    promptAsync(input: {
      readonly path: { readonly id: string }
      readonly body: { readonly parts: readonly { readonly type: "text"; readonly text: string }[] }
    }): Promise<unknown>
    /** `GET /session` → `Session[]`（`limit`/`roots`/`scope` 见 `SessionListQuery`）。 */
    list?(input?: { readonly query?: SessionListQuery }): Promise<readonly OpencodeSession[]>
    /** `GET /session/{id}` → `Session`（不存在时抛错）。 */
    get?(input: { readonly path: { readonly id: string } }): Promise<OpencodeSession>
  }
}

/** 插件初始化上下文（`@opencode-ai/plugin` `PluginInput` 的子集）。 */
export interface PluginInput {
  readonly client: OpencodeClient
  readonly directory: string
  readonly worktree: string
}

/** 插件钩子（`Hooks` 子集）：事件流 + 销毁。 */
export interface Hooks {
  event?(input: { readonly event: OpencodeEvent }): Promise<void>
  dispose?(): Promise<void>
}

/** 插件工厂（`@opencode-ai/plugin` `Plugin`；宿主调用并传入 client）。 */
export type Plugin = (input: PluginInput, options?: Record<string, unknown>) => Promise<Hooks>
