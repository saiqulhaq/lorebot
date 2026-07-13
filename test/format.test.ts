import { describe, expect, test } from "bun:test"
import { toMrkdwn } from "../src/format"

describe("toMrkdwn", () => {
  test("converts bold, links, and headings", () => {
    const input = "# Deploys\nUse **caution** and read [the guide](https://example.com/guide)."
    expect(toMrkdwn(input)).toBe("*Deploys*\nUse *caution* and read <https://example.com/guide|the guide>.")
  })

  test("leaves fenced code blocks untouched", () => {
    const input = "Run this:\n```\n# not a heading\n**not bold**\n```"
    expect(toMrkdwn(input)).toBe(input)
  })

  test("leaves non-citation inline code untouched", () => {
    expect(toMrkdwn("Use `git pull --ff-only` daily.")).toBe("Use `git pull --ff-only` daily.")
  })

  test("linkifies markdown-file citations when linkBase is set", () => {
    const output = toMrkdwn("Sources: `docs/onboarding.md`", "https://github.com/org/kb/blob/main")
    expect(output).toBe("Sources: <https://github.com/org/kb/blob/main/docs/onboarding.md|docs/onboarding.md>")
  })

  test("keeps citations as inline code without linkBase", () => {
    expect(toMrkdwn("Sources: `docs/onboarding.md`")).toBe("Sources: `docs/onboarding.md`")
  })

  test("truncates very long output", () => {
    const output = toMrkdwn("x".repeat(5000))
    expect(output.length).toBeLessThan(4000)
    expect(output).toEndWith("_…truncated_")
  })
})
