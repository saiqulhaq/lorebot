import fs from "node:fs"
import path from "node:path"
import type { Logger } from "./logger"

/**
 * Behavior configuration (lorebot.config.json) — everything a non-developer
 * can customize: personality, permissions, answer formatting. Reloaded
 * automatically when the file changes. Secrets stay in .env, never here.
 */
export type BotConfig = {
  agent: {
    name: string
    personality: string
    systemPromptExtra: string
    steps: number
  }
  answers: {
    citeSources: boolean
    signOff: string
    notCoveredMessage: string
  }
  permissions: {
    allowedUsers: string[]
    blockedUsers: string[]
    allowedChannels: string[]
    sensitiveKeywords: string[]
    refusalMessage: string
  }
  features: {
    threadFollowUps: boolean
  }
  formatting: {
    /** 0 disables bullet truncation. */
    maxBulletPoints: number
    maxAnswerChars: number
  }
}

export const BOT_CONFIG_FILE = "lorebot.config.json"
export const BOT_CONFIG_PATH = path.join(import.meta.dir, "..", BOT_CONFIG_FILE)

export const DEFAULT_BOT_CONFIG: BotConfig = Object.freeze({
  agent: {
    name: "lorebot",
    personality: "Friendly and concise. Answers in the same language as the question.",
    systemPromptExtra: "",
    steps: 12,
  },
  answers: { citeSources: true, signOff: "", notCoveredMessage: "" },
  permissions: {
    allowedUsers: [],
    blockedUsers: [],
    allowedChannels: [],
    sensitiveKeywords: [],
    refusalMessage: "Sorry, I can't help with that topic here — please reach out to the right team directly.",
  },
  features: { threadFollowUps: true },
  formatting: { maxBulletPoints: 0, maxAnswerChars: 3900 },
})

/**
 * Validate a parsed JSON object into a BotConfig. Unknown fields and wrong
 * types are collected as problems (with the default kept), so one pass shows
 * everything to fix. A missing file section simply keeps defaults.
 */
export function validateBotConfig(raw: unknown): { config: BotConfig; problems: string[] } {
  const problems: string[] = []
  if (typeof raw !== "object" || raw === null) {
    return { config: DEFAULT_BOT_CONFIG, problems: ["config root must be a JSON object"] }
  }
  const root = raw as Record<string, any>

  const str = (pathName: string, value: unknown, fallback: string): string => {
    if (value === undefined) return fallback
    if (typeof value !== "string") {
      problems.push(`${pathName} must be a string`)
      return fallback
    }
    return value
  }
  const bool = (pathName: string, value: unknown, fallback: boolean): boolean => {
    if (value === undefined) return fallback
    if (typeof value !== "boolean") {
      problems.push(`${pathName} must be true or false`)
      return fallback
    }
    return value
  }
  const int = (pathName: string, value: unknown, fallback: number): number => {
    if (value === undefined) return fallback
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      problems.push(`${pathName} must be a non-negative integer`)
      return fallback
    }
    return value
  }
  const strArray = (pathName: string, value: unknown): string[] => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      problems.push(`${pathName} must be an array of strings`)
      return []
    }
    return value
  }

  const knownSections = ["agent", "answers", "permissions", "features", "formatting"]
  for (const key of Object.keys(root)) {
    if (!knownSections.includes(key)) problems.push(`unknown section "${key}" (known: ${knownSections.join(", ")})`)
  }

  const agent = root.agent ?? {}
  const answers = root.answers ?? {}
  const permissions = root.permissions ?? {}
  const features = root.features ?? {}
  const formatting = root.formatting ?? {}
  const d = DEFAULT_BOT_CONFIG

  const config: BotConfig = {
    agent: {
      name: str("agent.name", agent.name, d.agent.name),
      personality: str("agent.personality", agent.personality, d.agent.personality),
      systemPromptExtra: str("agent.systemPromptExtra", agent.systemPromptExtra, d.agent.systemPromptExtra),
      steps: int("agent.steps", agent.steps, d.agent.steps),
    },
    answers: {
      citeSources: bool("answers.citeSources", answers.citeSources, d.answers.citeSources),
      signOff: str("answers.signOff", answers.signOff, d.answers.signOff),
      notCoveredMessage: str("answers.notCoveredMessage", answers.notCoveredMessage, d.answers.notCoveredMessage),
    },
    permissions: {
      allowedUsers: strArray("permissions.allowedUsers", permissions.allowedUsers),
      blockedUsers: strArray("permissions.blockedUsers", permissions.blockedUsers),
      allowedChannels: strArray("permissions.allowedChannels", permissions.allowedChannels),
      sensitiveKeywords: strArray("permissions.sensitiveKeywords", permissions.sensitiveKeywords),
      refusalMessage: str("permissions.refusalMessage", permissions.refusalMessage, d.permissions.refusalMessage),
    },
    features: {
      threadFollowUps: bool("features.threadFollowUps", features.threadFollowUps, d.features.threadFollowUps),
    },
    formatting: {
      maxBulletPoints: int("formatting.maxBulletPoints", formatting.maxBulletPoints, d.formatting.maxBulletPoints),
      maxAnswerChars: int("formatting.maxAnswerChars", formatting.maxAnswerChars, d.formatting.maxAnswerChars),
    },
  }

  return { config, problems }
}

