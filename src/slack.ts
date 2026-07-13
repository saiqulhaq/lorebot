import bolt from "@slack/bolt"
import type { Config } from "./config"
import { AnswerTimeout, SessionGone, type Engine } from "./engine"
import { toMrkdwn } from "./format"
import type { SessionStore, ThreadKey } from "./store"

export async function makeSlackApp(config: Config, store: SessionStore, engine: Engine): Promise<bolt.App> {
  const app = new bolt.App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: config.logLevel === "debug" ? bolt.LogLevel.DEBUG : bolt.LogLevel.INFO,
  })

  const auth = await app.client.auth.test({ token: config.botToken })
  const botUserId = auth.user_id as string
  const mention = `<@${botUserId}>`

  app.event("app_mention", async ({ event }) => {
    const threadTs = event.thread_ts ?? event.ts
    const text = event.text.replaceAll(mention, "").trim()
    if (!text) return
    await answer({ channel: event.channel, threadTs }, text)
  })

  app.message(async ({ message }) => {
    if (message.subtype || !("text" in message) || !message.text) return
    const threadTs = "thread_ts" in message ? message.thread_ts : undefined
    if (!threadTs) return // only thread follow-ups; new questions need a mention
    if ("bot_id" in message && message.bot_id) return
    if (message.text.includes(mention)) return // app_mention handles it
    const key = { channel: message.channel, threadTs }
    if (!store.has(key)) return // not a thread the bot owns
    await answer(key, message.text.trim())
  })

  async function answer(key: ThreadKey, question: string): Promise<void> {
    if (config.logLevel === "debug") console.log(`[${key.channel}/${key.threadTs}] Q: ${question}`)

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
          store.delete(key)
          const fresh = await engine.createSession()
          store.set(key, fresh)
          return await engine.ask(fresh, question)
        }
      })
      await respond(toMrkdwn(text, config.linkBase))
    } catch (error) {
      console.error(`Failed to answer in ${key.channel}/${key.threadTs}:`, error)
      const friendly =
        error instanceof AnswerTimeout
          ? "Sorry, that took too long to answer — please try asking again."
          : "Sorry, something went wrong while answering. Please try again."
      await respond(friendly).catch(() => {})
    }
  }

  return app
}
