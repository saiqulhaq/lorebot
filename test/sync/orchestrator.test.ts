import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { SyncConfig } from "../../src/botconfig"
import type { Config } from "../../src/config"
import { makeLogger } from "../../src/logger"
import { run } from "../../src/sync/git"
import { runSyncOnce, SYNC_BRANCH, type SyncDeps } from "../../src/sync/orchestrator"

const FAKE_GRAPHIFY = path.join(import.meta.dir, "..", "..", "fixtures", "bin", "graphify")
const log = makeLogger({ level: "error", format: "pretty" }, () => {})

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-orch-"))
  dirs.push(dir)
  return dir
}

async function sh(cmd: string[], cwd?: string) {
  const result = await run(cmd, { cwd })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@test"]

/** A local bare repo seeded with an initial commit, standing in for GitHub. */
async function makeBareRepo(files: Record<string, string>): Promise<{ bare: string; headSha: string }> {
  const bare = path.join(tempDir(), "remote.git")
  await sh(["git", "init", "--bare", "--initial-branch=main", bare])
  const work = path.join(tempDir(), "work")
  await sh(["git", "clone", bare, work])
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true })
    fs.writeFileSync(path.join(work, file), content)
  }
  await sh(["git", ...GIT_ID, "-C", work, "add", "-A"])
  await sh(["git", ...GIT_ID, "-C", work, "commit", "-m", "init"])
  await sh(["git", "-C", work, "push", "origin", "HEAD:main"])
  const headSha = await sh(["git", "-C", bare, "rev-parse", "HEAD"])
  return { bare, headSha }
}

async function makeKbRepo(): Promise<string> {
  const kb = path.join(tempDir(), "kb")
  fs.mkdirSync(path.join(kb, "src"), { recursive: true })
  fs.writeFileSync(path.join(kb, "src", "prd.md"), "the prd")
  await sh(["git", "init", "--initial-branch=main", kb])
  await sh(["git", ...GIT_ID, "-C", kb, "add", "-A"])
  await sh(["git", ...GIT_ID, "-C", kb, "commit", "-m", "kb"])
  return kb
}

function makeDeps(kbDir: string, bareByRepo: Record<string, string>): SyncDeps {
  const dataDir = tempDir()
  return {
    config: { dataDir, graphifyBin: FAKE_GRAPHIFY } as unknown as Config,
    syncEnv: {
      appId: "1",
      installationId: "2",
      privateKeyPem: "unused",
      litellmKey: "sk-test",
      litellmBaseUrl: "https://llm.example/v1",
      graphifyBin: FAKE_GRAPHIFY,
      graphifyBackend: "openai",
    },
    kbDir,
    log,
    tokens: { getToken: async () => "fake-token", invalidate() {} },
    remoteUrl: (repo) => bareByRepo[repo]!,
  }
}

function syncConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    enabled: true,
    apps: [{ name: "app1", repo: "org/app1" }],
    intervalHours: 24,
    pushMode: "direct",
    kbPaths: ["src/"],
    excludePatterns: [],
    skipCi: false,
    dryRun: false,
    buildTimeoutMinutes: 1,
    ...overrides,
  }
}

