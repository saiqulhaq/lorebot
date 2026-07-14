import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Logger } from "./logger"

/**
 * Graphify (https://graphify.net) integration. When the knowledge base ships
 * a graphify output directory (graph.json + manifest.json), lorebot distills
 * the graph into a compact markdown index the read-only agent can read and
 * grep, so relationship questions ("what connects X to Y?") don't depend on
 * keyword luck. Everything here is a graceful no-op when the directory is
 * absent or the feature is disabled.
 */

/** The `graphify` section of lorebot.config.json. */
export type GraphifyConfig = {
  enabled: boolean
  /** Directory inside the KB clone holding graphify output. */
  outputDir: string
}

/** graph.json is a NetworkX node-link export; these are the fields we use. */
export type GraphNode = {
  id: string
  label: string
  /** One of: code, document, paper, image, rationale, concept. */
  fileType: string
  /** KB-relative path of the file the entity was extracted from. */
  sourceFile: string
}

export type GraphLink = {
  source: string
  target: string
  relation: string
}

/** A graphify hyperedge: 3+ nodes participating in one flow or pattern. */
export type GraphGroup = {
  label: string
  nodes: string[]
  sourceFile: string
}

export type Graph = {
  nodes: GraphNode[]
  links: GraphLink[]
  groups: GraphGroup[]
  builtAtCommit?: string
}

/** Where the generated index lives, relative to the KB clone. */
export const INDEX_RELATIVE_PATH = path.join(".opencode", "graphify-index.md")

// Real graphs reach tens of thousands of nodes; the index must stay small
// enough for the agent to read in one step. Truncation is never silent — the
// caps are logged and noted in the index itself.
export const INDEX_MAX_ENTITIES = 150
export const INDEX_MAX_RELATED = 6
export const INDEX_MAX_GROUPS = 40
const INDEX_MAX_GROUP_MEMBERS = 12

// "contains" edges only describe the heading structure inside one document
// (the bulk of the graph). The cross-document web is what grep can't see, so
// only non-structural relations count toward the index.
const STRUCTURAL_RELATIONS = new Set(["contains"])

/** Parse a decoded graph.json into the subset lorebot uses. Malformed entries are skipped. */
export function parseGraph(raw: unknown): Graph {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("graph.json root must be a JSON object")
  }
  const root = raw as Record<string, any>

  const nodes: GraphNode[] = []
  for (const node of Array.isArray(root.nodes) ? root.nodes : []) {
    if (typeof node?.id !== "string" || typeof node?.label !== "string") continue
    nodes.push({
      id: node.id,
      label: node.label,
      fileType: typeof node.file_type === "string" ? node.file_type : "document",
      sourceFile: typeof node.source_file === "string" ? node.source_file : "",
    })
  }

  const links: GraphLink[] = []
  for (const link of Array.isArray(root.links) ? root.links : []) {
    if (typeof link?.source !== "string" || typeof link?.target !== "string") continue
    links.push({
      source: link.source,
      target: link.target,
      relation: typeof link.relation === "string" ? link.relation : "related_to",
    })
  }

  const groups: GraphGroup[] = []
  for (const edge of Array.isArray(root.hyperedges) ? root.hyperedges : []) {
    if (typeof edge?.label !== "string" || !Array.isArray(edge?.nodes)) continue
    groups.push({
      label: edge.label,
      nodes: edge.nodes.filter((id: unknown): id is string => typeof id === "string"),
      sourceFile: typeof edge.source_file === "string" ? edge.source_file : "",
    })
  }

  return {
    nodes,
    links,
    groups,
    builtAtCommit: typeof root.built_at_commit === "string" ? root.built_at_commit : undefined,
  }
}

/**
 * Render the agent-facing index: topic groups plus the most-connected
 * entities, each with its source document and related entities/files.
 */