export function loadBotConfig(configPath: string = BOT_CONFIG_PATH): { config: BotConfig; problems: string[] } {
  if (!fs.existsSync(configPath)) {
    return { config: DEFAULT_BOT_CONFIG, problems: [] } // config file is optional
  }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { config: DEFAULT_BOT_CONFIG, problems: [`cannot parse ${configPath}: ${detail}`] }
  }
  return validateBotConfig(raw)
}

/** One line per changed leaf field, for reload logging. */
export function diffBotConfigs(before: BotConfig, after: BotConfig): string[] {
  const changes: string[] = []
  const walk = (a: Record<string, unknown>, b: Record<string, unknown>, prefix: string) => {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const pathName = prefix ? `${prefix}.${key}` : key
      const av = a[key]
      const bv = b[key]
      if (typeof av === "object" && av !== null && !Array.isArray(av)) {
        walk(av as Record<string, unknown>, bv as Record<string, unknown>, pathName)
      } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
        changes.push(`${pathName}: ${JSON.stringify(av)} → ${JSON.stringify(bv)}`)
      }
    }
  }
  walk(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, "")
  return changes
}

/**
 * Generate the read-only kb agent definition from the behavior config.
 * This is what gets installed into the KB clone's .opencode/agents/kb.md.
 */
export function buildAgentMarkdown(config: BotConfig): string {
  const rules = [
    "- Search the knowledge base (grep/glob, then read the relevant files) before\n  answering. Never answer from general knowledge alone.",
  ]
  if (config.answers.citeSources) {
    rules.push(
      '- Ground every claim in the documents. Cite sources as relative file paths in\n  backticks, e.g. `docs/onboarding.md`, at the end of the answer under\n  "Sources:".',
    )
  }
  rules.push(
    config.answers.notCoveredMessage
      ? `- If the knowledge base does not cover the question, reply with: "${config.answers.notCoveredMessage}" and suggest the closest related documents if any exist. Do not guess.`
      : "- If the knowledge base does not cover the question, say so plainly and do not\n  guess. Suggest the closest related documents if any exist.",
  )
  rules.push(
    "- Keep answers concise and Slack-friendly: short paragraphs, bullet lists,\n  bold key terms. No giant headings.",
  )
  if (config.answers.signOff) {
    rules.push(`- End every answer with: ${config.answers.signOff}`)
  }
  rules.push(
    "- For follow-up questions in the same conversation, use prior context but\n  re-check the documents when the follow-up introduces new topics.",
  )

  return `---
description: Answers team questions from the knowledge base. Read-only.
mode: primary
steps: ${config.agent.steps}
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: grep
    resource: "*"
    effect: allow
---

You are ${config.agent.name}, a knowledge-base assistant answering questions for a team over Slack.
The current directory is a git repository of markdown documents — this is the
only source of truth.

Personality: ${config.agent.personality}

Rules:

${rules.join("\n")}
${config.agent.systemPromptExtra ? `\n${config.agent.systemPromptExtra}\n` : ""}`
}

/** Case-insensitive check of a question against the sensitive keyword list. */
export function matchSensitiveKeyword(question: string, keywords: string[]): string | undefined {
  const haystack = question.toLowerCase()
  return keywords.find((keyword) => keyword && haystack.includes(keyword.toLowerCase()))
}

/**
 * Watch the config file and invoke onChange with a freshly loaded config
 * whenever it is modified. Debounced; parse failures keep the previous
 * config and are logged. Returns a stop function.
 */
export function watchBotConfig(
  configPath: string,
  log: Logger,
  onChange: (loaded: { config: BotConfig; problems: string[] }) => void,
): () => void {
  if (!fs.existsSync(configPath)) {
    log.debug("no config file to watch", { path: configPath })
    return () => {}
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const watcher = fs.watch(configPath, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!fs.existsSync(configPath)) return // deleted; keep current config
      onChange(loadBotConfig(configPath))
    }, 250)
  })
  return () => {
    clearTimeout(timer)
    watcher.close()
  }
}
