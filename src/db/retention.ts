import { env } from '../config/env.js'
import { logger } from '../observability/logger.js'
import { pool } from './pool.js'

export interface RetentionSweepResult {
  processedEventsDeleted: number
  unprocessedEventsDeleted: number
  mediaBlobsDeleted: number
}

/**
 * Deletes consumed event_inbox rows and aged media_blobs so neither grows
 * unboundedly on the shared database. Never touches connections,
 * auth_credentials or auth_keys — deleting auth state is governed by the
 * session-safety rules in AGENTS.md. A retention rule set to 0 days is
 * disabled. Failures are logged and surfaced as zero counts; the sweep must
 * never crash the worker, and the next interval retries idempotently.
 */
export async function runRetentionSweep(): Promise<RetentionSweepResult> {
  const result: RetentionSweepResult = {
    processedEventsDeleted: 0,
    unprocessedEventsDeleted: 0,
    mediaBlobsDeleted: 0
  }
  try {
    if (env.EVENT_RETENTION_DAYS > 0) {
      const deleted = await pool.query(
        `DELETE FROM whatsapp_connector.event_inbox
          WHERE processed_at IS NOT NULL
            AND processed_at < now() - ($1::text || ' days')::interval`,
        [String(env.EVENT_RETENTION_DAYS)]
      )
      result.processedEventsDeleted = deleted.rowCount ?? 0
    }
    if (env.UNPROCESSED_EVENT_RETENTION_DAYS > 0) {
      const deleted = await pool.query(
        `DELETE FROM whatsapp_connector.event_inbox
          WHERE processed_at IS NULL
            AND received_at < now() - ($1::text || ' days')::interval`,
        [String(env.UNPROCESSED_EVENT_RETENTION_DAYS)]
      )
      result.unprocessedEventsDeleted = deleted.rowCount ?? 0
    }
    if (env.MEDIA_RETENTION_DAYS > 0) {
      const deleted = await pool.query(
        `DELETE FROM whatsapp_connector.media_blobs
          WHERE created_at < now() - ($1::text || ' days')::interval`,
        [String(env.MEDIA_RETENTION_DAYS)]
      )
      result.mediaBlobsDeleted = deleted.rowCount ?? 0
    }
    const total = result.processedEventsDeleted + result.unprocessedEventsDeleted + result.mediaBlobsDeleted
    if (total > 0) logger.info({ ...result }, 'retention sweep deleted rows')
  } catch (err) {
    logger.error({ err }, 'retention sweep failed; will retry on the next interval')
  }
  return result
}