export function buildIndexMarkdown(
  graph: Graph,
  options: { outputDir: string; manifestHash: string },
): { markdown: string; entityCount: number; entityTotal: number; groupCount: number } {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))

  type Neighbor = { relation: string; outgoing: boolean; node: GraphNode }
  const neighbors = new Map<string, Neighbor[]>()
  const addNeighbor = (id: string, neighbor: Neighbor) => {
    const list = neighbors.get(id)
    if (list) list.push(neighbor)
    else neighbors.set(id, [neighbor])
  }
  for (const link of graph.links) {
    if (STRUCTURAL_RELATIONS.has(link.relation)) continue
    const source = nodeById.get(link.source)
    const target = nodeById.get(link.target)
    if (!source || !target) continue
    addNeighbor(source.id, { relation: link.relation, outgoing: true, node: target })
    addNeighbor(target.id, { relation: link.relation, outgoing: false, node: source })
  }

  // Most-connected entities first; section-only nodes (structural edges only)
  // never make the list.
  const entities = graph.nodes.filter((node) => neighbors.has(node.id))
  entities.sort(
    (a, b) => neighbors.get(b.id)!.length - neighbors.get(a.id)!.length || a.label.localeCompare(b.label),
  )
  const shown = entities.slice(0, INDEX_MAX_ENTITIES)
  const shownGroups = graph.groups.slice(0, INDEX_MAX_GROUPS)

  const fileRef = (sourceFile: string): string => (sourceFile ? ` — \`${sourceFile}\`` : "")
  const lines: string[] = [
    indexMarker(options.manifestHash),
    "# Knowledge graph index",
    "",
    `Distilled from \`${options.outputDir}/graph.json\` (${graph.nodes.length} nodes, ${graph.links.length} relations${graph.builtAtCommit ? `, built at commit \`${graph.builtAtCommit.slice(0, 8)}\`` : ""}).`,
    shown.length < entities.length
      ? `Top ${shown.length} of ${entities.length} connected entities shown (ranked by relation count).`
      : `${entities.length} connected entities.`,
    "Find an entity, read its files, cite the files — never this index. For",
    `entities not listed here, grep \`${options.outputDir}/GRAPH_REPORT.md\`.`,
  ]

  if (shownGroups.length > 0) {
    lines.push("", "## Topic groups", "")
    if (shownGroups.length < graph.groups.length) {
      lines.push(`_First ${shownGroups.length} of ${graph.groups.length} groups._`, "")
    }
    for (const group of shownGroups) {
      const members = group.nodes.map((id) => nodeById.get(id)?.label ?? id)
      const extra = members.length > INDEX_MAX_GROUP_MEMBERS ? ` (+${members.length - INDEX_MAX_GROUP_MEMBERS} more)` : ""
      lines.push(`- **${group.label}**: ${members.slice(0, INDEX_MAX_GROUP_MEMBERS).join(", ")}${extra}${fileRef(group.sourceFile)}`)
    }
  }

  lines.push("", "## Entities")
  for (const entity of shown) {
    lines.push("", `### ${entity.label} (${entity.fileType})${fileRef(entity.sourceFile)}`)
    const seen = new Set<string>()
    let printed = 0
    let omitted = 0
    for (const { relation, outgoing, node } of neighbors.get(entity.id)!) {
      const key = `${relation}|${outgoing}|${node.id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (printed >= INDEX_MAX_RELATED) {
        omitted++
        continue
      }
      lines.push(`- ${relation} ${outgoing ? "→" : "←"} ${node.label}${fileRef(node.sourceFile)}`)
      printed++
    }
    if (omitted > 0) {
      lines.push(`- …and ${omitted} more (grep \`${entity.id}\` in \`${options.outputDir}/graph.json\`)`)
    }
  }

  return {
    markdown: `${lines.join("\n")}\n`,
    entityCount: shown.length,
    entityTotal: entities.length,
    groupCount: shownGroups.length,
  }
}

/**
 * The prompt section buildAgentMarkdown appends when a graph index exists,
 * teaching the read-only agent how to navigate relationships.
 */
