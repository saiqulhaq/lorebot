import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildAgentMarkdown, DEFAULT_BOT_CONFIG, validateBotConfig } from "../src/botconfig"
import { installAgent } from "../src/kb"
import {
  buildGraphifyPrompt,
  buildIndexMarkdown,
  type Graph,
  INDEX_MAX_ENTITIES,
  INDEX_RELATIVE_PATH,
  installGraphifyIndex,
  normalizeSourceFiles,
  parseGraph,
} from "../src/graphify"

const FIXTURE_DIR = path.join(import.meta.dir, "..", "fixtures", "graphify-out")

function fixtureGraph(): Graph {
  return parseGraph(JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "graph.json"), "utf8")))
}

/** A temp KB clone with the fixture graphify output copied in. */
function makeKbDir(): string {
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-graphify-"))
  fs.cpSync(FIXTURE_DIR, path.join(kbDir, "graphify-out"), { recursive: true })
  return kbDir
}

const enabled = { enabled: true, outputDir: "graphify-out" }

describe("parseGraph", () => {
  test("reads nodes, links, groups, and the build commit from the fixture", () => {
    const graph = fixtureGraph()
    expect(graph.nodes).toHaveLength(6)
    expect(graph.links).toHaveLength(4)
    expect(graph.groups).toHaveLength(1)
    expect(graph.builtAtCommit).toBe("0123abcd4567ef890123abcd4567ef890123abcd")
    expect(graph.nodes[0]).toEqual({
      id: "kb_deploy",
      label: "deploy.md",
      fileType: "document",
      sourceFile: "deploy.md",
    })
    expect(graph.links[1]).toEqual({ source: "kb_onboarding", target: "kb_deploy_ci_pipeline", relation: "references" })
  })

  test("skips malformed entries instead of failing", () => {
    const graph = parseGraph({
      nodes: [{ id: "ok", label: "OK" }, { id: 42 }, "junk", null],
      links: [{ source: "ok", target: "ok" }, { source: "ok" }, null],
      hyperedges: [{ label: "G", nodes: ["ok", 7] }, { nodes: [] }],
    })
    expect(graph.nodes).toHaveLength(1)
    expect(graph.links).toEqual([{ source: "ok", target: "ok", relation: "related_to" }])
    expect(graph.groups).toEqual([{ label: "G", nodes: ["ok"], sourceFile: "" }])
  })

  test("throws on a non-object root", () => {
    expect(() => parseGraph([])).toThrow("must be a JSON object")
    expect(() => parseGraph("nope")).toThrow("must be a JSON object")
  })
})

describe("buildIndexMarkdown", () => {
  const options = { outputDir: "graphify-out", manifestHash: "abc123" }

  test("lists connected entities with their relations and files", () => {
    const { markdown } = buildIndexMarkdown(fixtureGraph(), options)
    // Most-connected entity first, with both directions of its relations.
    expect(markdown).toContain("### CI Pipeline (concept) — `deploy.md`")
    expect(markdown).toContain("- references ← onboarding.md — `onboarding.md`")
    expect(markdown).toContain("- conceptually_related_to → Trunk-Based Development — `faq.md`")
    expect(markdown).toContain("built at commit `0123abcd`")
  })

  test("excludes section nodes that only have structural edges", () => {
    const { markdown, entityCount } = buildIndexMarkdown(fixtureGraph(), options)
    expect(markdown).not.toContain("### Rollback Procedure")
    expect(entityCount).toBe(5) // 6 nodes minus the contains-only section
  })

  test("renders topic groups from hyperedges", () => {
    const { markdown, groupCount } = buildIndexMarkdown(fixtureGraph(), options)
    expect(groupCount).toBe(1)
    expect(markdown).toContain("- **Deployment Flow**: CI Pipeline, Rollback Procedure, Trunk-Based Development — `deploy.md`")
  })

  test("embeds the manifest hash marker on the first line", () => {
    const { markdown } = buildIndexMarkdown(fixtureGraph(), options)
    expect(markdown.split("\n")[0]).toContain("manifest abc123")
  })

  test("caps entities at INDEX_MAX_ENTITIES and says so", () => {
    // A hub with more spokes than the cap; every node is connected.
    const total = INDEX_MAX_ENTITIES + 10
    const graph: Graph = { nodes: [], links: [], groups: [] }
    graph.nodes.push({ id: "hub", label: "Hub", fileType: "concept", sourceFile: "hub.md" })
    for (let i = 0; i < total; i++) {
      graph.nodes.push({ id: `n${i}`, label: `Node ${i}`, fileType: "concept", sourceFile: `n${i}.md` })
      graph.links.push({ source: "hub", target: `n${i}`, relation: "references" })
    }
    const { markdown, entityCount, entityTotal } = buildIndexMarkdown(graph, options)
    expect(entityCount).toBe(INDEX_MAX_ENTITIES)
    expect(entityTotal).toBe(total + 1)
    expect(markdown).toContain(`Top ${INDEX_MAX_ENTITIES} of ${total + 1} connected entities`)
    // The hub's relations are capped too, with an explicit pointer to the rest.
    expect(markdown).toContain("more (grep `hub` in `graphify-out/graph.json`)")
  })
})

