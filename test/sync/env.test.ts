import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ConfigError, loadConfig } from "../../src/config"
import { requireSyncEnv } from "../../src/sync/env"

const slackEnv = {
  SLACK_BOT_TOKEN: "xoxb-1",
  SLACK_APP_TOKEN: "xapp-1",
  KB_DIR: "/tmp/kb",
}

describe("loadConfig sync additions", () => {
  test("sync env vars default sensibly and are optional", () => {
    const config = loadConfig(slackEnv)
    expect(config.githubAppId).toBeUndefined()
    expect(config.litellmBaseUrl).toBe("https://litellm.hhstaging.dev/v1")
    expect(config.graphifyBin).toBe("graphify")
  })

  test("sync role does not require Slack tokens", () => {
    const config = loadConfig({ KB_DIR: "/tmp/kb" }, { role: "sync" })
    expect(config.botToken).toBe("")
  })

  test("bot role still requires Slack tokens", () => {
    expect(() => loadConfig({ KB_DIR: "/tmp/kb" })).toThrow(ConfigError)
  })
})

describe("requireSyncEnv", () => {
  test("collects every missing variable in one error", () => {
    const config = loadConfig(slackEnv)
    try {
      requireSyncEnv(config)
      expect.unreachable()
    } catch (error) {
      const problems = (error as ConfigError).problems
      expect(problems.some((p) => p.includes("GITHUB_APP_ID"))).toBe(true)
      expect(problems.some((p) => p.includes("GITHUB_APP_INSTALLATION_ID"))).toBe(true)
      expect(problems.some((p) => p.includes("GITHUB_APP_PRIVATE_KEY_FILE"))).toBe(true)
      expect(problems.some((p) => p.includes("LITELLM_SERVICE_ACCOUNT_KEY"))).toBe(true)
    }
  })

  test("rejects a key file that is not a PEM", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-env-"))
    const keyFile = path.join(dir, "key.pem")
    fs.writeFileSync(keyFile, "not a key")
    const config = loadConfig({
      ...slackEnv,
      GITHUB_APP_ID: "1",
      GITHUB_APP_INSTALLATION_ID: "2",
      GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
      LITELLM_SERVICE_ACCOUNT_KEY: "sk-x",
    })
    expect(() => requireSyncEnv(config)).toThrow("does not look like a PEM key")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("resolves a complete environment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-env-"))
    const keyFile = path.join(dir, "key.pem")
    fs.writeFileSync(keyFile, "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n")
    const config = loadConfig({
      ...slackEnv,
      GITHUB_APP_ID: "1",
      GITHUB_APP_INSTALLATION_ID: "2",
      GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
      LITELLM_SERVICE_ACCOUNT_KEY: "sk-x",
      GRAPHIFY_BIN: "/opt/graphify",
    })
    const env = requireSyncEnv(config)
    expect(env.appId).toBe("1")
    expect(env.privateKeyPem).toContain("PRIVATE KEY")
    expect(env.graphifyBin).toBe("/opt/graphify")
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
