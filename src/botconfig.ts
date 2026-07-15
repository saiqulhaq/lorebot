import fs from "node:fs"
import path from "node:path"
import type { GraphifyConfig } from "./graphify"
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
  graphify: GraphifyConfig
  sync: SyncConfig
}

/** One app repo receiving a merged graph + KB doc copies. */
export type SyncAppConfig = {
  /** Slug used for DATA_DIR/sync/apps/<name>. */
  name: string
  /** "org/name" on github.com. */
  repo: string
  /** Target branch; defaults to the remote HEAD. */
  branch?: string
  /** App paths to include in the corpus; default: whole repo minus excludes. */
  docsPaths?: string[]
  /** Extra rsync excludes on top of the built-in defaults. */
  excludePaths?: string[]
}

export type SyncConfig = {
  /** Gates the in-process scheduler only; the `bun run sync` CLI always works. */
  enabled: boolean
  apps: SyncAppConfig[]
  intervalHours: number
  /** "pr" additionally requires pull_requests:write on the GitHub App. */
  pushMode: "direct" | "pr"
  /** Which KB paths count as "the PRD docs" copied into app repos. */
  kbPaths: string[]
  /** rsync exclude patterns applied to both app and KB mirrors (e.g. "*.png"). */
  excludePatterns: string[]
  /** Append " [skip ci]" to sync commits. */
  skipCi: boolean
  /** Build everything but log the would-be diff instead of pushing. */
  dryRun: boolean
  buildTimeoutMinutes: number
}

export const BOT_CONFIG_FILE = "lorebot.config.json"
export const BOT_CONFIG_PATH = path.join(import.meta.dir, "..", BOT_CONFIG_FILE)

/**
 * Gitignored deployment overrides, deep-merged over the base config. Keeps
 * company-specific settings (sync.apps, permissions) out of a public clone.
 */
export const LOCAL_CONFIG_FILE = "lorebot.config.local.json"
export const LOCAL_CONFIG_PATH = path.join(import.meta.dir, "..", LOCAL_CONFIG_FILE)

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
  graphify: { enabled: true, outputDir: "graphify-out" },
  sync: {
    enabled: false,
    apps: [],
    intervalHours: 24,
    pushMode: "direct",
    kbPaths: ["src/"],
    excludePatterns: [],
    skipCi: false,
    dryRun: false,
    buildTimeoutMinutes: 60,
  },
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
  // The value is joined onto the KB clone path, so keep it inside the clone.
  const dirName = (pathName: string, value: unknown, fallback: string): string => {
    if (value === undefined) return fallback
    if (typeof value !== "string" || value.trim() === "" || value.includes("..") || path.isAbsolute(value)) {
      problems.push(`${pathName} must be a relative directory name inside the knowledge base`)
      return fallback
    }
    return value
  }

  const knownSections = ["agent", "answers", "permissions", "features", "formatting", "graphify", "sync"]
  for (const key of Object.keys(root)) {
    if (!knownSections.includes(key)) problems.push(`unknown section "${key}" (known: ${knownSections.join(", ")})`)
  }

  const agent = root.agent ?? {}
  const answers = root.answers ?? {}
  const permissions = root.permissions ?? {}
  const features = root.features ?? {}
  const formatting = root.formatting ?? {}
  const graphify = root.graphify ?? {}
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
    graphify: {
      enabled: bool("graphify.enabled", graphify.enabled, d.graphify.enabled),
      outputDir: dirName("graphify.outputDir", graphify.outputDir, d.graphify.outputDir),
    },
    sync: validateSync(root.sync ?? {}),
  }

  function validateSync(sync: any): SyncConfig {
    const dirNames = (pathName: string, value: unknown, fallback: string[]): string[] => {
      if (value === undefined) return fallback
      const entries = strArray(pathName, value)
      return entries.map((entry, i) => dirName(`${pathName}[${i}]`, entry, "")).filter((e) => e !== "")
    }

    const apps: SyncAppConfig[] = []
    const seenNames = new Set<string>()
    if (sync.apps !== undefined && !Array.isArray(sync.apps)) {
      problems.push("sync.apps must be an array")
    }
    for (const [i, entry] of (Array.isArray(sync.apps) ? sync.apps : []).entries()) {
      const at = `sync.apps[${i}]`
      if (typeof entry !== "object" || entry === null) {
        problems.push(`${at} must be an object`)
        continue
      }
      const name = str(`${at}.name`, entry.name, "")
      const repo = str(`${at}.repo`, entry.repo, "")
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
        problems.push(`${at}.name must be a lowercase slug (a-z, 0-9, ., _, -), got "${name}"`)
        continue
      }
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        problems.push(`${at}.repo must look like "org/name", got "${repo}"`)
        continue
      }
      if (seenNames.has(name)) {
        problems.push(`${at}.name "${name}" is duplicated`)
        continue
      }
      seenNames.add(name)
      apps.push({
        name,
        repo,
        ...(entry.branch !== undefined ? { branch: str(`${at}.branch`, entry.branch, "") || undefined } : {}),
        ...(entry.docsPaths !== undefined ? { docsPaths: dirNames(`${at}.docsPaths`, entry.docsPaths, []) } : {}),
        ...(entry.excludePaths !== undefined
          ? { excludePaths: dirNames(`${at}.excludePaths`, entry.excludePaths, []) }
          : {}),
      })
    }

    const pushMode = sync.pushMode === undefined ? d.sync.pushMode : sync.pushMode
    if (pushMode !== "direct" && pushMode !== "pr") {
      problems.push(`sync.pushMode must be "direct" or "pr", got ${JSON.stringify(sync.pushMode)}`)
    }

    return {
      enabled: bool("sync.enabled", sync.enabled, d.sync.enabled),
      apps,
      intervalHours: int("sync.intervalHours", sync.intervalHours, d.sync.intervalHours),
      pushMode: pushMode === "pr" ? "pr" : "direct",
      kbPaths: sync.kbPaths === undefined ? d.sync.kbPaths : dirNames("sync.kbPaths", sync.kbPaths, d.sync.kbPaths),
      excludePatterns: strArray("sync.excludePatterns", sync.excludePatterns).filter((p) => p.trim() !== ""),
      skipCi: bool("sync.skipCi", sync.skipCi, d.sync.skipCi),
      dryRun: bool("sync.dryRun", sync.dryRun, d.sync.dryRun),
      buildTimeoutMinutes: int("sync.buildTimeoutMinutes", sync.buildTimeoutMinutes, d.sync.buildTimeoutMinutes),
    }
  }

  return { config, problems }
}