describe("runSyncOnce", () => {
  test("happy path: pushes kb-docs + graphify-out, app files untouched", async () => {
    const kb = await makeKbRepo()
    const { bare } = await makeBareRepo({ "README.md": "app readme", "src/app.ts": "code" })
    const deps = makeDeps(kb, { "org/app1": bare })

    const results = await runSyncOnce(deps, syncConfig())
    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe("pushed")

    const check = path.join(tempDir(), "check")
    await sh(["git", "clone", bare, check])
    expect(fs.readFileSync(path.join(check, "README.md"), "utf8")).toBe("app readme")
    expect(fs.existsSync(path.join(check, "kb-docs/src/prd.md"))).toBe(true)
    expect(fs.existsSync(path.join(check, "graphify-out/graph.json"))).toBe(true)
    expect(fs.existsSync(path.join(check, "graphify-out/BUILD_INFO.json"))).toBe(true)
    expect(fs.existsSync(path.join(check, "graphify-out/cache"))).toBe(false)

    const message = await sh(["git", "-C", check, "log", "-1", "--format=%s"])
    expect(message).toMatch(/^ci\(graphify\): rebuild graph from knowledge-base@[0-9a-f]{7}$/)
    const author = await sh(["git", "-C", check, "log", "-1", "--format=%an"])
    expect(author).toBe("lorebot[bot]")
  })

  test("second run is up-to-date; new KB commit triggers a push", async () => {
    const kb = await makeKbRepo()
    const { bare } = await makeBareRepo({ "README.md": "x" })
    const deps = makeDeps(kb, { "org/app1": bare })

    expect((await runSyncOnce(deps, syncConfig()))[0]!.status).toBe("pushed")
    expect((await runSyncOnce(deps, syncConfig()))[0]!.status).toBe("up-to-date")

    fs.writeFileSync(path.join(kb, "src", "new.md"), "new doc")
    await sh(["git", ...GIT_ID, "-C", kb, "add", "-A"])
    await sh(["git", ...GIT_ID, "-C", kb, "commit", "-m", "more"])
    expect((await runSyncOnce(deps, syncConfig()))[0]!.status).toBe("pushed")
  })

  test("pushes even when the app repo's own .gitignore ignores graphify-out", async () => {
    const kb = await makeKbRepo()
    const { bare } = await makeBareRepo({ "README.md": "x", ".gitignore": "graphify-out\nkb-docs\n" })
    const deps = makeDeps(kb, { "org/app1": bare })

    const results = await runSyncOnce(deps, syncConfig())
    expect(results[0]!.status).toBe("pushed")

    const check = path.join(tempDir(), "check-ignored")
    await sh(["git", "clone", bare, check])
    expect(fs.existsSync(path.join(check, "graphify-out/graph.json"))).toBe(true)
    expect(fs.existsSync(path.join(check, "kb-docs/src/prd.md"))).toBe(true)
  })

  test("a failed run does not suppress the retry (no premature up-to-date)", async () => {
    const kb = await makeKbRepo()
    const { bare } = await makeBareRepo({ "README.md": "x" })
    const deps = makeDeps(kb, { "org/app1": bare })

    process.env.GRAPHIFY_FAKE_FAIL = "1"
    try {
      const failed = await runSyncOnce(deps, syncConfig())
      expect(failed[0]!.status).toBe("failed")
    } finally {
      delete process.env.GRAPHIFY_FAKE_FAIL
    }

    // The retry must actually run (not short-circuit as up-to-date) and push.
    const retry = await runSyncOnce(deps, syncConfig())
    expect(retry[0]!.status).toBe("pushed")
  })

  test("dry run leaves the remote untouched", async () => {
    const kb = await makeKbRepo()
    const { bare, headSha } = await makeBareRepo({ "README.md": "x" })
    const deps = makeDeps(kb, { "org/app1": bare })

    const results = await runSyncOnce(deps, syncConfig({ dryRun: true }))
    expect(results[0]!.status).toBe("dry-run")
    expect(await sh(["git", "-C", bare, "rev-parse", "HEAD"])).toBe(headSha)
  })

  test("skipCi appends the marker to the commit message", async () => {
    const kb = await makeKbRepo()
    const { bare } = await makeBareRepo({ "README.md": "x" })
    const deps = makeDeps(kb, { "org/app1": bare })

    await runSyncOnce(deps, syncConfig({ skipCi: true }))
    const message = await sh(["git", "-C", bare, "log", "-1", "--format=%s"])
    expect(message).toEndWith("[skip ci]")
  })

  test("one failing app does not block the next", async () => {
    const kb = await makeKbRepo()
    const good = await makeBareRepo({ "README.md": "x" })
    const deps = makeDeps(kb, { "org/bad": "/nonexistent/bare.git", "org/good": good.bare })

    const results = await runSyncOnce(
      deps,
      syncConfig({
        apps: [
          { name: "bad", repo: "org/bad" },
          { name: "good", repo: "org/good" },
        ],
      }),
    )
    expect(results.map((r) => [r.app, r.status])).toEqual([
      ["bad", "failed"],
      ["good", "pushed"],
    ])
  })

  test("recovers when the remote diverges between runs", async () => {
    const kb = await makeKbRepo()
    const { bare } = await makeBareRepo({ "README.md": "v1" })
    const deps = makeDeps(kb, { "org/app1": bare })
    await runSyncOnce(deps, syncConfig())

    // Someone else pushes to the app repo, and the KB changes too.
    const work = path.join(tempDir(), "foreign")
    await sh(["git", "clone", bare, work])
    fs.writeFileSync(path.join(work, "README.md"), "v2")
    await sh(["git", ...GIT_ID, "-C", work, "add", "-A"])
    await sh(["git", ...GIT_ID, "-C", work, "commit", "-m", "foreign change"])
    await sh(["git", "-C", work, "push"])
    fs.writeFileSync(path.join(kb, "src", "extra.md"), "extra doc")
    await sh(["git", ...GIT_ID, "-C", kb, "add", "-A"])
    await sh(["git", ...GIT_ID, "-C", kb, "commit", "-m", "kb change"])

    const results = await runSyncOnce(deps, syncConfig())
    expect(results[0]!.status).toBe("pushed")
    const check = path.join(tempDir(), "check2")
    await sh(["git", "clone", bare, check])
    expect(fs.readFileSync(path.join(check, "README.md"), "utf8")).toBe("v2") // foreign change preserved
  })

  test("pr mode force-pushes the sync branch and opens a PR", async () => {
    const kb = await makeKbRepo()
    const { bare, headSha } = await makeBareRepo({ "README.md": "x" })
    const deps = makeDeps(kb, { "org/app1": bare })

    const originalFetch = globalThis.fetch
    let prCreated = false
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url).includes("/pulls") && init?.method === "POST") {
        prCreated = true
        return new Response(JSON.stringify({ html_url: "https://pr/1" }), { status: 201 })
      }
      return new Response("{}", { status: 200 })
    }) as typeof fetch
    try {
      const results = await runSyncOnce(deps, syncConfig({ pushMode: "pr" }))
      expect(results[0]!.status).toBe("pr-updated")
      expect(results[0]!.prUrl).toBe("https://pr/1")
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(prCreated).toBe(true)
    expect(await sh(["git", "-C", bare, "rev-parse", "HEAD"])).toBe(headSha) // main untouched
    const branchSha = await sh(["git", "-C", bare, "rev-parse", `refs/heads/${SYNC_BRANCH}`])
    expect(branchSha).not.toBe(headSha)
  })

  test("a live lock file skips the run; a stale one is stolen", async () => {
    const kb = await makeKbRepo()
    const { bare } = await makeBareRepo({ "README.md": "x" })
    const deps = makeDeps(kb, { "org/app1": bare })
    const lockPath = path.join(deps.config.dataDir, "sync", ".lock")
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })

    // Live holder (this test process).
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
    const skipped = await runSyncOnce(deps, syncConfig())
    expect(skipped[0]!.status).toBe("skipped")

    // Stale holder (dead pid).
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() - 10 * 60_000 }))
    const stolen = await runSyncOnce(deps, syncConfig())
    expect(stolen[0]!.status).toBe("pushed")
  })
})
