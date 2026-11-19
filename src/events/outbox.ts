/**
 * Local write-ahead outbox for message events.
 *
 * Every normalized message event is committed here BEFORE any Postgres
 * publish attempt, so an event received by a live socket is always in one
 * of three states: in Postgres, in this outbox, or inside a single bounded
 * publish attempt that started from the outbox — never dropped. The payload
 * is immutable once appended: there is no enrichment-after-append, no
 * state machine and no revision — session and drainer publish
 * byte-identical payloads and the Postgres unique constraint
 * (connection_id, event_id) absorbs any overlap.
 *
 * Capacity is a pressure policy, not permission to discard: the soft limit
 * warns; the hard limit refuses new appends with a critical signal while
 * ingestion continues without the durability guarantee.
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { env } from '../config/env.js'
import { logger } from '../observability/logger.js'
import type { NormalizedMessageEvent } from '../events/types.js'
import { insertEventUnfenced } from './sink.js'

export interface OutboxRow {
  connection_id: string
  event_id: string
  payload: string
  created_at: number
}

export class EventOutbox {
  private readonly db: Database.Database
  private readonly appendStmt: Database.Statement
  private readonly deleteStmt: Database.Statement
  private readonly countStmt: Database.Statement
  private readonly oldestStmt: Database.Statement
  private hardLimited = false

  constructor(
    private readonly dir: string,
    private readonly softLimit: number,
    private readonly hardLimit: number
  ) {
    fs.mkdirSync(dir, { recursive: true })
    this.db = new Database(path.join(dir, 'outbox.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS outbox (
         connection_id TEXT NOT NULL,
         event_id      TEXT NOT NULL,
         payload       TEXT NOT NULL,
         created_at    INTEGER NOT NULL,
         PRIMARY KEY (connection_id, event_id)
       )`
    )
    this.appendStmt = this.db.prepare(
      'INSERT OR IGNORE INTO outbox (connection_id, event_id, payload, created_at) VALUES (?, ?, ?, ?)'
    )
    this.deleteStmt = this.db.prepare(
      'DELETE FROM outbox WHERE connection_id = ? AND event_id = ?'
    )
    this.countStmt = this.db.prepare('SELECT COUNT(*) AS n FROM outbox')
    this.oldestStmt = this.db.prepare('SELECT MIN(created_at) AS oldest FROM outbox')
  }

  /** Commits the final, immutable event payload. Idempotent per key. */
  append(event: NormalizedMessageEvent): boolean {
    const count = this.countStmt.get() as { n: number }
    if (count.n >= this.hardLimit) {
      if (!this.hardLimited) {
        logger.error(
          { component: 'outbox', pending: count.n, hard_limit: this.hardLimit },
          'outbox hard limit reached; ingestion durability NOT guaranteed until drained'
        )
        this.hardLimited = true
      }
      return false
    }
    this.hardLimited = false
    this.appendStmt.run(event.connection_id, event.event_id, JSON.stringify(event), Date.now())
    if (count.n + 1 >= this.softLimit) {
      logger.warn(
        { component: 'outbox', pending: count.n + 1, soft_limit: this.softLimit },
        'outbox soft limit reached; database publish appears stalled'
      )
    }
    return true
  }

  delete(connectionId: string, eventId: string): void {
    this.deleteStmt.run(connectionId, eventId)
  }

  pending(limit: number): OutboxRow[] {
    return (
      this.db
        .prepare('SELECT connection_id, event_id, payload, created_at FROM outbox ORDER BY created_at, rowid LIMIT ?')
        .all(limit) as OutboxRow[]
    )
  }

  count(): number {
    return (this.countStmt.get() as { n: number }).n
  }

  oldestAgeSeconds(): number {
    const row = this.oldestStmt.get() as { oldest: number | null }
    return row.oldest === null ? 0 : Math.round((Date.now() - row.oldest) / 1000)
  }

  diskBytes(): number {
    try {
      return fs.statSync(path.join(this.dir, 'outbox.db')).size
    } catch {
      return 0
    }
  }

  close(): void {
    this.db.close()
  }
}

let outboxInstance: EventOutbox | undefined

export function getOutbox(): EventOutbox {
  if (!outboxInstance) {
    outboxInstance = new EventOutbox(
      env.EVENT_OUTBOX_DIR,
      env.EVENT_OUTBOX_MAX_EVENTS,
      env.EVENT_OUTBOX_HARD_MAX_EVENTS
    )
  }
  return outboxInstance
}

export interface DrainResult {
  replayed: number
  remaining: number
  oldestAgeSeconds: number
  diskBytes: number
}

/**
 * Replays pending outbox rows into event_inbox (unfenced, idempotent via
 * ON CONFLICT). A foreign-key violation (connection deleted) is an
 * auditable terminal drop; any other error stops the batch and retries on
 * the next tick — the drainer never discards on transient failure.
 */
export async function runOutboxDrain(outbox: EventOutbox = getOutbox()): Promise<DrainResult> {
  let replayed = 0
  for (const row of outbox.pending(500)) {
    try {
      await insertEventUnfenced(JSON.parse(row.payload))
      outbox.delete(row.connection_id, row.event_id)
      replayed++
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === '23503') {
        logger.error(
          { component: 'outbox', connection_id: row.connection_id, event_id: row.event_id },
          'outbox event dropped: connection no longer exists (auditable terminal state)'
        )
        outbox.delete(row.connection_id, row.event_id)
        continue
      }
      logger.warn({ err, component: 'outbox' }, 'outbox drain failed; will retry next tick')
      break
    }
  }
  const remaining = outbox.count()
  const oldestAgeSeconds = outbox.oldestAgeSeconds()
  const diskBytes = outbox.diskBytes()
  if (replayed > 0 || remaining > 0) {
    logger.info(
      { component: 'outbox', replayed, remaining, oldest_age_seconds: oldestAgeSeconds, disk_bytes: diskBytes },
      'outbox drained'
    )
  }
  return { replayed, remaining, oldestAgeSeconds, diskBytes }
}

let drainTimer: NodeJS.Timeout | undefined
let draining = false

export function startOutboxDrainer(): void {
  if (drainTimer) return
  const tick = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      await runOutboxDrain()
    } catch (err) {
      logger.warn({ err, component: 'outbox' }, 'outbox drain tick failed; will retry')
    } finally {
      draining = false
    }
  }
  void tick()
  drainTimer = setInterval(() => void tick(), env.EVENT_OUTBOX_DRAIN_MS)
  drainTimer.unref()
  logger.info({ component: 'outbox', drain_interval_ms: env.EVENT_OUTBOX_DRAIN_MS }, 'outbox drainer started')
}

export function stopOutboxDrainer(): void {
  if (drainTimer) clearInterval(drainTimer)
  drainTimer = undefined
}