export function loadBotConfig(
  configPath: string = BOT_CONFIG_PATH,
  localPath: string = LOCAL_CONFIG_PATH,
): { config: BotConfig; problems: string[] } {
  const problems: string[] = []
  const readJson = (file: string): Record<string, unknown> => {
    if (!fs.existsSync(file)) return {} // both files are optional
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      problems.push(`cannot parse ${file}: ${detail}`)
      return {}
    }
  }

  const merged = deepMerge(readJson(configPath), readJson(localPath))
  const result = validateBotConfig(merged)
  return { config: result.config, problems: [...problems, ...result.problems] }
}

/** Local values win; objects merge recursively; arrays and scalars replace. */
function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key]
    if (
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
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
 * `graphifyPrompt` (from buildGraphifyPrompt) is appended when the KB ships a
 * knowledge graph, so the agent knows to navigate it.
 */
export function buildAgentMarkdown(config: BotConfig, graphifyPrompt = ""): string {
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
${graphifyPrompt ? `\n${graphifyPrompt}\n` : ""}${config.agent.systemPromptExtra ? `\n${config.agent.systemPromptExtra}\n` : ""}`
}

/** Case-insensitive check of a question against the sensitive keyword list. */
export function matchSensitiveKeyword(question: string, keywords: string[]): string | undefined {
  const haystack = question.toLowerCase()
  return keywords.find((keyword) => keyword && haystack.includes(keyword.toLowerCase()))
}

/**
 * Watch the base config and its local override, invoking onChange with a
 * freshly merged config on modification (including the local file appearing
 * for the first time). Debounced; parse failures keep the previous config
 * and are reported as problems. Returns a stop function.
 */
export function watchBotConfig(
  configPath: string,
  log: Logger,
  onChange: (loaded: { config: BotConfig; problems: string[] }) => void,
  localPath: string = LOCAL_CONFIG_PATH,
): () => void {
  const dir = path.dirname(configPath)
  if (!fs.existsSync(dir)) {
    log.debug("no config directory to watch", { dir })
    return () => {}
  }
  const watched = new Set([path.basename(configPath), path.basename(localPath)])
  let timer: ReturnType<typeof setTimeout> | undefined
  // Watching the directory (not the files) survives editors that replace
  // files on save and notices the local override being created later.
  const watcher = fs.watch(dir, (_event, filename) => {
    if (!filename || !watched.has(filename)) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      onChange(loadBotConfig(configPath, localPath))
    }, 250)
  })
  return () => {
    clearTimeout(timer)
    watcher.close()
  }
}