export function buildGraphifyPrompt(outputDir: string): string {
  return `Knowledge graph:

This repository ships a knowledge graph (generated by graphify) linking
entities across documents. Use it for relationship questions — "what connects
X to Y", "what depends on X", "which docs cover Y":

- \`.opencode/graphify-index.md\` — start here: topic groups plus the
  most-connected entities, each with its related entities and source files.
- \`${outputDir}/GRAPH_REPORT.md\` — full report: communities of related
  documents, most-connected entities, group relationships. Grep it by entity
  name for anything the index omits.
- \`${outputDir}/graph.json\` — the raw graph; grep a node id to see every
  relation it participates in.

The graph only tells you WHERE to look. Always read the underlying documents
before answering, and cite those files — never the index, report, or
graph.json.`
}

/**
 * Graphs are sometimes generated on another machine, leaving absolute
 * source_file paths (e.g. /Users/x/projects/kb/src/a.md) that the agent can't
 * open and the citation linkifier can't resolve. Rewrite each absolute path to
 * the longest suffix that actually exists in the KB clone; unresolvable paths
 * pass through unchanged.
 */
export function normalizeSourceFiles(graph: Graph, kbDir: string): Graph {
  const cache = new Map<string, string>()
  const normalize = (sourceFile: string): string => {
    if (!sourceFile || !path.isAbsolute(sourceFile)) return sourceFile
    const cached = cache.get(sourceFile)
    if (cached !== undefined) return cached
    const parts = sourceFile.split("/").filter(Boolean)
    let result = sourceFile
    for (let i = 0; i < parts.length; i++) {
      const candidate = parts.slice(i).join("/")
      if (fs.existsSync(path.join(kbDir, candidate))) {
        result = candidate
        break
      }
    }
    cache.set(sourceFile, result)
    return result
  }
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, sourceFile: normalize(node.sourceFile) })),
    groups: graph.groups.map((group) => ({ ...group, sourceFile: normalize(group.sourceFile) })),
  }
}

/**
 * Detect graphify output in the KB clone and (re)generate the agent-facing
 * index. Returns whether an index is installed. The manifest hash embedded in
 * the index makes regeneration a cheap no-op while the graph is unchanged, so
 * this is safe to call on boot, config reload, and after every KB pull.
 */
export function installGraphifyIndex(kbDir: string, config: GraphifyConfig, log?: Logger): boolean {
  const indexPath = path.join(kbDir, INDEX_RELATIVE_PATH)
  const outputDir = path.join(kbDir, config.outputDir)
  const graphPath = path.join(outputDir, "graph.json")
  const manifestPath = path.join(outputDir, "manifest.json")

  if (!config.enabled || !fs.existsSync(graphPath)) {
    if (fs.existsSync(indexPath)) {
      fs.rmSync(indexPath) // stale index from a previous run
      log?.info("graphify index removed", { reason: config.enabled ? "graph.json absent" : "disabled" })
    }
    return false
  }

  // manifest.json lists every file graphify ingested with content hashes, so
  // hashing it detects graph changes without parsing the (large) graph.json.
  const manifestHash = fs.existsSync(manifestPath)
    ? crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex").slice(0, 16)
    : "no-manifest"
  if (fs.existsSync(indexPath) && fs.readFileSync(indexPath, "utf8").startsWith(indexMarker(manifestHash))) {
    return true // graph unchanged since the last generation
  }

  let graph: Graph
  try {
    graph = normalizeSourceFiles(parseGraph(JSON.parse(fs.readFileSync(graphPath, "utf8"))), kbDir)
  } catch (error) {
    log?.warn("cannot parse graphify graph; index skipped", { path: graphPath, error })
    return false
  }

  const index = buildIndexMarkdown(graph, { outputDir: config.outputDir, manifestHash })
  fs.mkdirSync(path.dirname(indexPath), { recursive: true })
  fs.writeFileSync(indexPath, index.markdown)
  log?.info("graphify index generated", {
    nodes: graph.nodes.length,
    links: graph.links.length,
    entities: index.entityCount,
    groups: index.groupCount,
    ...(index.entityCount < index.entityTotal
      ? { truncatedFrom: index.entityTotal, entityCap: INDEX_MAX_ENTITIES }
      : {}),
  })
  return true
}

/** First line of the generated index; ties it to the manifest that produced it. */
function indexMarker(manifestHash: string): string {
  return `<!-- generated by lorebot from graphify manifest ${manifestHash} — do not edit -->`
}
