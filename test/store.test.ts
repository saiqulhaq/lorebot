import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionStore } from "../src/store"

let dir: string | undefined

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function tempDbPath(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-test-"))
  return path.join(dir, "test.db")
}

describe("SessionStore", () => {
  test("set/get/has/delete round-trip", () => {
    const store = new SessionStore(tempDbPath())
    const key = { channel: "C123", threadTs: "1700000000.000100" }

    expect(store.get(key)).toBeUndefined()
    expect(store.has(key)).toBe(false)

    store.set(key, "ses_abc")
    expect(store.get(key)).toBe("ses_abc")
    expect(store.has(key)).toBe(true)

    store.set(key, "ses_def")
    expect(store.get(key)).toBe("ses_def")

    store.delete(key)
    expect(store.has(key)).toBe(false)
    store.close()
  })

  test("keys are scoped by channel and thread", () => {
    const store = new SessionStore(tempDbPath())
    store.set({ channel: "C1", threadTs: "1.0" }, "ses_1")
    store.set({ channel: "C2", threadTs: "1.0" }, "ses_2")
    expect(store.get({ channel: "C1", threadTs: "1.0" })).toBe("ses_1")
    expect(store.get({ channel: "C2", threadTs: "1.0" })).toBe("ses_2")
    store.close()
  })

  test("persists across store instances on the same path", () => {
    const dbPath = tempDbPath()
    const first = new SessionStore(dbPath)
    first.set({ channel: "C1", threadTs: "9.9" }, "ses_persisted")
    first.close()

    const second = new SessionStore(dbPath)
    expect(second.get({ channel: "C1", threadTs: "9.9" })).toBe("ses_persisted")
    second.close()
  })
})