describe("installGraphifyIndex", () => {
  test("writes the index into .opencode/ and reports it installed", () => {
    const kbDir = makeKbDir()
    expect(installGraphifyIndex(kbDir, enabled)).toBe(true)
    const index = fs.readFileSync(path.join(kbDir, INDEX_RELATIVE_PATH), "utf8")
    expect(index).toContain("# Knowledge graph index")
    expect(index).toContain("### CI Pipeline (concept)")
    fs.rmSync(kbDir, { recursive: true, force: true })
  })

  test("skips regeneration while the manifest is unchanged, regenerates when it changes", () => {
    const kbDir = makeKbDir()
    const indexPath = path.join(kbDir, INDEX_RELATIVE_PATH)
    installGraphifyIndex(kbDir, enabled)

    // Append a sentinel: a skipped run must leave the file untouched.
    fs.appendFileSync(indexPath, "SENTINEL")
    expect(installGraphifyIndex(kbDir, enabled)).toBe(true)
    expect(fs.readFileSync(indexPath, "utf8")).toContain("SENTINEL")

    // A manifest change (e.g. after a KB pull) triggers a rewrite.
    const manifestPath = path.join(kbDir, "graphify-out", "manifest.json")
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, "utf8").replace("8a1f2c9d", "deadbeef"))
    expect(installGraphifyIndex(kbDir, enabled)).toBe(true)
    expect(fs.readFileSync(indexPath, "utf8")).not.toContain("SENTINEL")
    fs.rmSync(kbDir, { recursive: true, force: true })
  })

  test("disabled config removes a previously generated index", () => {
    const kbDir = makeKbDir()
    installGraphifyIndex(kbDir, enabled)
    expect(installGraphifyIndex(kbDir, { ...enabled, enabled: false })).toBe(false)
    expect(fs.existsSync(path.join(kbDir, INDEX_RELATIVE_PATH))).toBe(false)
    fs.rmSync(kbDir, { recursive: true, force: true })
  })

  test("no graphify-out directory is a quiet no-op", () => {
    const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-nograph-"))
    expect(installGraphifyIndex(kbDir, enabled)).toBe(false)
    expect(fs.existsSync(path.join(kbDir, INDEX_RELATIVE_PATH))).toBe(false)
    fs.rmSync(kbDir, { recursive: true, force: true })
  })

  test("corrupt graph.json is reported, not thrown", () => {
    const kbDir = makeKbDir()
    fs.writeFileSync(path.join(kbDir, "graphify-out", "graph.json"), "{ not json")
    expect(installGraphifyIndex(kbDir, enabled)).toBe(false)
    fs.rmSync(kbDir, { recursive: true, force: true })
  })
})

