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

describe("local config override", () => {
  test("deep-merges the local file over the base config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-local-"))
    const base = path.join(dir, "lorebot.config.json")
    const local = path.join(dir, "lorebot.config.local.json")
    fs.writeFileSync(base, JSON.stringify({ agent: { name: "public", steps: 5 }, formatting: { maxBulletPoints: 3 } }))
    fs.writeFileSync(
      local,
      JSON.stringify({
        agent: { name: "company" },
        sync: { enabled: true, apps: [{ name: "app1", repo: "org/app1" }] },
      }),
    )

    const { config, problems } = loadBotConfig(base, local)
    expect(problems).toEqual([])
    expect(config.agent.name).toBe("company") // local wins
    expect(config.agent.steps).toBe(5) // base survives the nested merge
    expect(config.formatting.maxBulletPoints).toBe(3)
    expect(config.sync.enabled).toBe(true)
    expect(config.sync.apps).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("a broken local file is reported but keeps the base config usable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-local-"))
    const base = path.join(dir, "lorebot.config.json")
    const local = path.join(dir, "lorebot.config.local.json")
    fs.writeFileSync(base, JSON.stringify({ agent: { name: "public" } }))
    fs.writeFileSync(local, "{ broken")

    const { config, problems } = loadBotConfig(base, local)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("cannot parse")
    expect(config.agent.name).toBe("public")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("missing local file is a silent no-op", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-local-"))
    const base = path.join(dir, "lorebot.config.json")
    fs.writeFileSync(base, JSON.stringify({ agent: { name: "solo" } }))
    const { config, problems } = loadBotConfig(base, path.join(dir, "lorebot.config.local.json"))
    expect(problems).toEqual([])
    expect(config.agent.name).toBe("solo")
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("loadBotConfig", () => {
  test("missing file falls back to defaults silently", () => {
    const { config, problems } = loadBotConfig("/nonexistent/lorebot.config.json", "/nonexistent/local.json")
    expect(problems).toEqual([])
    expect(config).toEqual(DEFAULT_BOT_CONFIG)
  })

  test("broken JSON reports a parse problem and keeps defaults", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-botconfig-"))
    const file = path.join(dir, "lorebot.config.json")
    fs.writeFileSync(file, "{ not json")
    const { config, problems } = loadBotConfig(file, path.join(dir, "none.local.json"))
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

describe("sync section validation", () => {
  test("defaults: disabled, no apps, daily direct pushes", () => {
    const { config, problems } = validateBotConfig({})
    expect(problems).toEqual([])
    expect(config.sync).toEqual({
      enabled: false,
      apps: [],
      intervalHours: 24,
      pushMode: "direct",
      kbPaths: ["src/"],
      excludePatterns: [],
      skipCi: false,
      dryRun: false,
      buildTimeoutMinutes: 60,
    })
  })

  test("accepts a full valid app entry", () => {
    const { config, problems } = validateBotConfig({
      sync: {
        enabled: true,
        pushMode: "pr",
        apps: [{ name: "hh-server", repo: "hungryhub-team/hh-server", branch: "main", docsPaths: ["docs/"] }],
      },
    })
    expect(problems).toEqual([])
    expect(config.sync.apps).toHaveLength(1)
    expect(config.sync.apps[0]!.docsPaths).toEqual(["docs/"])
    expect(config.sync.pushMode).toBe("pr")
  })

  test("rejects bad slugs, bad repos, and duplicates with indexed paths", () => {
    const { config, problems } = validateBotConfig({
      sync: {
        apps: [
          { name: "OK not", repo: "org/app" },
          { name: "app", repo: "no-slash" },
          { name: "dup", repo: "org/a" },
          { name: "dup", repo: "org/b" },
        ],
      },
    })
    expect(problems.some((p) => p.startsWith("sync.apps[0].name"))).toBe(true)
    expect(problems.some((p) => p.startsWith("sync.apps[1].repo"))).toBe(true)
    expect(problems.some((p) => p.includes('"dup" is duplicated'))).toBe(true)
    expect(config.sync.apps).toHaveLength(1) // only the first "dup" survives
  })

  test("rejects unknown pushMode and path escapes", () => {
    const { problems } = validateBotConfig({
      sync: { pushMode: "yolo", kbPaths: ["../etc"] },
    })
    expect(problems.some((p) => p.includes("sync.pushMode"))).toBe(true)
    expect(problems.some((p) => p.includes("sync.kbPaths[0]"))).toBe(true)
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
    const stop = watchBotConfig(
      file,
      silentLog,
      (loaded) => {
        seen = loaded.config.agent.name
      },
      path.join(dir, "lorebot.config.local.json"),
    )

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
