import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client"
import { extractAnswer } from "../src/engine"

const T0 = 1_700_000_000_000

function assistant(overrides: {
  created: number
  content?: Array<{ type: string; text?: string }>
  finish?: string
  error?: unknown
}): SessionMessageInfo {
  return {
    id: `msg_${overrides.created}`,
    type: "assistant",
    agent: "kb",
    model: { id: "m", providerID: "p" },
    time: { created: overrides.created },
    content: overrides.content ?? [{ type: "text", text: "fallback" }],
    finish: overrides.finish ?? "stop",
    error: overrides.error,
  } as unknown as SessionMessageInfo
}

function user(created: number): SessionMessageInfo {
  return { id: `msg_u${created}`, type: "user", time: { created }, data: { text: "q" } } as unknown as SessionMessageInfo
}

describe("extractAnswer", () => {
  test("picks the newest assistant message after promptedAt", () => {
    // newest-first, as returned by message.list order=desc
    const messages = [
      assistant({ created: T0 + 500, content: [{ type: "text", text: "the answer" }] }),
      user(T0 + 100),
      assistant({ created: T0 - 100, content: [{ type: "text", text: "previous turn" }] }),
    ]
    expect(extractAnswer(messages, T0)).toBe("the answer")
  })

  test("ignores assistant messages from previous turns", () => {
    const messages = [assistant({ created: T0 - 100, content: [{ type: "text", text: "stale" }] })]
    expect(extractAnswer(messages, T0)).toBeUndefined()
  })

  test("joins multiple text parts and skips reasoning/tool parts", () => {
    const messages = [
      assistant({
        created: T0 + 1,
        content: [
          { type: "reasoning", text: "thinking..." },
          { type: "text", text: "part one" },
          { type: "tool" },
          { type: "text", text: "part two" },
        ],
      }),
    ]
    expect(extractAnswer(messages, T0)).toBe("part one\npart two")
  })

  test("throws on error finish", () => {
    const messages = [
      assistant({ created: T0 + 1, finish: "error", error: { message: "provider exploded" } }),
    ]
    expect(() => extractAnswer(messages, T0)).toThrow("provider exploded")
  })

  test("returns undefined when the only new assistant message has no text", () => {
    const messages = [assistant({ created: T0 + 1, content: [{ type: "tool" }] })]
    expect(extractAnswer(messages, T0)).toBeUndefined()
  })

  test("returns undefined for an empty list", () => {
    expect(extractAnswer([], T0)).toBeUndefined()
  })
})
