/**
 * Bounded background work queue for post-publish enrichment.
 *
 * Identity upserts, group-metadata cache warming and media blob warming run
 * AFTER the event is durable (outbox + publish attempt) — they never block
 * ingestion and never mutate the event. Concurrency is bounded so 100
 * connections cannot produce hundreds of parallel database/WhatsApp
 * operations; the queue itself is capped, dropping oldest with a warning
 * (identity and group data self-heal on reconnect via contacts/groups
 * replay, so a drop is a delay, not a loss).
 */
import { env } from '../config/env.js'
import { logger } from '../observability/logger.js'

interface QueuedTask {
  run: () => Promise<void>
  label: string
}

const queue: QueuedTask[] = []
const QUEUE_CAP = 500
let active = 0

function pump(): void {
  while (active < env.POST_PUBLISH_CONCURRENCY && queue.length > 0) {
    const task = queue.shift()!
    active++
    void task
      .run()
      .catch(err => logger.warn({ err, task: task.label }, 'background enrichment task failed'))
      .finally(() => {
        active--
        pump()
      })
  }
}

export function enqueueBackground(label: string, run: () => Promise<void>): void {
  if (queue.length >= QUEUE_CAP) {
    queue.shift()
    logger.warn({ task: label, queue_cap: QUEUE_CAP }, 'background queue overflow; dropped oldest task')
  }
  queue.push({ label, run })
  pump()
}
