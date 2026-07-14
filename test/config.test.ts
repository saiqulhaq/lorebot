import { describe, expect, test } from "bun:test"
import { ConfigError, loadConfig } from "../src/config"

const valid = {
  SLACK_BOT_TOKEN: "xoxb-1",
  SLACK_APP_TOKEN: "xapp-1",
  KB_REPO_URL: "git@github.com:org/kb.git",
}

describe("loadConfig", () => {
  test("accepts a minimal valid environment with defaults", () => {
    const config = loadConfig(valid)
    expect(config.opencodeUrl).toBe("http://localhost:4096")
    expect(config.agent).toBe("kb")
    expect(config.syncIntervalMs).toBe(300_000)
    expect(config.answerTimeoutMs).toBe(300_000)
    expect(config.manageAgent).toBe(true)
    expect(config.logLevel).toBe("info")
    expect(config.logFormat).toBe("pretty")
  })

  test("collects all missing required vars in one error", () => {
    try {
      loadConfig({})
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      const problems = (error as ConfigError).problems
      expect(problems).toContain("SLACK_BOT_TOKEN is required")
      expect(problems).toContain("SLACK_APP_TOKEN is required")
      expect(problems).toContain("one of KB_REPO_URL or KB_DIR is required")
    }
  })

  test("KB_DIR alone satisfies the knowledge-base requirement", () => {
    const config = loadConfig({ ...valid, KB_REPO_URL: undefined, KB_DIR: "/tmp/kb" })
    expect(config.kbDirOverride).toBe("/tmp/kb")
    expect(config.kbRepoUrl).toBeUndefined()
  })

  test("rejects non-integer intervals", () => {
    expect(() => loadConfig({ ...valid, KB_SYNC_INTERVAL_SECONDS: "abc" })).toThrow(ConfigError)
    expect(() => loadConfig({ ...valid, ANSWER_TIMEOUT_SECONDS: "-5" })).toThrow(ConfigError)
  })

  test("sync interval of 0 disables syncing", () => {
    const config = loadConfig({ ...valid, KB_SYNC_INTERVAL_SECONDS: "0" })
    expect(config.syncIntervalMs).toBe(0)
  })

  test("KB_MANAGE_AGENT=false disables agent install", () => {
    const config = loadConfig({ ...valid, KB_MANAGE_AGENT: "false" })
    expect(config.manageAgent).toBe(false)
  })

  test("rejects unknown log levels", () => {
    expect(() => loadConfig({ ...valid, LOG_LEVEL: "verbose" })).toThrow(ConfigError)
  })

  test("accepts warn and error log levels", () => {
    expect(loadConfig({ ...valid, LOG_LEVEL: "warn" }).logLevel).toBe("warn")
    expect(loadConfig({ ...valid, LOG_LEVEL: "error" }).logLevel).toBe("error")
  })

  test("accepts json log format and rejects unknown ones", () => {
    expect(loadConfig({ ...valid, LOG_FORMAT: "json" }).logFormat).toBe("json")
    expect(() => loadConfig({ ...valid, LOG_FORMAT: "xml" })).toThrow(ConfigError)
  })
})
