import { describe, expect, it } from "vitest"
import {
  AGENT_KIND,
  AGENT_STATUS,
  MCP_TOOL_INPUTS,
  MCP_TOOL_OUTPUTS,
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

  it("locks MCP_TOOLS to the twelve spec §9 tool names in order when read as an array", () => {
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
      "ask",
      "respond_ask",
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

describe("group mentions & ask discriminant extensions (Task 2)", () => {
  const askCard = {
    id: "ask-1",
    requesterAgentId: "agent-1",
    kind: "ask",
    target: "agent-2",
    action: "ask",
    payload: {},
    status: "pending",
    createdAt: 1,
  }

  const sendOutput = {
    message: {
      seq: 7,
      id: "m-7",
      conversationId: "conv-1",
      fromAgentId: "agent-1",
      body: "hi",
      kind: "text",
    },
    receipts: [{ agentId: "agent-2", stage: "delivered" }],
    readReceipts: [],
  }

  it("keeps MCP_TOOLS at exactly twelve entries and mcpToolNameSchema in sync when extended", () => {
    expect(MCP_TOOLS).toHaveLength(12)
    for (const name of MCP_TOOLS) expect(mcpToolNameSchema.parse(name)).toBe(name)
    expect(() => mcpToolNameSchema.parse("mentions")).toThrow()
  })

  it("accepts scope all|any and rejects an unknown scope when parsing wait input", () => {
    for (const scope of ["all", "any"] as const) {
      const parsed = MCP_TOOL_INPUTS.send.parse({ to: "agent-2", body: "hi", wait: { scope } })
      expect(parsed.wait?.scope).toBe(scope)
    }
    expect(() =>
      MCP_TOOL_INPUTS.send.parse({ to: "agent-2", body: "hi", wait: { scope: "none" } }),
    ).toThrow()
    expect(() =>
      MCP_TOOL_INPUTS.ask.parse({
        to: "human",
        question: "q",
        options: ["y"],
        wait: { scope: "every" },
      }),
    ).toThrow()
  })

  it("leaves wait.scope unset at the schema layer when omitted (server default belongs to Task 4)", () => {
    const parsed = MCP_TOOL_INPUTS.send.parse({ to: "agent-2", body: "hi", wait: {} })
    expect(parsed.wait).toEqual({ until: "either", timeoutMs: 285000 })
  })

  it("accepts string[] mentions and rejects non-string mentions when parsing send input", () => {
    const parsed = MCP_TOOL_INPUTS.send.parse({
      to: "agent-2",
      body: "hi",
      mentions: ["张三", "a1b2c3d4"],
    })
    expect(parsed.mentions).toEqual(["张三", "a1b2c3d4"])
    expect(() =>
      MCP_TOOL_INPUTS.send.parse({ to: "agent-2", body: "hi", mentions: ["张三", 42] }),
    ).toThrow()
    expect(() => MCP_TOOL_INPUTS.send.parse({ to: "agent-2", body: "hi", mentions: "张三" })).toThrow()
  })

  it("accepts string[] mentions and rejects non-string mentions when parsing ask input", () => {
    const parsed = MCP_TOOL_INPUTS.ask.parse({
      to: "group-1",
      question: "q",
      options: ["y"],
      mentions: ["*"],
    })
    expect(parsed.mentions).toEqual(["*"])
    expect(() =>
      MCP_TOOL_INPUTS.ask.parse({ to: "group-1", question: "q", options: ["y"], mentions: [{ id: "a" }] }),
    ).toThrow()
  })

  it("accepts an optional conversation filter and rejects a non-string when parsing roster input", () => {
    expect(MCP_TOOL_INPUTS.roster.parse({ conversation: "conv-1" }).conversation).toBe("conv-1")
    expect(MCP_TOOL_INPUTS.roster.parse({}).conversation).toBeUndefined()
    expect(() => MCP_TOOL_INPUTS.roster.parse({ conversation: 7 })).toThrow()
  })

  it("parses the send output with a mentions echo and stays green without the field (existing golden)", () => {
    const echo = { matched: [{ id: "a1b2c3d4", name: "张三" }], unmatched: ["错名"], scope: "explicit" }
    expect(MCP_TOOL_OUTPUTS.send.parse({ ...sendOutput, mentions: echo }).mentions).toEqual(echo)
    expect(MCP_TOOL_OUTPUTS.send.parse(sendOutput).mentions).toBeUndefined()
    expect(() =>
      MCP_TOOL_OUTPUTS.send.parse({ ...sendOutput, mentions: { ...echo, scope: "alll" } }),
    ).toThrow()
  })

  it("keeps the DM ask output {ask, reply} shape unchanged when parsed through the union", () => {
    const dm = { ask: askCard, reply: { timedOut: false, choice: "yes" } }
    expect(MCP_TOOL_OUTPUTS.ask.parse(dm)).toEqual(dm)
  })

  it("parses the group ask output {asks, reply} through the same union", () => {
    const group = {
      asks: [askCard],
      reply: {
        timedOut: true,
        replies: [{ target: "agent-2", choice: "yes" }],
        pending: ["agent-3"],
      },
    }
    expect(MCP_TOOL_OUTPUTS.ask.parse(group)).toEqual(group)
  })

  it("rejects an ask output that is neither the DM nor the group shape", () => {
    expect(() => MCP_TOOL_OUTPUTS.ask.parse({})).toThrow()
    expect(() => MCP_TOOL_OUTPUTS.ask.parse({ asks: "agent-2" })).toThrow()
    expect(() => MCP_TOOL_OUTPUTS.ask.parse({ asks: [askCard], reply: { timedOut: false } })).toThrow()
  })

  it("parses group list output with member_cards and stays green without it (existing golden)", () => {
    const withCards = {
      groups: [
        {
          id: "g-1",
          name: "调研群",
          created_by: "agent-1",
          members: ["a1b2c3d4"],
          member_cards: [{ id: "a1b2c3d4", name: "张三", status: "online" }],
        },
      ],
    }
    expect(MCP_TOOL_OUTPUTS.group.parse(withCards)).toEqual(withCards)
    const bare = { groups: [{ id: "g-1", name: null, created_by: "agent-1", members: [] }] }
    expect(MCP_TOOL_OUTPUTS.group.parse(bare)).toEqual(bare)
    expect(() =>
      MCP_TOOL_OUTPUTS.group.parse({
        groups: [{ id: "g-1", name: null, created_by: "agent-1", members: [], member_cards: [{ id: "a1b2c3d4", name: "张三" }] }],
      }),
    ).toThrow()
  })
})