describe("graphify config validation", () => {
  test("defaults: enabled with the standard output dir", () => {
    const { config, problems } = validateBotConfig({})
    expect(problems).toEqual([])
    expect(config.graphify).toEqual({ enabled: true, outputDir: "graphify-out" })
  })

  test("collects type problems while keeping defaults", () => {
    const { config, problems } = validateBotConfig({ graphify: { enabled: "yes", outputDir: 5 } })
    expect(problems).toContain("graphify.enabled must be true or false")
    expect(problems).toContain("graphify.outputDir must be a relative directory name inside the knowledge base")
    expect(config.graphify).toEqual(DEFAULT_BOT_CONFIG.graphify)
  })

  test("rejects output dirs that escape the KB clone", () => {
    for (const outputDir of ["../elsewhere", "/etc", ""]) {
      const { config, problems } = validateBotConfig({ graphify: { outputDir } })
      expect(problems).toContain("graphify.outputDir must be a relative directory name inside the knowledge base")
      expect(config.graphify.outputDir).toBe("graphify-out")
    }
  })
})

describe("agent prompt integration", () => {
  test("buildAgentMarkdown appends the graphify prompt when given", () => {
    const md = buildAgentMarkdown(DEFAULT_BOT_CONFIG, buildGraphifyPrompt("graphify-out"))
    expect(md).toContain("Knowledge graph:")
    expect(md).toContain(".opencode/graphify-index.md")
    expect(md).toContain("graphify-out/GRAPH_REPORT.md")
  })

  test("without a graph the agent definition is unchanged", () => {
    expect(buildAgentMarkdown(DEFAULT_BOT_CONFIG)).not.toContain("Knowledge graph:")
  })

  test("installAgent wires index and prompt together end to end", () => {
    const kbDir = makeKbDir()
    installAgent(kbDir, DEFAULT_BOT_CONFIG)
    expect(fs.existsSync(path.join(kbDir, INDEX_RELATIVE_PATH))).toBe(true)
    const agentMd = fs.readFileSync(path.join(kbDir, ".opencode", "agents", "kb.md"), "utf8")
    expect(agentMd).toContain(".opencode/graphify-index.md")

    // Disabling graphify drops both the index and the prompt section.
    const disabled = structuredClone(DEFAULT_BOT_CONFIG)
    disabled.graphify.enabled = false
    installAgent(kbDir, disabled)
    expect(fs.existsSync(path.join(kbDir, INDEX_RELATIVE_PATH))).toBe(false)
    expect(fs.readFileSync(path.join(kbDir, ".opencode", "agents", "kb.md"), "utf8")).not.toContain("graphify-index")
    fs.rmSync(kbDir, { recursive: true, force: true })
  })
})

describe("normalizeSourceFiles", () => {
  test("relativizes absolute paths that resolve inside the KB clone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorebot-normalize-"))
    fs.mkdirSync(path.join(dir, "src"), { recursive: true })
    fs.writeFileSync(path.join(dir, "src", "deploy.md"), "# deploy")

    const graph = {
      nodes: [
        { id: "a", label: "A", fileType: "document", sourceFile: "/Users/someone/projects/kb/src/deploy.md" },
        { id: "b", label: "B", fileType: "document", sourceFile: "src/deploy.md" },
        { id: "c", label: "C", fileType: "document", sourceFile: "/Users/someone/projects/kb/src/missing.md" },
      ],
      links: [],
      groups: [{ label: "G", nodes: ["a"], sourceFile: "/Users/someone/projects/kb/src/deploy.md" }],
    }
    const normalized = normalizeSourceFiles(graph, dir)
    expect(normalized.nodes[0]!.sourceFile).toBe("src/deploy.md")
    expect(normalized.nodes[1]!.sourceFile).toBe("src/deploy.md") // relative passes through
    expect(normalized.nodes[2]!.sourceFile).toBe("/Users/someone/projects/kb/src/missing.md") // unresolvable unchanged
    expect(normalized.groups[0]!.sourceFile).toBe("src/deploy.md")
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
