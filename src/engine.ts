import {
  OpenCode,
  isConflictError,
  isSessionBusyError,
  isSessionNotFoundError,
  type SessionMessageInfo,
} from "@opencode-ai/client"
import path from "node:path"
import type { Config } from "./config"
import type { Logger } from "./logger"

/** Thrown when the server no longer knows the session; caller should retry with a fresh one. */
export class SessionGone extends Error {
  constructor(sessionID: string) {
    super(`Session ${sessionID} no longer exists on the OpenCode server`)
    this.name = "SessionGone"
  }
}

export class AnswerTimeout extends Error {
  constructor(ms: number) {
    super(`No answer within ${Math.round(ms / 1000)}s`)
    this.name = "AnswerTimeout"
  }
}

/** The agent loop finished without any text output (e.g. steps exhausted mid-search). */
export class NoAnswer extends Error {
  constructor() {
    super("The agent finished without producing a text answer")
    this.name = "NoAnswer"
  }
}

export type Engine = ReturnType<typeof makeEngine>

export function makeEngine(config: Config, kbDir: string, log: Logger) {
  const client = OpenCode.make({
    baseUrl: config.opencodeUrl,
    headers: config.opencodePassword
      ? { authorization: `Basic ${btoa(`opencode:${config.opencodePassword}`)}` }
      : undefined,
  })

  // Serializes questions per thread so rapid messages run in order.
  const queues = new Map<string, Promise<unknown>>()

  async function healthCheck(): Promise<void> {
    try {
      await client.health.get()
    } catch (error) {
      if (isHttpStatus(error, 401)) {
        throw new Error(
          `OpenCode server at ${config.opencodeUrl} rejected the password. ` +
            `Check OPENCODE_SERVER_PASSWORD matches the server's.`,
        )
      }
      throw new Error(
        `Cannot reach OpenCode server at ${config.opencodeUrl}. ` +
          `Start one with: opencode2 serve (see README). Underlying error: ${message(error)}`,
      )
    }
  }

  async function createSession(): Promise<string> {
    const session = await client.session.create({
      agent: config.agent,
      location: { directory: kbDir },
    })
    log.info("session created", { session: session.id, agent: config.agent })
    return session.id
  }

  /** Full v2 flow: admit prompt -> wait for idle -> read newest assistant message. */
  async function ask(sessionID: string, text: string): Promise<string> {
    // Sessions are pinned to the directory they were created with; if the KB
    // clone moved, execution fails silently. Treat a mismatch as a gone
    // session so the caller recreates it against the current location.
    let session
    try {
      session = await client.session.get({ sessionID })
    } catch (error) {
      if (isSessionNotFoundError(error)) throw new SessionGone(sessionID)
      throw error
    }
    if (path.resolve(session.location.directory) !== path.resolve(kbDir)) {
      log.warn("session points at a stale KB directory, recreating", {
        session: sessionID,
        directory: session.location.directory,
      })
      throw new SessionGone(sessionID)
    }

    const promptedAt = Date.now()
    await admit(sessionID, text)

    const signal = AbortSignal.timeout(config.answerTimeoutMs)
    try {
      await client.session.wait({ sessionID }, { signal })
    } catch (error) {
      if (signal.aborted) throw new AnswerTimeout(config.answerTimeoutMs)
      if (isSessionNotFoundError(error)) throw new SessionGone(sessionID)
      throw error
    }

    const messages = await client.message.list({ sessionID, limit: 10, order: "desc" })
    const answer = extractAnswer(messages.data, promptedAt)
    if (answer === undefined) throw new NoAnswer()
    return answer
  }

  async function admit(sessionID: string, text: string): Promise<void> {
    try {
      await client.session.prompt({ sessionID, text })
    } catch (error) {
      if (isSessionNotFoundError(error)) throw new SessionGone(sessionID)
      if (isSessionBusyError(error) || isConflictError(error)) {
        log.debug("session busy, queueing prompt", { session: sessionID })
        await client.session.prompt({ sessionID, text, delivery: "queue" })
        return
      }
      throw error
    }
  }

  /** Run `work` after any previous work for the same thread key completes. */
  function enqueue<T>(threadKey: string, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(threadKey) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    queues.set(threadKey, next)
    // The caller handles next's rejection; this cleanup chain must swallow it
    // separately or it becomes an unhandled rejection that kills the process.
    void next.catch(() => {}).finally(() => {
      if (queues.get(threadKey) === next) queues.delete(threadKey)
    })
    return next
  }

  return { healthCheck, createSession, ask, enqueue }
}

/**
 * Pick the newest assistant message created after the prompt was admitted and
 * join its text content. Returns undefined when there is no usable answer.
 */
export function extractAnswer(messages: readonly SessionMessageInfo[], promptedAt: number): string | undefined {
  for (const info of messages) {
    if (info.type !== "assistant") continue
    if (info.time.created < promptedAt) break // list is newest-first; older ones are previous turns
    if (info.finish === "error" || info.error) {
      const detail = info.error && "message" in info.error ? String(info.error.message) : "unknown error"
      throw new Error(`Agent run failed: ${detail}`)
    }
    const text = info.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return undefined
}

function isHttpStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("status" in error && error.status === status) ||
      ("cause" in error && isHttpStatus((error as { cause?: unknown }).cause, status)))
  )
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
