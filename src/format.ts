const SLACK_TEXT_LIMIT = 3900

/**
 * Convert common markdown to Slack mrkdwn. Handles the subset a Q&A agent
 * actually produces: bold, links, headings, and code (passed through).
 */
export function toMrkdwn(markdown: string, linkBase?: string): string {
  const segments = splitByCodeFences(markdown)
  const converted = segments
    .map((segment) => {
      if (segment.code) {
        // Inline-code citations like `docs/x.md` become links; other code passes through.
        if (linkBase && /^`[^`\s]+\.(?:md|mdx)`$/.test(segment.text)) {
          return linkifyCitations(segment.text, linkBase)
        }
        return segment.text
      }
      let text = segment.text
      // [title](url) -> <url|title>
      text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>")
      // **bold** / __bold__ -> *bold*
      text = text.replace(/\*\*([^*]+)\*\*/g, "*$1*")
      text = text.replace(/__([^_]+)__/g, "*$1*")
      // headings -> bold line
      text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
      return text
    })
    .join("")
  return truncate(converted, SLACK_TEXT_LIMIT)
}

/** Rewrite backticked relative markdown paths to Slack links: `docs/x.md` -> <base/docs/x.md|docs/x.md> */
function linkifyCitations(text: string, linkBase: string): string {
  const base = linkBase.endsWith("/") ? linkBase : `${linkBase}/`
  return text.replace(/`([^`\s]+\.(?:md|mdx))`/g, (_, file: string) => `<${base}${file}|${file}>`)
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n_…truncated_`
}

type Segment = { code: boolean; text: string }

function splitByCodeFences(text: string): Segment[] {
  const segments: Segment[] = []
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g)
  for (const part of parts) {
    if (part === "") continue
    segments.push({ code: part.startsWith("`"), text: part })
  }
  return segments
}
