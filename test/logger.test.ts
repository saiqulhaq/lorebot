import { describe, expect, test } from "bun:test"
import { makeLogger } from "../src/logger"

function capture() {
  const lines: string[] = []
  return { lines, write: (line: string) => lines.push(line) }
}

describe("makeLogger", () => {
  test("filters entries below the configured level", () => {
    const { lines, write } = capture()
    const log = makeLogger({ level: "warn", format: "pretty" }, write)
    log.debug("d")
    log.info("i")
    log.warn("w")
    log.error("e")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("WARN")
    expect(lines[1]).toContain("ERROR")
  })

  test("pretty format includes timestamp, level, component, and fields", () => {
    const { lines, write } = capture()
    const log = makeLogger({ level: "info", format: "pretty", component: "slack" }, write)
    log.info("question received", { channel: "C1", chars: 42 })
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.+ INFO {2}\[slack\] question received channel=C1 chars=42$/)
  })

  test("json format emits parseable single-line objects", () => {
    const { lines, write } = capture()
    const log = makeLogger({ level: "info", format: "json", component: "engine" }, write)
    log.info("session created", { session: "ses_1" })
    const entry = JSON.parse(lines[0]!)
    expect(entry.level).toBe("info")
    expect(entry.component).toBe("engine")
    expect(entry.msg).toBe("session created")
    expect(entry.session).toBe("ses_1")
    expect(entry.ts).toBeString()
  })

  test("child loggers nest component names and inherit the sink", () => {
    const { lines, write } = capture()
    const log = makeLogger({ level: "info", format: "pretty", component: "app" }, write)
    log.child("kb").info("synced")
    expect(lines[0]).toContain("[app.kb]")
  })

  test("serializes Error fields and drops undefined ones", () => {
    const { lines, write } = capture()
    const log = makeLogger({ level: "error", format: "json" }, write)
    log.error("boom", { error: new RangeError("out of range"), user: undefined })
    const entry = JSON.parse(lines[0]!)
    expect(entry.error).toBe("RangeError: out of range")
    expect("user" in entry).toBe(false)
  })
})
