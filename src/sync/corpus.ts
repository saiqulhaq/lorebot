/**
 * Corpus assembly and graphify invocation for the sync subsystem.
 *
 * The corpus for each app mirrors the APP REPO's own layout — app files at
 * the corpus root, KB doc copies under kb-docs/ — so every source_file in
 * the resulting graph resolves inside the app repo once pushed. The corpus
 * directory persists between runs to keep graphify builds incremental.
 */

import fs from "node:fs"
import path from "node:path"
import type { Logger } from "../logger"
import { git, run } from "./git"

export type BuildInfo = {
  knowledge_base_sha: string
  app_sha: string
  built_by: "lorebot"
  lorebot_version: string
  built_at: string
}

const LAYOUT_MARKER = ".lorebot-sync.json"

/** Never copied into a corpus (and protected from rsync --delete). */
export const DEFAULT_EXCLUDES = [
  ".git/",
  ".opencode/",
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  "tmp/",
  "kb-docs/",
  "graphify-out/",
  LAYOUT_MARKER,
]
const OUTPUT_DIR = "graphify-out"

/**
 * Clone the app repo (first run) or hard-reset it to the remote head. The
 * token travels only in command arguments; the stored remote is tokenless.
 */
export async function ensureAppClone(options: {
  repoDir: string
  repo: string
  branch?: string
  remoteUrl: string
  log: Logger
}): Promise<{ sha: string; branch: string }> {
  const { repoDir, repo, remoteUrl, log } = options
  const redact = (text: string) => text.replaceAll(remoteUrl, "<remote>")

  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    fs.mkdirSync(path.dirname(repoDir), { recursive: true })
    log.info("cloning app repo", { repo })
    const branchArgs = options.branch ? ["--branch", options.branch] : []
    await git(["clone", "--depth", "1", ...branchArgs, remoteUrl, repoDir], { redact })
    await git(["-C", repoDir, "remote", "set-url", "origin", `https://github.com/${repo}.git`])
  }

  const branch =
    options.branch ?? (await git(["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"])) // clone's default branch

  await git(["-C", repoDir, "fetch", "--depth", "1", remoteUrl, branch], { redact })
  await git(["-C", repoDir, "reset", "--hard", "FETCH_HEAD"])
  await git(["-C", repoDir, "clean", "-fd"])
  const sha = await git(["-C", repoDir, "rev-parse", "HEAD"])
  return { sha, branch }
}

/**
 * Mirror app files (root) and KB docs (kb-docs/) into the persistent corpus.
 * A layout marker detects path-set changes, which invalidate the graphify
 * manifest and force a fresh extract.
 */
export async function assembleCorpus(options: {
  corpusDir: string
  appRepoDir: string
  kbDir: string
  kbPaths: string[]
  docsPaths?: string[]
  excludePaths?: string[]
  log: Logger
}): Promise<void> {
  const { corpusDir, appRepoDir, kbDir, kbPaths, docsPaths, excludePaths, log } = options
  fs.mkdirSync(corpusDir, { recursive: true })

  const layout = JSON.stringify({ kbPaths, docsPaths: docsPaths ?? null, excludePaths: excludePaths ?? null })
  const markerPath = path.join(corpusDir, LAYOUT_MARKER)
  const previousLayout = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8") : undefined
  if (previousLayout !== undefined && previousLayout !== layout) {
    log.warn("corpus layout changed; wiping corpus for a full re-extract", { corpus: corpusDir })
    fs.rmSync(corpusDir, { recursive: true, force: true })
    fs.mkdirSync(corpusDir, { recursive: true })
  }

  const excludes = [...DEFAULT_EXCLUDES, ...(excludePaths ?? [])].flatMap((entry) => ["--exclude", entry])

  if (docsPaths && docsPaths.length > 0) {
    // --relative with the /./ pivot keeps each docsPath's structure at the corpus root.
    const sources = docsPaths.map((p) => `${appRepoDir}/./${p}`)
    await rsync(["-a", "--delete", "--relative", ...excludes, ...sources, `${corpusDir}/`])
  } else {
    await rsync(["-a", "--delete", ...excludes, `${appRepoDir}/`, `${corpusDir}/`])
  }

  for (const kbPath of kbPaths) {
    const source = path.join(kbDir, kbPath)
    if (!fs.existsSync(source)) {
      log.warn("configured kbPath does not exist in the knowledge base", { kbPath })
      continue
    }
    const target = path.join(corpusDir, "kb-docs", kbPath)
    fs.mkdirSync(target, { recursive: true })
    await rsync([
      "-a",
      "--delete",
      "--exclude",
      ".git/",
      "--exclude",
      ".opencode/",
      "--exclude",
      "graphify-out/",
      `${source}/`,
      `${target}/`,
    ])
  }

  // Recorded only after a successful assembly so a failed run can't lock in
  // a layout it never actually produced.
  fs.writeFileSync(markerPath, layout)
}

