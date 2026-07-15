import path from "node:path"
import { BOT_CONFIG_PATH, diffBotConfigs, loadBotConfig, watchBotConfig } from "./botconfig"
import { ConfigError, loadConfig } from "./config"
import { makeEngine } from "./engine"
import { installAgent, setupKb, startSyncLoop } from "./kb"
import { makeLogger } from "./logger"
import { type BotConfigRef, makeSlackApp } from "./slack"
import { SessionStore } from "./store"
import { requireSyncEnv } from "./sync/env"
import { startSyncScheduler } from "./sync/orchestrator"

async function main() {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      console.error("\nCopy .env.example to .env and fill in the blanks.")
      process.exit(1)
    }
    throw error
  }

  const log = makeLogger({ level: config.logLevel, format: config.logFormat })

  // Behavior config (lorebot.config.json) — hot-reloaded on save.
  const loaded = loadBotConfig()
  for (const problem of loaded.problems) log.warn("config problem", { problem })
  const botConfig: BotConfigRef = { current: loaded.config }

  const kbLog = log.child("kb")
  const kbDir = await setupKb(config, botConfig.current, kbLog)
  log.info("knowledge base ready", { dir: kbDir })

  const engine = makeEngine(config, kbDir, log.child("engine"))
  await engine.healthCheck()
  log.info("opencode server reachable", { url: config.opencodeUrl })

  // Graphify sync scheduler (second role). Missing credentials disable the
  // scheduler with an error log — the Slack role always keeps running.
  let stopSyncScheduler: (() => void) | undefined
  const startSync = () => {
    if (!botConfig.current.sync.enabled) return
    try {
      const syncEnv = requireSyncEnv(config)
      stopSyncScheduler = startSyncScheduler({ config, syncEnv, kbDir, log: log.child("sync") }, botConfig)
      log.info("graphify sync scheduler started", {
        apps: botConfig.current.sync.apps.length,
        intervalHours: botConfig.current.sync.intervalHours,
      })
    } catch (error) {
      log.error("graphify sync disabled", { error })
    }
  }

  const stopWatch = watchBotConfig(BOT_CONFIG_PATH, log.child("config"), (reloaded) => {
    for (const problem of reloaded.problems) log.warn("config problem", { problem })
    const changes = diffBotConfigs(botConfig.current, reloaded.config)
    if (changes.length === 0) return
    botConfig.current = reloaded.config
    if (config.manageAgent) installAgent(kbDir, reloaded.config, kbLog)
    if (changes.some((change) => change.startsWith("sync."))) {
      stopSyncScheduler?.()
      stopSyncScheduler = undefined
      startSync()
    }
    log.info("config reloaded", { changes })
  })
  startSync()

  // Pulls may update the graphify output; installAgent regenerates the graph
  // index (a no-op while the graphify manifest is unchanged).
  const stopSync = startSyncLoop(kbDir, config.syncIntervalMs, kbLog, () => {
    if (config.manageAgent) installAgent(kbDir, botConfig.current, kbLog)
  })
  if (config.syncIntervalMs > 0) {
    log.info("KB sync enabled", { intervalSeconds: config.syncIntervalMs / 1000 })
  }

  const store = new SessionStore(path.join(config.dataDir, "lorebot.db"))
  const app = await makeSlackApp(config, botConfig, store, engine, log.child("slack"))

  const shutdown = async () => {
    log.info("shutting down")
    stopSyncScheduler?.()
    stopWatch()
    stopSync()
    await app.stop().catch(() => {})
    store.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  await app.start()
  log.info(`${botConfig.current.agent.name} is running — mention it in Slack to ask a question`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
