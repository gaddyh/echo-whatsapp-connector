import type { RingEntry } from '../observability/log-ring.js'
import { redactText } from './redact.js'

export interface WindowSample {
  level: number
  msg: string
  count: number
  connection?: string
  kind?: string
}

export interface WindowSummary {
  entries: number
  counters: Record<string, number>
  peakRecoveryPerMin: number
  distinctConnections: number
  byConnection: Record<string, Record<string, number>>
  samples: WindowSample[]
}

interface MutableSummary {
  counters: Record<string, number>
  recoveryByMinute: Map<number, number>
  connections: Set<string>
  byConnection: Map<string, Record<string, number>>
  samples: Map<string, WindowSample>
  entries: number
}

const ANOMALY_KEYS = new Set([
  'recovery_scheduled',
  'publish_dropped',
  'auth_lost',
  'media_failed',
  'ownership_lost'
])

const MAX_SAMPLES = 10

function zeroCounters(): Record<string, number> {
  return {
    restarts: 0,
    graceful_shutdowns: 0,
    claims_reacquired: 0,
    sockets_connected: 0,
    authenticated: 0,
    auth_lost: 0,
    qr_emitted: 0,
    qr_expired_dormant: 0,
    recovery_scheduled: 0,
    publish_retried: 0,
    publish_dropped: 0,
    claim_renewal_failures: 0,
    ownership_lost: 0,
    db_unreachable: 0,
    reconnect_errors: 0,
    media_ingested_ok: 0,
    media_failed: 0,
    media_oversized: 0,
    media_no_reference: 0,
    retention_sweeps: 0,
    retention_rows_deleted: 0,
    retention_failures: 0,
    identity_upsert_failures: 0,
    state_degraded: 0,
    disconnect_bad_session: 0,
    disconnect_version_mismatch: 0,
    disconnect_server_closed: 0,
    disconnect_unavailable: 0,
    http_requests: 0,
    http_5xx: 0,
    http_4xx: 0
  }
}

function connectionPrefix(entry: RingEntry): string | undefined {
  const id = entry.connection_id
  return typeof id === 'string' && id.length > 8 ? id.slice(0, 8) : (typeof id === 'string' ? id : undefined)
}

function bump(summary: MutableSummary, key: string, entry: RingEntry, count = 1): void {
  summary.counters[key] = (summary.counters[key] ?? 0) + count
  if (ANOMALY_KEYS.has(key)) {
    const connection = connectionPrefix(entry)
    if (connection) {
      const perConnection = summary.byConnection.get(connection) ?? {}
      perConnection[key] = (perConnection[key] ?? 0) + count
      summary.byConnection.set(connection, perConnection)
    }
  }
}

function collectSample(summary: MutableSummary, entry: RingEntry): void {
  if (summary.samples.size >= MAX_SAMPLES && !summary.samples.has(entry.msg)) return
  const existing = summary.samples.get(entry.msg)
  if (existing) {
    existing.count += 1
    return
  }
  const connection = connectionPrefix(entry)
  const kind = typeof entry.kind === 'string' ? entry.kind : undefined
  summary.samples.set(entry.msg, {
    level: entry.level,
    msg: redactText(entry.msg),
    count: 1,
    ...(connection ? { connection: redactText(connection) } : {}),
    ...(kind ? { kind } : {})
  })
}

/**
 * Aggregates a window of ring entries into the counters package given to the
 * LLM digest. Pure: no I/O, no clock reads. Monitor's own log lines
 * (component 'log-monitor') are excluded to avoid feedback loops.
 */
