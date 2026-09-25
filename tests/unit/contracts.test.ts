import { describe, expect, it } from "vitest"
import {
  AGENT_KIND,
  AGENT_STATUS,
  MCP_TOOLS,
  RECEIPT_STAGES,
  WAIT_UNTIL,
  WS_EVENT_TYPES,
  agentKindSchema,
  agentStatusSchema,
  mcpToolNameSchema,
  receiptStageSchema,
  waitUntilSchema,
  wsEventSchema,
  wsEventTypeSchema,
} from "../../shared/contracts"

describe("locked contract values", () => {
  it("locks AGENT_STATUS to the four node states when read as an array", () => {
    expect(AGENT_STATUS).toEqual(["online", "busy", "offline", "retired"])
  })

  it("locks AGENT_KIND to runtime|logical when read as an array", () => {
    expect(AGENT_KIND).toEqual(["runtime", "logical"])
  })

  it("locks WAIT_UNTIL to the three wait modes when read as an array", () => {
    expect(WAIT_UNTIL).toEqual(["received", "message", "either"])
  })

  it("locks RECEIPT_STAGES to the four delivery stages in order when read as an array", () => {
    expect(RECEIPT_STAGES).toEqual(["queued", "sending", "delivered", "read"])
  })

  it("locks WS_EVENT_TYPES to the four envelope types when read as an array", () => {
    expect(WS_EVENT_TYPES).toEqual(["message", "receipt", "agent", "approval"])
  })

  it("locks MCP_TOOLS to the ten spec §9 tool names in order when read as an array", () => {
    expect(MCP_TOOLS).toEqual([
      "register",
      "send",
      "inbox",
      "ack",
      "roster",
      "conversation",
      "group",
      "shout",
      "status",
      "message_status",
    ])
  })
})

describe("zod schemas derived from the locked enums", () => {
  it("accepts every locked member and rejects an unknown value when parsing agent status", () => {
    for (const value of AGENT_STATUS) {
      expect(agentStatusSchema.parse(value)).toBe(value)
    }
    expect(() => agentStatusSchema.parse("sleeping")).toThrow()
  })

  it("accepts every locked member and rejects an unknown value when parsing agent kind", () => {
    for (const value of AGENT_KIND) {
      expect(agentKindSchema.parse(value)).toBe(value)
    }
    expect(() => agentKindSchema.parse("human")).toThrow()
  })

  it("accepts every locked member and rejects an unknown value when parsing wait mode", () => {
    for (const value of WAIT_UNTIL) {
      expect(waitUntilSchema.parse(value)).toBe(value)
    }
    expect(() => waitUntilSchema.parse("delivered")).toThrow()
  })

  it("accepts every locked member and rejects an unknown value when parsing receipt stage", () => {
    for (const value of RECEIPT_STAGES) {
      expect(receiptStageSchema.parse(value)).toBe(value)
    }
    expect(() => receiptStageSchema.parse("queued2")).toThrow()
  })

  it("accepts every locked member and rejects an unknown value when parsing WS event type", () => {
    for (const value of WS_EVENT_TYPES) {
      expect(wsEventTypeSchema.parse(value)).toBe(value)
    }
    expect(() => wsEventTypeSchema.parse("error")).toThrow()
  })

  it("accepts every locked member and rejects an unknown value when parsing MCP tool name", () => {
    for (const value of MCP_TOOLS) {
      expect(mcpToolNameSchema.parse(value)).toBe(value)
    }
    expect(() => mcpToolNameSchema.parse("call")).toThrow()
  })
})

describe("WS event envelope", () => {
  it("round-trips a {type, seq, payload} envelope when the shape matches the spec", () => {
    const envelope = { type: "message", seq: 42, payload: { id: "m1" } }
    expect(wsEventSchema.parse(envelope)).toEqual(envelope)
  })

  it("rejects the envelope when type is outside WS_EVENT_TYPES", () => {
    expect(() => wsEventSchema.parse({ type: "error", seq: 1, payload: null })).toThrow()
  })

  it("rejects the envelope when seq is not a non-negative integer", () => {
    expect(() => wsEventSchema.parse({ type: "message", seq: -1, payload: null })).toThrow()
    expect(() => wsEventSchema.parse({ type: "message", seq: 1.5, payload: null })).toThrow()
  })
})
