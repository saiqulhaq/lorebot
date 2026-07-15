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
  githubAppId?: string
  githubAppInstallationId?: string
  githubAppPrivateKeyFile?: string
  litellmKey?: string
  litellmBaseUrl: string
  graphifyBin: string
  /** graphify --backend value; "openai" reaches any OpenAI-compatible proxy (LiteLLM, vLLM, …). */
  graphifyBackend: string
  /** Model name the backend should use (e.g. "minimax/MiniMax-M2.5" on LiteLLM). */
  graphifyModel?: string
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: { role?: "bot" | "sync" } = {},
): Config {
  const errors: string[] = []
  const role = options.role ?? "bot"

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

  // The sync CLI runs without Slack; the bot role requires both tokens.
  const botToken = role === "bot" ? required("SLACK_BOT_TOKEN") : env.SLACK_BOT_TOKEN?.trim() || ""
  const appToken = role === "bot" ? required("SLACK_APP_TOKEN") : env.SLACK_APP_TOKEN?.trim() || ""

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
    githubAppId: env.GITHUB_APP_ID?.trim() || undefined,
    githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID?.trim() || undefined,
    githubAppPrivateKeyFile: env.GITHUB_APP_PRIVATE_KEY_FILE?.trim() || undefined,
    litellmKey: env.LITELLM_SERVICE_ACCOUNT_KEY?.trim() || undefined,
    litellmBaseUrl: env.LITELLM_BASE_URL?.trim() || "https://litellm.hhstaging.dev/v1",
    graphifyBin: env.GRAPHIFY_BIN?.trim() || "graphify",
    graphifyBackend: env.GRAPHIFY_BACKEND?.trim() || "openai",
    graphifyModel: env.GRAPHIFY_MODEL?.trim() || undefined,
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
