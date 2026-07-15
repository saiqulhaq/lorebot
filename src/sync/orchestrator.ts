/**
 * The sync pipeline: for each configured app repo, build a merged knowledge
 * graph (app docs + KB docs) and push it — with copies of the KB docs — into
 * the app repo, so developers' AI agents get full context locally.
 *
 * Failures are isolated per app; a sync run can never crash the Slack role.
 */

import fs from "node:fs"
import path from "node:path"
import type { SyncConfig } from "../botconfig"
import type { BotConfigRef } from "../slack"
import type { Config } from "../config"
import type { Logger } from "../logger"
import {
  assembleCorpus,
  ensureAppClone,
  mirrorToAppRepo,
  prepareForBuild,
  readBuildInfo,
  runGraphify,
  runGraphifyCluster,
  seedManifestFromAppRepo,
  writeBuildInfo,
} from "./corpus"
import type { SyncEnv } from "./env"
import { git, tryGit } from "./git"
import { makeTokenProvider, openOrUpdatePullRequest, redactSecrets, tokenRemote, type TokenProvider } from "./github-app"

export type AppRunStatus = "pushed" | "pr-updated" | "no-changes" | "up-to-date" | "dry-run" | "failed" | "skipped"

export type AppRunResult = {
  app: string
  status: AppRunStatus
  durationMs: number
  kbSha?: string
  appSha?: string
  prUrl?: string
  error?: string
}

export type SyncDeps = {
  config: Config
  syncEnv: SyncEnv
  kbDir: string
  log: Logger
  /** Injectable for tests. */
  tokens?: TokenProvider
  /** Injectable for tests (file:// bare repos). */
  remoteUrl?: (repo: string, token: string) => string
}

export const SYNC_BRANCH = "lorebot/graphify-sync"
const LOREBOT_VERSION = "0.5.1"

let inProcessRun = false

export async function runSyncOnce(
  deps: SyncDeps,
  sync: SyncConfig,
  options: { force?: boolean; only?: string[]; dryRun?: boolean } = {},
): Promise<AppRunResult[]> {
  const { log } = deps
  if (inProcessRun) {
    log.warn("sync already running in this process; skipping")
    return []
  }

  const syncDir = path.join(deps.config.dataDir, "sync")
  fs.mkdirSync(syncDir, { recursive: true })
  if (!acquireLock(syncDir, sync, log)) {
    return sync.apps.map((app) => ({ app: app.name, status: "skipped" as const, durationMs: 0 }))
  }

  inProcessRun = true
  try {
    const apps = options.only ? sync.apps.filter((app) => options.only!.includes(app.name)) : sync.apps
    if (apps.length === 0) {
      log.warn("no apps to sync", { only: options.only })
      return []
    }

    // Freshen the KB (non-fatal — the Slack role's sync loop may own pulls).
    await tryGit(["-C", deps.kbDir, "pull", "--ff-only"])
    const kbSha = (await tryGit(["-C", deps.kbDir, "rev-parse", "HEAD"])) ?? "unknown"

    const tokens = deps.tokens ?? makeTokenProvider(deps.syncEnv)
    const remoteUrl = deps.remoteUrl ?? tokenRemote
    const dryRun = options.dryRun || sync.dryRun

    const results: AppRunResult[] = []
    for (const app of apps) {
      const startedAt = Date.now()
      const appLog = log.child(app.name)
      try {
        const result = await syncApp({ deps, sync, app, kbSha, tokens, remoteUrl, dryRun, force: options.force, log: appLog })
        results.push({ ...result, durationMs: Date.now() - startedAt })
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error))
        appLog.error("sync failed", { error: message })
        results.push({ app: app.name, status: "failed", durationMs: Date.now() - startedAt, kbSha, error: message })
      }
    }

    for (const result of results) {
      log.info("sync result", { ...result })
    }
    return results
  } finally {
    inProcessRun = false
    releaseLock(syncDir)
  }
}