export function summarizeWindow(entries: RingEntry[]): WindowSummary {
  const summary: MutableSummary = {
    counters: zeroCounters(),
    recoveryByMinute: new Map(),
    connections: new Set(),
    byConnection: new Map(),
    samples: new Map(),
    entries: 0
  }

  for (const entry of entries) {
    if (entry.component === 'log-monitor') continue
    summary.entries += 1
    if (typeof entry.connection_id === 'string') summary.connections.add(entry.connection_id)

    const msg = entry.msg
    const event = typeof entry.event === 'string' ? entry.event : undefined

    if (msg === 'connector started') bump(summary, 'restarts', entry)
    else if (msg === 'shutting down') bump(summary, 'graceful_shutdowns', entry)
    else if (msg === 'connection claim reacquired') bump(summary, 'claims_reacquired', entry)
    else if (msg === 'connected to WA') bump(summary, 'sockets_connected', entry)
    else if (msg === 'authenticated WhatsApp account') bump(summary, 'authenticated', entry)
    else if (msg === 'pairing QR emitted') bump(summary, 'qr_emitted', entry)
    else if (msg === 'connection recovery scheduled') {
      bump(summary, 'recovery_scheduled', entry)
      const minute = Math.floor(entry.time / 60_000)
      summary.recoveryByMinute.set(minute, (summary.recoveryByMinute.get(minute) ?? 0) + 1)
    } else if (msg === 'event publish failed; retrying') bump(summary, 'publish_retried', entry)
    else if (msg === 'event publish dropped after retries') bump(summary, 'publish_dropped', entry)
    else if (msg === 'claim renewal failed') bump(summary, 'claim_renewal_failures', entry)
    else if (msg === 'connection ownership lost') bump(summary, 'ownership_lost', entry)
    else if (msg === 'health check failed: database unreachable') bump(summary, 'db_unreachable', entry)
    else if (msg === 'reconnect failed') bump(summary, 'reconnect_errors', entry)
    else if (msg === 'media ingestion download succeeded') bump(summary, 'media_ingested_ok', entry)
    else if (msg === 'media download failed after retries') bump(summary, 'media_failed', entry)
    else if (msg === 'media download rejected: oversized') bump(summary, 'media_oversized', entry)
    else if (msg === 'media message has no media_reference') bump(summary, 'media_no_reference', entry)
    else if (msg === 'retention sweep deleted rows') {
      bump(summary, 'retention_sweeps', entry)
      const deleted =
        (typeof entry.processedEventsDeleted === 'number' ? entry.processedEventsDeleted : 0) +
        (typeof entry.unprocessedEventsDeleted === 'number' ? entry.unprocessedEventsDeleted : 0) +
        (typeof entry.mediaBlobsDeleted === 'number' ? entry.mediaBlobsDeleted : 0)
      summary.counters.retention_rows_deleted = (summary.counters.retention_rows_deleted ?? 0) + deleted
    } else if (msg === 'retention sweep failed') bump(summary, 'retention_failures', entry)
    else if (msg === 'identity upsert failed') bump(summary, 'identity_upsert_failures', entry)

    if (event === 'reconnect.auth_lost') bump(summary, 'auth_lost', entry)
    else if (event === 'reconnect.qr_expired') bump(summary, 'qr_expired_dormant', entry)

    if (msg === 'request completed') {
      const url = typeof entry.req === 'object' && entry.req !== null ? (entry.req as { url?: unknown }).url : undefined
      if (typeof url === 'string' && !url.startsWith('/health')) {
        bump(summary, 'http_requests', entry)
        const statusCode = typeof entry.res === 'object' && entry.res !== null
          ? (entry.res as { statusCode?: unknown }).statusCode
          : undefined
        if (statusCode === 500 || statusCode === 502 || statusCode === 503) bump(summary, 'http_5xx', entry)
        else if (typeof statusCode === 'number' && statusCode >= 400) bump(summary, 'http_4xx', entry)
      }
    }

    if (msg === 'connection state changed' && entry.status === 'degraded') {
      bump(summary, 'state_degraded', entry)
      const rawStatus = typeof entry.raw_status === 'string' ? entry.raw_status : ''
      if (rawStatus === 'disconnect:500') bump(summary, 'disconnect_bad_session', entry)
      else if (rawStatus === 'disconnect:405') bump(summary, 'disconnect_version_mismatch', entry)
      else if (rawStatus === 'disconnect:428') bump(summary, 'disconnect_server_closed', entry)
      else if (rawStatus === 'disconnect:503') bump(summary, 'disconnect_unavailable', entry)
    }

    if (entry.level >= 40) collectSample(summary, entry)
  }

  const byConnection: Record<string, Record<string, number>> = {}
  for (const [connection, counts] of summary.byConnection) byConnection[connection] = counts

  return {
    entries: summary.entries,
    counters: summary.counters,
    peakRecoveryPerMin: summary.recoveryByMinute.size > 0
      ? Math.max(...summary.recoveryByMinute.values())
      : 0,
    distinctConnections: summary.connections.size,
    byConnection,
    samples: [...summary.samples.values()]
  }
}
