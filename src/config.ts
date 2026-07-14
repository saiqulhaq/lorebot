import path from "node:path"
import { LOG_FORMATS, LOG_LEVELS, type LogFormat, type LogLevel } from "./logger"

export type Config = {
  botToken: string
  appToken: string
  kbRepoUrl?: string
  kbDirOverride?: string
  opencodeUrl: string
  opencodePassword?: string
  agent: string
  syncIntervalMs: number
  manageAgent: boolean
  linkBase?: string
  answerTimeoutMs: number
  dataDir: string
  logLevel: LogLevel
  logFormat: LogFormat
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const errors: string[] = []

  const required = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) errors.push(`${name} is required`)
    return value ?? ""
  }

  const integer = (name: string, fallback: number): number => {
    const raw = env[name]?.trim()
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0) {
      errors.push(`${name} must be a non-negative integer, got "${raw}"`)
      return fallback
    }
    return value
  }

  const botToken = required("SLACK_BOT_TOKEN")
  const appToken = required("SLACK_APP_TOKEN")

  const kbRepoUrl = env.KB_REPO_URL?.trim() || undefined
  const kbDirOverride = env.KB_DIR?.trim() || undefined
  if (!kbRepoUrl && !kbDirOverride) errors.push("one of KB_REPO_URL or KB_DIR is required")

  const logLevel = env.LOG_LEVEL?.trim() || "info"
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    errors.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}, got "${logLevel}"`)
  }

  const logFormat = env.LOG_FORMAT?.trim() || "pretty"
  if (!(LOG_FORMATS as readonly string[]).includes(logFormat)) {
    errors.push(`LOG_FORMAT must be one of ${LOG_FORMATS.join(", ")}, got "${logFormat}"`)
  }

  const config: Config = {
    botToken,
    appToken,
    kbRepoUrl,
    kbDirOverride,
    opencodeUrl: env.OPENCODE_URL?.trim() || "http://localhost:4096",
    opencodePassword: env.OPENCODE_SERVER_PASSWORD || undefined,
    agent: env.OPENCODE_AGENT?.trim() || "kb",
    syncIntervalMs: integer("KB_SYNC_INTERVAL_SECONDS", 300) * 1000,
    manageAgent: (env.KB_MANAGE_AGENT?.trim() || "true") !== "false",
    linkBase: env.KB_LINK_BASE?.trim() || undefined,
    answerTimeoutMs: integer("ANSWER_TIMEOUT_SECONDS", 300) * 1000,
    dataDir: path.resolve(env.DATA_DIR?.trim() || "./data"),
    logLevel: logLevel as LogLevel,
    logFormat: logFormat as LogFormat,
  }

  if (errors.length > 0) {
    throw new ConfigError(errors)
  }
  return Object.freeze(config)
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`)
    this.name = "ConfigError"
  }
}
