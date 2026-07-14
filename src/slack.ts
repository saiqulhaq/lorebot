import bolt from "@slack/bolt"
import { type BotConfig, matchSensitiveKeyword } from "./botconfig"
import type { Config } from "./config"
import { AnswerTimeout, NoAnswer, SessionGone, type Engine } from "./engine"
import { toMrkdwn } from "./format"
import type { Logger } from "./logger"
import type { SessionStore, ThreadKey } from "./store"

/** Mutable holder so handlers always see the latest hot-reloaded config. */
export type BotConfigRef = { current: BotConfig }

export async function makeSlackApp(
  config: Config,
  botConfig: BotConfigRef,
  store: SessionStore,
  engine: Engine,
  log: Logger,
): Promise<bolt.App> {
  const app = new bolt.App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: config.logLevel === "debug" ? bolt.LogLevel.DEBUG : bolt.LogLevel.INFO,
  })

  const auth = await app.client.auth.test({ token: config.botToken })
  const botUserId = auth.user_id as string
  const mention = `<@${botUserId}>`

  /** Silent permission gate: who and where the bot answers at all. */
  function permitted(channel: string, user: string | undefined): boolean {
    const rules = botConfig.current.permissions
    if (rules.allowedChannels.length > 0 && !rules.allowedChannels.includes(channel)) {
      log.debug("ignored: channel not in allowedChannels", { channel })
      return false
    }
    if (user && rules.blockedUsers.includes(user)) {
      log.debug("ignored: user is blocked", { user })
      return false
    }
    if (rules.allowedUsers.length > 0 && (!user || !rules.allowedUsers.includes(user))) {
      log.debug("ignored: user not in allowedUsers", { user })
      return false
    }
    return true
  }

  app.event("app_mention", async ({ event }) => {
    const threadTs = event.thread_ts ?? event.ts
    const text = event.text.replaceAll(mention, "").trim()
    if (!text) return
    if (!permitted(event.channel, event.user)) return
    await answer({ channel: event.channel, threadTs }, text, event.user)
  })

  app.message(async ({ message }) => {
    if (!botConfig.current.features.threadFollowUps) return
    if (message.subtype || !("text" in message) || !message.text) return
    const threadTs = "thread_ts" in message ? message.thread_ts : undefined
    if (!threadTs) return // only thread follow-ups; new questions need a mention
    if ("bot_id" in message && message.bot_id) return
    if (message.text.includes(mention)) return // app_mention handles it
    const key = { channel: message.channel, threadTs }
    if (!store.has(key)) return // not a thread the bot owns
    const user = "user" in message ? message.user : undefined
    if (!permitted(message.channel, user)) return
    await answer(key, message.text.trim(), user)
  })

  async function answer(key: ThreadKey, question: string, user?: string): Promise<void> {
    const startedAt = Date.now()
    log.info("question received", {
      channel: key.channel,
      thread: key.threadTs,
      user,
      chars: question.length,
    })
    log.debug("question text", { question })

    // Sensitive-topic refusal: reply politely instead of consulting the KB.
    const keyword = matchSensitiveKeyword(question, botConfig.current.permissions.sensitiveKeywords)
    if (keyword) {
      log.info("question refused (sensitive keyword)", { channel: key.channel, thread: key.threadTs, keyword })
      await app.client.chat.postMessage({
        channel: key.channel,
        thread_ts: key.threadTs,
        text: botConfig.current.permissions.refusalMessage,
      })
      return
    }

    const placeholder = await app.client.chat.postMessage({
      channel: key.channel,
      thread_ts: key.threadTs,
      text: "_Thinking…_",
    })
    const placeholderTs = placeholder.ts as string

    const respond = (text: string) =>
      app.client.chat.update({ channel: key.channel, ts: placeholderTs, text })

    try {
      const text = await engine.enqueue(`${key.channel}-${key.threadTs}`, async () => {
        let sessionID = store.get(key)
        if (!sessionID) {
          sessionID = await engine.createSession()
          store.set(key, sessionID)
        }
        try {
          return await engine.ask(sessionID, question)
        } catch (error) {
          if (!(error instanceof SessionGone)) throw error
          // Server lost the session (deleted, db reset): start fresh once.
          log.warn("session gone, recreating", { channel: key.channel, thread: key.threadTs })
          store.delete(key)
          const fresh = await engine.createSession()
          store.set(key, fresh)
          return await engine.ask(fresh, question)
        }
      })
      await respond(
        toMrkdwn(text, {
          linkBase: config.linkBase,
          maxAnswerChars: botConfig.current.formatting.maxAnswerChars,
          maxBulletPoints: botConfig.current.formatting.maxBulletPoints,
          signOff: botConfig.current.answers.signOff,
        }),
      )
      log.info("question answered", {
        channel: key.channel,
        thread: key.threadTs,
        session: store.get(key),
        durationMs: Date.now() - startedAt,
        chars: text.length,
      })
    } catch (error) {
      log.error("failed to answer", {
        channel: key.channel,
        thread: key.threadTs,
        durationMs: Date.now() - startedAt,
        error,
      })
      const friendly =
        error instanceof AnswerTimeout
          ? "Sorry, that took too long to answer — please try asking again."
          : error instanceof NoAnswer
            ? "I ran out of search steps before I could put an answer together — try a more specific question, or raise `agent.steps` in lorebot.config.json."
            : "Sorry, something went wrong while answering. Please try again."
      await respond(friendly).catch(() => {})
    }
  }

  return app
}