async function syncApp(context: {
  deps: SyncDeps
  sync: SyncConfig
  app: SyncConfig["apps"][number]
  kbSha: string
  tokens: TokenProvider
  remoteUrl: (repo: string, token: string) => string
  dryRun: boolean
  force?: boolean
  log: Logger
}): Promise<Omit<AppRunResult, "durationMs">> {
  const { deps, sync, app, kbSha, tokens, remoteUrl, dryRun, force, log } = context
  const appDir = path.join(deps.config.dataDir, "sync", "apps", app.name)
  const repoDir = path.join(appDir, "repo")
  const corpusDir = path.join(appDir, "corpus")

  const token = await tokens.getToken()
  const { sha: appSha, branch } = await ensureAppClone({
    repoDir,
    repo: app.repo,
    branch: app.branch,
    remoteUrl: remoteUrl(app.repo, token),
    log,
  })

  // Same inputs as the last SUCCESSFUL sync → nothing to do, no LLM spend.
  // The state file is written only on terminal success (never on failure or
  // dry runs), and our own sync commit moves the app HEAD, so the sha we
  // pushed last time counts as "unchanged" too.
  const state = readSyncState(corpusDir)
  if (!force && state && state.kbSha === kbSha && (state.appSha === appSha || state.pushedSha === appSha)) {
    return { app: app.name, status: "up-to-date", kbSha, appSha }
  }

  await assembleCorpus({
    corpusDir,
    appRepoDir: repoDir,
    kbDir: deps.kbDir,
    kbPaths: sync.kbPaths,
    docsPaths: app.docsPaths,
    excludePaths: app.excludePaths,
    excludePatterns: sync.excludePatterns,
    log,
  })
  seedManifestFromAppRepo(repoDir, corpusDir, log)

  prepareForBuild(corpusDir, force ?? false)
  await runGraphify({
    bin: deps.syncEnv.graphifyBin,
    corpusDir,
    backend: deps.syncEnv.graphifyBackend,
    model: deps.syncEnv.graphifyModel,
    apiKey: deps.syncEnv.litellmKey,
    baseUrl: deps.syncEnv.litellmBaseUrl,
    timeoutMs: sync.buildTimeoutMinutes * 60_000,
    log,
  })
  await runGraphifyCluster({
    bin: deps.syncEnv.graphifyBin,
    corpusDir,
    backend: deps.syncEnv.graphifyBackend,
    model: deps.syncEnv.graphifyModel,
    apiKey: deps.syncEnv.litellmKey,
    baseUrl: deps.syncEnv.litellmBaseUrl,
    timeoutMs: sync.buildTimeoutMinutes * 60_000,
    log,
  })
  writeBuildInfo(corpusDir, {
    knowledge_base_sha: kbSha,
    app_sha: appSha,
    built_by: "lorebot",
    lorebot_version: LOREBOT_VERSION,
    built_at: new Date().toISOString(),
  })

  await mirrorToAppRepo({ corpusDir, appRepoDir: repoDir })

  const inRepo = (args: string[], redact = false) =>
    git(["-C", repoDir, ...args], redact ? { redact: redactSecrets } : {})

  // -f: the synced trees are lorebot-managed regardless of what the app
  // repo's own .gitignore says about them (hh-server ignores graphify-out).
  await inRepo(["add", "-A", "-f", "kb-docs", "graphify-out"])
  const stagedFiles = (await inRepo(["diff", "--cached", "--name-only"])).split("\n").filter(Boolean)
  const onlyBuildInfo = stagedFiles.every((file) => file === "graphify-out/BUILD_INFO.json")
  if (stagedFiles.length === 0 || onlyBuildInfo) {
    // A BUILD_INFO-only diff means nothing about the graph changed — pushing
    // just the timestamp would loop the pipeline forever.
    if (stagedFiles.length > 0) await inRepo(["reset", "--hard", "HEAD"])
    writeSyncState(corpusDir, { kbSha, appSha })
    return { app: app.name, status: "no-changes", kbSha, appSha }
  }

  if (dryRun) {
    const stat = await inRepo(["diff", "--cached", "--stat"])
    log.info("dry run — would push", { branch, diffstat: `\n${stat}` })
    await inRepo(["reset", "--hard", "HEAD"])
    return { app: app.name, status: "dry-run", kbSha, appSha }
  }

  const message = `ci(graphify): rebuild graph from knowledge-base@${kbSha.slice(0, 7)}${force ? " (forced)" : ""}${sync.skipCi ? " [skip ci]" : ""}`
  await inRepo([
    "-c",
    "user.name=lorebot[bot]",
    "-c",
    "user.email=lorebot[bot]@users.noreply.github.com",
    "commit",
    "-m",
    message,
  ])

  if (sync.pushMode === "pr") {
    const pushToken = await tokens.getToken()
    await inRepo(["push", "--force", remoteUrl(app.repo, pushToken), `HEAD:refs/heads/${SYNC_BRANCH}`], true)
    const pr = await openOrUpdatePullRequest({
      repo: app.repo,
      head: SYNC_BRANCH,
      base: branch,
      title: "ci(graphify): sync knowledge graph",
      body: `Automated graphify sync from knowledge-base@${kbSha.slice(0, 7)} by lorebot.`,
      token: pushToken,
    })
    log.info(pr.created ? "pull request opened" : "pull request updated", { url: pr.url })
    writeSyncState(corpusDir, { kbSha, appSha })
    return { app: app.name, status: "pr-updated", kbSha, appSha, prUrl: pr.url }
  }

  try {
    await inRepo(["push", remoteUrl(app.repo, await tokens.getToken()), `HEAD:${branch}`], true)
  } catch (error) {
    // Token expired mid-run or the remote moved: refresh everything once.
    log.warn("push failed; refreshing token and remote state for one retry", {
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    })
    tokens.invalidate()
    const retryToken = await tokens.getToken()
    await ensureAppClone({ repoDir, repo: app.repo, branch: app.branch, remoteUrl: remoteUrl(app.repo, retryToken), log })
    await mirrorToAppRepo({ corpusDir, appRepoDir: repoDir })
    await inRepo(["add", "-A", "-f", "kb-docs", "graphify-out"])
    const retryStaged = await tryGit(["-C", repoDir, "diff", "--cached", "--quiet"])
    if (retryStaged !== undefined) {
      return { app: app.name, status: "no-changes", kbSha, appSha }
    }
    await inRepo([
      "-c",
      "user.name=lorebot[bot]",
      "-c",
      "user.email=lorebot[bot]@users.noreply.github.com",
      "commit",
      "-m",
      message,
    ])
    await inRepo(["push", remoteUrl(app.repo, retryToken), `HEAD:${branch}`], true)
  }
  writeSyncState(corpusDir, { kbSha, appSha, pushedSha: await inRepo(["rev-parse", "HEAD"]) })
  return { app: app.name, status: "pushed", kbSha, appSha }
}