async function rsync(args: string[]): Promise<void> {
  const result = await run(["rsync", ...args])
  if (result.exitCode !== 0) {
    throw new Error(`rsync failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
}

/** Incremental update only when graphify's own state files survive from a previous run. */
export function chooseMode(corpusDir: string, force: boolean): "extract" | "update" {
  const outputDir = path.join(corpusDir, OUTPUT_DIR)
  if (force) {
    for (const stale of ["manifest.json", ".graphify_labels.json", "cache"]) {
      fs.rmSync(path.join(outputDir, stale), { recursive: true, force: true })
    }
    return "extract"
  }
  const hasState =
    fs.existsSync(path.join(outputDir, "manifest.json")) && fs.existsSync(path.join(outputDir, ".graphify_labels.json"))
  return hasState ? "update" : "extract"
}

/**
 * First-run cost saver: seed graphify's incremental state from the app
 * repo's previously pushed graphify-out, so a fresh DATA_DIR doesn't trigger
 * a full LLM re-extract.
 */
export function seedManifestFromAppRepo(appRepoDir: string, corpusDir: string, log: Logger): boolean {
  const outputDir = path.join(corpusDir, OUTPUT_DIR)
  if (fs.existsSync(path.join(outputDir, "manifest.json"))) return false
  const committed = path.join(appRepoDir, OUTPUT_DIR)
  const manifest = path.join(committed, "manifest.json")
  const labels = path.join(committed, ".graphify_labels.json")
  if (!fs.existsSync(manifest) || !fs.existsSync(labels)) return false
  fs.mkdirSync(outputDir, { recursive: true })
  fs.copyFileSync(manifest, path.join(outputDir, "manifest.json"))
  fs.copyFileSync(labels, path.join(outputDir, ".graphify_labels.json"))
  log.info("seeded graphify manifest from the app repo's committed graph")
  return true
}

export async function runGraphify(options: {
  bin: string
  corpusDir: string
  mode: "extract" | "update"
  litellmKey: string
  litellmBaseUrl: string
  timeoutMs: number
  log: Logger
}): Promise<{ durationMs: number }> {
  const startedAt = Date.now()
  options.log.info("graphify build starting", { mode: options.mode })
  const result = await run([options.bin, options.mode, ".", "--output", `${OUTPUT_DIR}/`], {
    cwd: options.corpusDir,
    timeoutMs: options.timeoutMs,
    env: {
      LITELLM_SERVICE_ACCOUNT_KEY: options.litellmKey,
      LITELLM_BASE_URL: options.litellmBaseUrl,
      CI: "true",
    },
  })
  if (result.exitCode !== 0) {
    throw new Error(`graphify ${options.mode} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`)
  }
  const durationMs = Date.now() - startedAt
  options.log.info("graphify build finished", { mode: options.mode, durationMs })
  return { durationMs }
}

/** The report is a nice-to-have; failures are logged, never thrown. */
export async function runGraphifyReport(bin: string, corpusDir: string, log: Logger): Promise<void> {
  const result = await run(
    [bin, "report", `${OUTPUT_DIR}/graph.json`, "--output", `${OUTPUT_DIR}/GRAPH_REPORT.md`],
    { cwd: corpusDir },
  ).catch((error) => ({ exitCode: -1, stdout: "", stderr: String(error) }))
  if (result.exitCode !== 0) {
    log.warn("graphify report failed (non-fatal)", { stderr: result.stderr.trim().slice(0, 200) })
  }
}

export function writeBuildInfo(corpusDir: string, info: BuildInfo): void {
  fs.writeFileSync(path.join(corpusDir, OUTPUT_DIR, "BUILD_INFO.json"), `${JSON.stringify(info, null, 2)}\n`)
}

export function readBuildInfo(corpusDir: string): BuildInfo | undefined {
  const file = path.join(corpusDir, OUTPUT_DIR, "BUILD_INFO.json")
  if (!fs.existsSync(file)) return undefined
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as BuildInfo
  } catch {
    return undefined
  }
}

/**
 * Copy the sync products into the app clone: kb-docs/ and graphify-out/
 * (minus graphify's local-only cache and conversions). Nothing else in the
 * app clone is touched.
 */
export async function mirrorToAppRepo(options: { corpusDir: string; appRepoDir: string }): Promise<void> {
  const kbDocs = path.join(options.corpusDir, "kb-docs")
  if (fs.existsSync(kbDocs)) {
    await rsync(["-a", "--delete", `${kbDocs}/`, `${path.join(options.appRepoDir, "kb-docs")}/`])
  }
  await rsync([
    "-a",
    "--delete",
    "--exclude",
    "cache/",
    "--exclude",
    "converted/",
    `${path.join(options.corpusDir, OUTPUT_DIR)}/`,
    `${path.join(options.appRepoDir, OUTPUT_DIR)}/`,
  ])
}
