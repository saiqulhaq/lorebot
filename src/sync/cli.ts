/**
 * One-shot sync entrypoint for cron/CI use, independent of the Slack bot:
 *
 *   bun run sync [--force] [--only app1,app2] [--dry-run]
 *
 * Runs regardless of sync.enabled (that flag gates only the in-process
 * scheduler). Exits 1 if any app fails.
 */

import { loadBotConfig } from "../botconfig"
import { ConfigError, loadConfig } from "../config"
import { ensureKbClone } from "../kb"
import { makeLogger } from "../logger"
import { requireSyncEnv } from "./env"
import { runSyncOnce } from "./orchestrator"

function parseArgs(argv: string[]): { force: boolean; dryRun: boolean; only?: string[] } {
  const options = { force: false, dryRun: false, only: undefined as string[] | undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--force") options.force = true
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--only") {
      const value = argv[++i]
      if (!value) throw new ConfigError(["--only requires a comma-separated list of app names"])
      options.only = value.split(",").map((name) => name.trim()).filter(Boolean)
    } else {
      throw new ConfigError([`unknown argument "${arg}" (known: --force, --only <apps>, --dry-run)`])
    }
  }
  return options
}

async function main() {
  let args: ReturnType<typeof parseArgs>
  let config: ReturnType<typeof loadConfig>
  let syncEnv: ReturnType<typeof requireSyncEnv>
  try {
    args = parseArgs(process.argv.slice(2))
    config = loadConfig(process.env, { role: "sync" })
    syncEnv = requireSyncEnv(config)
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : error)
    process.exit(1)
  }

  const log = makeLogger({ level: config.logLevel, format: config.logFormat, component: "sync" })
  const { config: botConfig, problems } = loadBotConfig()
  for (const problem of problems) log.warn("config problem", { problem })

  const sync = botConfig.sync
  if (sync.apps.length === 0) {
    log.error("no apps configured in lorebot.config.json under sync.apps")
    process.exit(1)
  }
  if (args.only) {
    const known = new Set(sync.apps.map((app) => app.name))
    const unknown = args.only.filter((name) => !known.has(name))
    if (unknown.length > 0) {
      log.error("unknown app names in --only", { unknown, known: [...known] })
      process.exit(1)
    }
  }

  const kbDir = await ensureKbClone(config, log)
  const results = await runSyncOnce({ config, syncEnv, kbDir, log }, sync, args)
  const failed = results.filter((result) => result.status === "failed")
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