/**
 * Terminal-success record for the up-to-date short-circuit. Kept out of the
 * repo (pushedSha is only knowable after committing, and the committed
 * BUILD_INFO must stay input-based). Never written on failure or dry runs —
 * a failed run must retry, and a dry run must not suppress a later real one.
 */
type SyncState = { kbSha: string; appSha: string; pushedSha?: string }

function syncStatePath(corpusDir: string): string {
  return path.join(corpusDir, ".last-sync.json")
}

function readSyncState(corpusDir: string): SyncState | undefined {
  try {
    return JSON.parse(fs.readFileSync(syncStatePath(corpusDir), "utf8")) as SyncState
  } catch {
    return undefined
  }
}

function writeSyncState(corpusDir: string, state: SyncState): void {
  fs.mkdirSync(corpusDir, { recursive: true })
  fs.writeFileSync(syncStatePath(corpusDir), JSON.stringify(state))
}

// --- cross-process lock ----------------------------------------------------

function acquireLock(syncDir: string, sync: SyncConfig, log: Logger): boolean {
  const lockPath = path.join(syncDir, ".lock")
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() })
  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" })
    return true
  } catch {
    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number; startedAt: number }
      const maxAgeMs = Math.max(1, sync.apps.length) * sync.buildTimeoutMinutes * 60_000
      const stale = Date.now() - existing.startedAt > maxAgeMs || !processAlive(existing.pid)
      if (!stale) {
        log.warn("another sync holds the lock; skipping", { holder: existing.pid })
        return false
      }
      log.warn("stealing stale sync lock", { holder: existing.pid })
      fs.writeFileSync(lockPath, payload)
      return true
    } catch {
      log.warn("unreadable sync lock; skipping")
      return false
    }
  }
}

function releaseLock(syncDir: string): void {
  fs.rmSync(path.join(syncDir, ".lock"), { force: true })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// --- scheduler ---------------------------------------------------------------

/**
 * In-process scheduler for the bot role. Reads the live config on every tick,
 * so hot-reloaded app lists and dryRun changes apply without restart.
 */
export function startSyncScheduler(deps: SyncDeps, botConfig: BotConfigRef): () => void {
  const { log } = deps
  let running = false

  const tick = async (reason: string) => {
    const sync = botConfig.current.sync
    if (!sync.enabled || sync.apps.length === 0 || running) return
    running = true
    try {
      log.info("scheduled sync starting", { reason, apps: sync.apps.length })
      await runSyncOnce(deps, sync)
    } catch (error) {
      log.error("scheduled sync crashed", { error })
    } finally {
      running = false
    }
  }

  // On boot, run once when any app has no build yet or its build is stale.
  const bootTimer = setTimeout(() => {
    const sync = botConfig.current.sync
    if (!sync.enabled) return
    const staleMs = sync.intervalHours * 3_600_000
    const anyStale = sync.apps.some((app) => {
      const info = readBuildInfo(path.join(deps.config.dataDir, "sync", "apps", app.name, "corpus"))
      return !info || Date.now() - Date.parse(info.built_at) > staleMs
    })
    if (anyStale) void tick("boot staleness check")
  }, 15_000)
  bootTimer.unref?.()

  const interval = setInterval(() => void tick("interval"), botConfig.current.sync.intervalHours * 3_600_000)
  interval.unref?.()

  return () => {
    clearTimeout(bootTimer)
    clearInterval(interval)
  }
}
