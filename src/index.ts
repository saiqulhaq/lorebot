import path from "node:path"
import { ConfigError, loadConfig } from "./config"
import { makeEngine } from "./engine"
import { setupKb, startSyncLoop } from "./kb"
import { makeSlackApp } from "./slack"
import { SessionStore } from "./store"

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

  const kbDir = await setupKb(config)
  console.log(`Knowledge base: ${kbDir}`)

  const engine = makeEngine(config, kbDir)
  await engine.healthCheck()
  console.log(`OpenCode server: ${config.opencodeUrl} ✓`)

  const stopSync = startSyncLoop(kbDir, config.syncIntervalMs)
  if (config.syncIntervalMs > 0) {
    console.log(`KB sync: git pull every ${config.syncIntervalMs / 1000}s`)
  }

  const store = new SessionStore(path.join(config.dataDir, "lorebot.db"))
  const app = await makeSlackApp(config, store, engine)

  const shutdown = async () => {
    console.log("Shutting down...")
    stopSync()
    await app.stop().catch(() => {})
    store.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  await app.start()
  console.log("⚡ lorebot is running — mention it in Slack to ask a question")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
