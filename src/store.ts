import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"

export type ThreadKey = {
  channel: string
  threadTs: string
}

export class SessionStore {
  private db: Database

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS threads (
        channel TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (channel, thread_ts)
      )
    `)
  }

  get(key: ThreadKey): string | undefined {
    const row = this.db
      .query<{ session_id: string }, [string, string]>(
        "SELECT session_id FROM threads WHERE channel = ? AND thread_ts = ?",
      )
      .get(key.channel, key.threadTs)
    return row?.session_id
  }

  set(key: ThreadKey, sessionID: string): void {
    this.db.run(
      "INSERT OR REPLACE INTO threads (channel, thread_ts, session_id, created_at) VALUES (?, ?, ?, ?)",
      [key.channel, key.threadTs, sessionID, Date.now()],
    )
  }

  delete(key: ThreadKey): void {
    this.db.run("DELETE FROM threads WHERE channel = ? AND thread_ts = ?", [key.channel, key.threadTs])
  }

  has(key: ThreadKey): boolean {
    return this.get(key) !== undefined
  }

  close(): void {
    this.db.close()
  }
}
