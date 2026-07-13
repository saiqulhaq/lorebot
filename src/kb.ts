import fs from "node:fs"
import path from "node:path"
import type { Config } from "./config"

const AGENT_SOURCE_DIR = path.join(import.meta.dir, "..", "agent")

/**
 * Ensure the knowledge-base clone exists and (optionally) install the bundled
 * read-only agent into it. Returns the absolute path sessions should use.
 */
export async function setupKb(config: Config): Promise<string> {
  const kbDir = config.kbDirOverride ?? path.join(config.dataDir, "kb")

  if (config.kbDirOverride) {
    if (!fs.existsSync(kbDir)) {
      throw new Error(`KB_DIR points to "${kbDir}" but it does not exist`)
    }
  } else if (!fs.existsSync(path.join(kbDir, ".git"))) {
    fs.mkdirSync(config.dataDir, { recursive: true })
    console.log(`Cloning knowledge base into ${kbDir} ...`)
    await git(["clone", config.kbRepoUrl!, kbDir])
  }

  if (config.manageAgent) installAgent(kbDir)
  return path.resolve(kbDir)
}

/** Start the interval `git pull` loop. Returns a stop function. */
export function startSyncLoop(kbDir: string, intervalMs: number): () => void {
  if (intervalMs <= 0) return () => {}
  let inFlight = false
  const timer = setInterval(async () => {
    if (inFlight) return
    inFlight = true
    try {
      await git(["-C", kbDir, "pull", "--ff-only"])
    } catch (error) {
      console.error(`KB sync failed: ${error instanceof Error ? error.message : error}`)
    } finally {
      inFlight = false
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Copy the bundled agent definition into the clone's .opencode/ so OpenCode
 * discovers it from the session directory, and keep the clone's git status
 * clean via .git/info/exclude.
 */
function installAgent(kbDir: string): void {
  const agentsDir = path.join(kbDir, ".opencode", "agents")
  fs.mkdirSync(agentsDir, { recursive: true })

  // The bot's copy is the source of truth; overwrite on every boot.
  fs.copyFileSync(path.join(AGENT_SOURCE_DIR, "kb.md"), path.join(agentsDir, "kb.md"))

  // Don't clobber a config the KB repo already ships.
  const configTarget = path.join(kbDir, ".opencode", "opencode.jsonc")
  if (!fs.existsSync(configTarget)) {
    fs.copyFileSync(path.join(AGENT_SOURCE_DIR, "opencode.jsonc"), configTarget)
  }

  excludeFromGit(kbDir, ".opencode/")
}

function excludeFromGit(repoDir: string, pattern: string): void {
  const excludePath = path.join(repoDir, ".git", "info", "exclude")
  if (!fs.existsSync(path.dirname(excludePath))) return // not a git repo; nothing to keep clean
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : ""
  if (current.split("\n").includes(pattern)) return
  fs.appendFileSync(excludePath, `${current.endsWith("\n") || current === "" ? "" : "\n"}${pattern}\n`)
}

async function git(args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`)
  }
}
