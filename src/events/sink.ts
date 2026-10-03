import { env } from '../config/env.js'
import { pool } from '../db/pool.js'
import type { NormalizedEvent } from './types.js'
import { LostClaimError } from '../db/repositories.js'

export interface EventSink { publish(event: NormalizedEvent, claimToken?: string): Promise<void> }

class DbEventSink implements EventSink {
  async publish(event: NormalizedEvent, claimToken?: string): Promise<void> {
    if (!claimToken) throw new LostClaimError(event.connection_id)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const claim = await client.query(
        `SELECT 1 FROM whatsapp_connector.connections
          WHERE id=$1 AND claim_token=$2::uuid AND claim_expires_at > now()
          FOR UPDATE`,
        [event.connection_id, claimToken]
      )
      if (claim.rowCount !== 1) throw new LostClaimError(event.connection_id)
      const providerMessageId = event.event_type === 'message' ? event.provider_message_id : null
      await client.query(
        `INSERT INTO whatsapp_connector.event_inbox(event_id, connection_id, event_type, provider_message_id, payload)
         VALUES($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT(connection_id, event_id) DO NOTHING`,
        [event.event_id, event.connection_id, event.event_type, providerMessageId, JSON.stringify(event)]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}

class HttpEventSink implements EventSink {
  async publish(event: NormalizedEvent): Promise<void> {
    if (!env.EVENT_WEBHOOK_URL) throw new Error('EVENT_WEBHOOK_URL is required for EVENT_SINK=http')
    const res = await fetch(env.EVENT_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.EVENT_WEBHOOK_TOKEN ? { authorization: `Bearer ${env.EVENT_WEBHOOK_TOKEN}` } : {})
      },
      body: JSON.stringify(event)
    })
    if (!res.ok) throw new Error(`event webhook returned HTTP ${res.status}`)
  }
}

export const eventSink: EventSink = env.EVENT_SINK === 'http' ? new HttpEventSink() : new DbEventSink()
