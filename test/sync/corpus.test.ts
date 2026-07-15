import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { makeLogger } from "../../src/logger"
import {
  assembleCorpus,
  chooseMode,
  mirrorToAppRepo,
  readBuildInfo,
  runGraphify,
  runGraphifyReport,
  seedManifestFromAppRepo,
  writeBuildInfo,
} from "../../src/sync/corpus"

const FAKE_GRAPHIFY = path.join(import.meta.dir, "..", "..", "fixtures", "bin", "graphify")
const log = makeLogger({ level: "error", format: "pretty" }, () => {})

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-corpus-"))
  dirs.push(dir)
  return dir
}

function write(base: string, file: string, content = "x") {
  const target = path.join(base, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function setupTrees() {
  const appRepo = tempDir()
  const kb = tempDir()
  const corpus = path.join(tempDir(), "corpus")
  write(appRepo, "README.md", "app readme")
  write(appRepo, "docs/api.md")
  write(appRepo, "node_modules/pkg/index.js")
  write(appRepo, ".git/HEAD")
  write(appRepo, "kb-docs/stale.md") // previously pushed copies must not round-trip
  write(appRepo, "graphify-out/graph.json")
  write(kb, "src/prd.md", "the prd")
  write(kb, "src/.opencode/agents/kb.md")
  write(kb, "other/ignored.md")
  return { appRepo, kb, corpus }
}

describe("assembleCorpus", () => {
  test("mirrors app at root and KB under kb-docs/, honoring excludes", async () => {
    const { appRepo, kb, corpus } = setupTrees()
    await assembleCorpus({ corpusDir: corpus, appRepoDir: appRepo, kbDir: kb, kbPaths: ["src/"], log })

    expect(fs.existsSync(path.join(corpus, "README.md"))).toBe(true)
    expect(fs.existsSync(path.join(corpus, "docs/api.md"))).toBe(true)
    expect(fs.existsSync(path.join(corpus, "kb-docs/src/prd.md"))).toBe(true)
    // excluded both directions
    expect(fs.existsSync(path.join(corpus, "node_modules"))).toBe(false)
    expect(fs.existsSync(path.join(corpus, ".git"))).toBe(false)
    expect(fs.existsSync(path.join(corpus, "kb-docs/stale.md"))).toBe(false)
    expect(fs.existsSync(path.join(corpus, "graphify-out/graph.json"))).toBe(false)
    expect(fs.existsSync(path.join(corpus, "kb-docs/src/.opencode"))).toBe(false)
    // KB paths outside kbPaths stay out
    expect(fs.existsSync(path.join(corpus, "kb-docs/other"))).toBe(false)
  })

  test("propagates deletions but preserves graphify-out", async () => {
    const { appRepo, kb, corpus } = setupTrees()
    await assembleCorpus({ corpusDir: corpus, appRepoDir: appRepo, kbDir: kb, kbPaths: ["src/"], log })
    write(corpus, "graphify-out/manifest.json", "{}")

    fs.rmSync(path.join(appRepo, "docs/api.md"))
    await assembleCorpus({ corpusDir: corpus, appRepoDir: appRepo, kbDir: kb, kbPaths: ["src/"], log })

    expect(fs.existsSync(path.join(corpus, "docs/api.md"))).toBe(false)
    expect(fs.existsSync(path.join(corpus, "graphify-out/manifest.json"))).toBe(true)
  })

  test("docsPaths narrows the app mirror", async () => {
    const { appRepo, kb, corpus } = setupTrees()
    await assembleCorpus({
      corpusDir: corpus,
      appRepoDir: appRepo,
      kbDir: kb,
      kbPaths: ["src/"],
      docsPaths: ["docs/"],
      log,
    })
    expect(fs.existsSync(path.join(corpus, "docs/api.md"))).toBe(true)
    expect(fs.existsSync(path.join(corpus, "README.md"))).toBe(false)
  })

  test("layout change wipes the corpus (manifest invalidated)", async () => {
    const { appRepo, kb, corpus } = setupTrees()
    await assembleCorpus({ corpusDir: corpus, appRepoDir: appRepo, kbDir: kb, kbPaths: ["src/"], log })
    write(corpus, "graphify-out/manifest.json", "{}")

    await assembleCorpus({
      corpusDir: corpus,
      appRepoDir: appRepo,
      kbDir: kb,
      kbPaths: ["src/"],
      docsPaths: ["docs/"],
      log,
    })
    expect(fs.existsSync(path.join(corpus, "graphify-out/manifest.json"))).toBe(false)
  })

  test("warns and skips missing kbPaths", async () => {
    const { appRepo, kb, corpus } = setupTrees()
    const warnings: string[] = []
    const warnLog = makeLogger({ level: "warn", format: "pretty" }, (line) => warnings.push(line))
    await assembleCorpus({
      corpusDir: corpus,
      appRepoDir: appRepo,
      kbDir: kb,
      kbPaths: ["nonexistent/"],
      log: warnLog,
    })
    expect(warnings.some((w) => w.includes("kbPath does not exist"))).toBe(true)
    expect(fs.existsSync(path.join(corpus, "kb-docs/nonexistent"))).toBe(false)
  })
})

describe("chooseMode / seedManifestFromAppRepo", () => {
  test("update only when both state files exist; force wipes state", () => {
    const corpus = tempDir()
    expect(chooseMode(corpus, false)).toBe("extract")
    write(corpus, "graphify-out/manifest.json", "{}")
    expect(chooseMode(corpus, false)).toBe("extract") // labels missing
    write(corpus, "graphify-out/.graphify_labels.json", "{}")
    expect(chooseMode(corpus, false)).toBe("update")
    expect(chooseMode(corpus, true)).toBe("extract")
    expect(fs.existsSync(path.join(corpus, "graphify-out/manifest.json"))).toBe(false)
  })

  test("seeds incremental state from the app repo's committed graph", () => {
    const appRepo = tempDir()
    const corpus = tempDir()
    expect(seedManifestFromAppRepo(appRepo, corpus, log)).toBe(false) // nothing committed
    write(appRepo, "graphify-out/manifest.json", "{}")
    write(appRepo, "graphify-out/.graphify_labels.json", "{}")
    expect(seedManifestFromAppRepo(appRepo, corpus, log)).toBe(true)
    expect(chooseMode(corpus, false)).toBe("update")
    expect(seedManifestFromAppRepo(appRepo, corpus, log)).toBe(false) // already seeded
  })
})

describe("runGraphify", () => {
  test("passes CI + LiteLLM env and produces output", async () => {
    const corpus = tempDir()
    const envDump = path.join(tempDir(), "env.txt")
    process.env.GRAPHIFY_FAKE_DUMP_ENV = envDump
    try {
      await runGraphify({
        bin: FAKE_GRAPHIFY,
        corpusDir: corpus,
        mode: "extract",
        litellmKey: "sk-test",
        litellmBaseUrl: "https://llm.example/v1",
        timeoutMs: 10_000,
        log,
      })
    } finally {
      delete process.env.GRAPHIFY_FAKE_DUMP_ENV
    }
    expect(fs.existsSync(path.join(corpus, "graphify-out/graph.json"))).toBe(true)
    const env = fs.readFileSync(envDump, "utf8")
    expect(env).toContain("CI=true")
    expect(env).toContain("LITELLM_SERVICE_ACCOUNT_KEY=sk-test")
    expect(env).toContain("LITELLM_BASE_URL=https://llm.example/v1")
  })

  test("kills the build on timeout", async () => {
    const corpus = tempDir()
    process.env.GRAPHIFY_FAKE_SLEEP = "5"
    try {
      await expect(
        runGraphify({
          bin: FAKE_GRAPHIFY,
          corpusDir: corpus,
          mode: "extract",
          litellmKey: "k",
          litellmBaseUrl: "u",
          timeoutMs: 300,
          log,
        }),
      ).rejects.toThrow("timed out")
    } finally {
      delete process.env.GRAPHIFY_FAKE_SLEEP
    }
  })

  test("surfaces build failure", async () => {
    const corpus = tempDir()
    process.env.GRAPHIFY_FAKE_FAIL = "1"
    try {
      await expect(
        runGraphify({
          bin: FAKE_GRAPHIFY,
          corpusDir: corpus,
          mode: "update",
          litellmKey: "k",
          litellmBaseUrl: "u",
          timeoutMs: 10_000,
          log,
        }),
      ).rejects.toThrow("graphify update failed")
    } finally {
      delete process.env.GRAPHIFY_FAKE_FAIL
    }
  })

  test("report failures are non-fatal", async () => {
    const corpus = tempDir()
    process.env.GRAPHIFY_FAKE_FAIL = "1"
    try {
      await runGraphifyReport(FAKE_GRAPHIFY, corpus, log) // must not throw
    } finally {
      delete process.env.GRAPHIFY_FAKE_FAIL
    }
  })
})

describe("BUILD_INFO + mirrorToAppRepo", () => {
  test("round-trips build info and mirrors without cache/converted", async () => {
    const corpus = tempDir()
    const appRepo = tempDir()
    write(corpus, "graphify-out/graph.json", "{}")
    write(corpus, "graphify-out/cache/junk")
    write(corpus, "graphify-out/converted/junk")
    write(corpus, "kb-docs/src/prd.md", "prd")
    write(appRepo, "graphify-out/old-file.json") // must be deleted by --delete
    write(appRepo, "src/app.ts", "code")

    const info = {
      knowledge_base_sha: "kb123",
      app_sha: "app456",
      built_by: "lorebot" as const,
      lorebot_version: "0.5.0",
      built_at: "2026-07-15T00:00:00Z",
    }
    writeBuildInfo(corpus, info)
    expect(readBuildInfo(corpus)).toEqual(info)

    await mirrorToAppRepo({ corpusDir: corpus, appRepoDir: appRepo })
    expect(fs.existsSync(path.join(appRepo, "graphify-out/graph.json"))).toBe(true)
    expect(fs.existsSync(path.join(appRepo, "graphify-out/BUILD_INFO.json"))).toBe(true)
    expect(fs.existsSync(path.join(appRepo, "kb-docs/src/prd.md"))).toBe(true)
    expect(fs.existsSync(path.join(appRepo, "graphify-out/cache"))).toBe(false)
    expect(fs.existsSync(path.join(appRepo, "graphify-out/converted"))).toBe(false)
    expect(fs.existsSync(path.join(appRepo, "graphify-out/old-file.json"))).toBe(false)
    expect(fs.readFileSync(path.join(appRepo, "src/app.ts"), "utf8")).toBe("code") // untouched
  })
})
