import fs from "node:fs"
import { type Config, ConfigError } from "../config"

/** Everything the sync subsystem needs beyond the base config, fully resolved. */
export type SyncEnv = {
  appId: string
  installationId: string
  privateKeyPem: string
  litellmKey: string
  litellmBaseUrl: string
  graphifyBin: string
  graphifyBackend: string
  graphifyModel?: string
}

/**
 * Resolve and validate the sync credentials. Collects every problem so a
 * misconfigured deployment is fixed in one pass. The bot role catches this
 * and disables sync; the CLI exits with the message.
 */
export function requireSyncEnv(config: Config): SyncEnv {
  const problems: string[] = []

  if (!config.githubAppId) problems.push("GITHUB_APP_ID is required for sync")
  if (!config.githubAppInstallationId) problems.push("GITHUB_APP_INSTALLATION_ID is required for sync")
  if (!config.litellmKey) problems.push("LITELLM_SERVICE_ACCOUNT_KEY is required for sync (graph builds call an LLM)")

  let privateKeyPem = ""
  if (!config.githubAppPrivateKeyFile) {
    problems.push("GITHUB_APP_PRIVATE_KEY_FILE is required for sync")
  } else if (!fs.existsSync(config.githubAppPrivateKeyFile)) {
    problems.push(`GITHUB_APP_PRIVATE_KEY_FILE points to "${config.githubAppPrivateKeyFile}" but it does not exist`)
  } else {
    privateKeyPem = fs.readFileSync(config.githubAppPrivateKeyFile, "utf8")
    if (!privateKeyPem.includes("PRIVATE KEY-----")) {
      problems.push(`GITHUB_APP_PRIVATE_KEY_FILE "${config.githubAppPrivateKeyFile}" does not look like a PEM key`)
    }
  }

  if (problems.length > 0) throw new ConfigError(problems)

  return {
    appId: config.githubAppId!,
    installationId: config.githubAppInstallationId!,
    privateKeyPem,
    litellmKey: config.litellmKey!,
    litellmBaseUrl: config.litellmBaseUrl,
    graphifyBin: config.graphifyBin,
    graphifyBackend: config.graphifyBackend,
    graphifyModel: config.graphifyModel,
  }
}
