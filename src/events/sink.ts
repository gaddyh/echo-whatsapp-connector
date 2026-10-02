import { env } from '../config/env.js'
import { pool } from '../db/pool.js'
import type { NormalizedEvent } from './types.js'

export interface EventSink { publish(event: NormalizedEvent): Promise<void> }

class DbEventSink implements EventSink {
  async publish(event: NormalizedEvent): Promise<void> {
    const providerMessageId = event.event_type === 'message' ? event.provider_message_id : null
    await pool.query(
      `INSERT INTO whatsapp_connector.event_inbox(event_id, connection_id, event_type, provider_message_id, payload)
       VALUES($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT(connection_id, event_id) DO NOTHING`,
      [event.event_id, event.connection_id, event.event_type, providerMessageId, JSON.stringify(event)]
    )
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
