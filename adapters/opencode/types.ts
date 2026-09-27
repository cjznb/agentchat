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

/** 事件里的会话信息（`@opencode-ai/sdk` `Session` 的子集；`parentID` 即子会话父引用）。 */
export interface OpencodeSession {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
}

/** 本适配器关心的事件子集（判别字段 `type`）。 */
export type OpencodeEvent =
  | { readonly type: "session.created"; readonly properties: { readonly info: OpencodeSession } }
  | { readonly type: "session.deleted"; readonly properties: { readonly info: OpencodeSession } }
  | { readonly type: "session.idle"; readonly properties: { readonly sessionID: string } }
  | {
      readonly type: "session.status"
      readonly properties: {
        readonly sessionID: string
        readonly status: { readonly type: "idle" | "busy" | "retry" }
      }
    }

/** 注入入口：`client.session.promptAsync`（相对 `/session/{id}/prompt_async`，立即返回 204）。 */
export interface OpencodeClient {
  readonly session: {
    promptAsync(input: {
      readonly path: { readonly id: string }
      readonly body: { readonly parts: readonly { readonly type: "text"; readonly text: string }[] }
    }): Promise<unknown>
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
