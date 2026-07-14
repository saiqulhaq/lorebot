import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  buildAgentMarkdown,
  DEFAULT_BOT_CONFIG,
  diffBotConfigs,
  loadBotConfig,
  matchSensitiveKeyword,
  validateBotConfig,
  watchBotConfig,
} from "../src/botconfig"
import { makeLogger } from "../src/logger"

const silentLog = makeLogger({ level: "error", format: "pretty" }, () => {})

describe("validateBotConfig", () => {
  test("empty object yields all defaults with no problems", () => {
    const { config, problems } = validateBotConfig({})
    expect(problems).toEqual([])
    expect(config).toEqual(DEFAULT_BOT_CONFIG)
  })

  test("collects type problems while keeping defaults", () => {
    const { config, problems } = validateBotConfig({
      agent: { steps: "twelve", name: 5 },
      permissions: { allowedUsers: "U123" },
    })
    expect(problems).toContain("agent.steps must be a non-negative integer")
    expect(problems).toContain("agent.name must be a string")
    expect(problems).toContain("permissions.allowedUsers must be an array of strings")
    expect(config.agent.steps).toBe(12)
    expect(config.agent.name).toBe("lorebot")
  })

  test("flags unknown sections (typo protection)", () => {
    const { problems } = validateBotConfig({ premissions: {} })
    expect(problems.some((p) => p.includes('unknown section "premissions"'))).toBe(true)
  })
})

describe("loadBotConfig", () => {
  test("missing file falls back to defaults silently", () => {
    const { config, problems } = loadBotConfig("/nonexistent/lorebot.config.json")
    expect(problems).toEqual([])
    expect(config).toEqual(DEFAULT_BOT_CONFIG)
  })

  test("broken JSON reports a parse problem and keeps defaults", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-botconfig-"))
    const file = path.join(dir, "lorebot.config.json")
    fs.writeFileSync(file, "{ not json")
    const { config, problems } = loadBotConfig(file)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("cannot parse")
    expect(config).toEqual(DEFAULT_BOT_CONFIG)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("diffBotConfigs", () => {
  test("reports changed leaf fields with paths", () => {
    const after = structuredClone(DEFAULT_BOT_CONFIG)
    after.agent.personality = "Grumpy."
    after.permissions.blockedUsers = ["U666"]
    const changes = diffBotConfigs(DEFAULT_BOT_CONFIG, after)
    expect(changes).toHaveLength(2)
    expect(changes.some((c) => c.startsWith("agent.personality:"))).toBe(true)
    expect(changes.some((c) => c.startsWith("permissions.blockedUsers:"))).toBe(true)
  })

  test("identical configs produce no changes", () => {
    expect(diffBotConfigs(DEFAULT_BOT_CONFIG, structuredClone(DEFAULT_BOT_CONFIG))).toEqual([])
  })
})

describe("buildAgentMarkdown", () => {
  test("embeds name, personality, and steps", () => {
    const config = structuredClone(DEFAULT_BOT_CONFIG)
    config.agent.name = "HubBot"
    config.agent.personality = "Terse and formal."
    config.agent.steps = 7
    const md = buildAgentMarkdown(config)
    expect(md).toContain("You are HubBot,")
    expect(md).toContain("Personality: Terse and formal.")
    expect(md).toContain("steps: 7")
  })

  test("keeps the read-only permission ruleset", () => {
    const md = buildAgentMarkdown(DEFAULT_BOT_CONFIG)
    expect(md).toContain('action: "*"')
    expect(md).toContain("effect: deny")
    expect(md).toContain("action: read")
  })

  test("citeSources false omits the citation rule", () => {
    const config = structuredClone(DEFAULT_BOT_CONFIG)
    config.answers.citeSources = false
    expect(buildAgentMarkdown(config)).not.toContain("Sources:")
  })

  test("signOff and custom not-covered message appear as rules", () => {
    const config = structuredClone(DEFAULT_BOT_CONFIG)
    config.answers.signOff = "— HubBot"
    config.answers.notCoveredMessage = "Not in our docs, sorry!"
    const md = buildAgentMarkdown(config)
    expect(md).toContain("End every answer with: — HubBot")
    expect(md).toContain('reply with: "Not in our docs, sorry!"')
  })

  test("systemPromptExtra is appended", () => {
    const config = structuredClone(DEFAULT_BOT_CONFIG)
    config.agent.systemPromptExtra = "Never mention competitors."
    expect(buildAgentMarkdown(config)).toContain("Never mention competitors.")
  })
})

describe("matchSensitiveKeyword", () => {
  test("matches case-insensitively", () => {
    expect(matchSensitiveKeyword("What is the SALARY range?", ["salary", "equity"])).toBe("salary")
  })
  test("returns undefined when nothing matches or list is empty", () => {
    expect(matchSensitiveKeyword("How do I deploy?", ["salary"])).toBeUndefined()
    expect(matchSensitiveKeyword("anything", [])).toBeUndefined()
  })
})

describe("watchBotConfig", () => {
  test("invokes onChange with the freshly loaded config after a write", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-watch-"))
    const file = path.join(dir, "lorebot.config.json")
    fs.writeFileSync(file, JSON.stringify({ agent: { name: "before" } }))

    let seen: string | undefined
    const stop = watchBotConfig(file, silentLog, (loaded) => {
      seen = loaded.config.agent.name
    })

    fs.writeFileSync(file, JSON.stringify({ agent: { name: "after" } }))
    const deadline = Date.now() + 3000
    while (seen === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    stop()
    fs.rmSync(dir, { recursive: true, force: true })
    expect(seen).toBe("after")
  })
})
