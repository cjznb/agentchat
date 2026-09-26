/**
 * 假适配器（spec §13.2 集成测试用内存版 `VendorAdapter`）：
 * 记录注入调用、可设定注入结果、状态上报经 `onState` 汇点直连 hub
 * （进程内等价于 `POST /internal/state`，与真实适配器同一条处理器代码路径）。
 */
import type { Message } from "../store/messages"
import type {
  AdapterInjectResult,
  AdapterState,
  VendorAdapter,
} from "./types"

export interface FakeAdapterOptions {
  /** 状态上报汇点（缺省 = 上报被忽略）。 */
  readonly onState?: (nodeId: string, state: AdapterState) => void
  /** 注入结果（缺省 `delivered`）。 */
  readonly outcome?: AdapterInjectResult
}

export interface RecordedInjection {
  readonly nodeId: string
  readonly msgs: readonly Message[]
}

export class FakeAdapter implements VendorAdapter {
  readonly id = "opencode" as const
  started = false
  /** 每次 `inject` 的录音（DoD 断言“inject 收到正确消息”）。 */
  readonly injections: RecordedInjection[] = []
  private outcome: AdapterInjectResult
  private readonly onState: ((nodeId: string, state: AdapterState) => void) | undefined

  constructor(options: FakeAdapterOptions = {}) {
    this.outcome = options.outcome ?? "delivered"
    this.onState = options.onState
  }

  start(): void {
    this.started = true
  }

  reportState(nodeId: string, state: AdapterState): void {
    this.onState?.(nodeId, state)
  }

  async inject(nodeId: string, msgs: readonly Message[]): Promise<AdapterInjectResult> {
    this.injections.push({ nodeId, msgs })
    return this.outcome
  }

  /** 测试控制注入结果（如连续拒收场景）。 */
  setOutcome(outcome: AdapterInjectResult): void {
    this.outcome = outcome
  }
}
