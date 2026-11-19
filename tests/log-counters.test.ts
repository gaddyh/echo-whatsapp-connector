import { describe, expect, it } from 'vitest'
import type { RingEntry } from '../src/observability/log-ring.js'
import { summarizeWindow } from '../src/monitor/counters.js'

const T = 1_700_000_000_000

function entry(msg: string, fields: Record<string, unknown> = {}, level = 30, time = T): RingEntry {
  return { level, time, msg, ...fields }
}

describe('log window counters', () => {
  it('counts every known signature from the production log vocabulary', () => {
    const summary = summarizeWindow([
      entry('connector started'),
      entry('shutting down'),
      entry('connection claim reacquired', { connection_id: 'c1' }),
      entry('connected to WA', { connection_id: 'c1' }),
      entry('authenticated WhatsApp account', { connection_id: 'c1' }),
      entry('pairing QR emitted', { connection_id: 'c2' }),
      entry('event publish failed; retrying', { connection_id: 'c1' }),
      entry('event publish dropped after retries', { connection_id: 'c1' }),
      entry('claim renewal failed', { connection_id: 'c1' }),
      entry('connection ownership lost', { connection_id: 'c1' }),
      entry('health check failed: database unreachable'),
      entry('reconnect failed', { connection_id: 'c1' }),
      entry('media ingestion download succeeded', { connection_id: 'c1' }),
      entry('media download failed after retries', { connection_id: 'c3' }),
      entry('media download rejected: oversized', { connection_id: 'c3' }),
      entry('media message has no media_reference', { connection_id: 'c3', kind: 'image' }),
      entry('retention sweep deleted rows', { processedEventsDeleted: 10, unprocessedEventsDeleted: 2, mediaBlobsDeleted: 3 }),
      entry('retention sweep failed'),
      entry('identity upsert failed', { connection_id: 'c1' }),
      entry('authenticated connection logged out', { event: 'reconnect.auth_lost', connection_id: 'c4' }),
      entry('never-paired connection exhausted its pairing QR refs; going dormant', { event: 'reconnect.qr_expired', connection_id: 'c5' }),
      entry('request completed', { req: { url: '/media/c/r?expires=1&signature=x' }, res: { statusCode: 200 } }),
      entry('request completed', { req: { url: '/media/c/r?expires=1&signature=x' }, res: { statusCode: 503 } }),
      entry('request completed', { req: { url: '/connections' }, res: { statusCode: 401 } }),
      entry('request completed', { req: { url: '/health' }, res: { statusCode: 200 } })
    ])

    expect(summary.counters).toMatchObject({
      restarts: 1,
      graceful_shutdowns: 1,
      claims_reacquired: 1,
      sockets_connected: 1,
      authenticated: 1,
      qr_emitted: 1,
      publish_retried: 1,
      publish_dropped: 1,
      claim_renewal_failures: 1,
      ownership_lost: 1,
      db_unreachable: 1,
      reconnect_errors: 1,
      media_ingested_ok: 1,
      media_failed: 1,
      media_oversized: 1,
      media_no_reference: 1,
      retention_sweeps: 1,
      retention_rows_deleted: 15,
      retention_failures: 1,
      identity_upsert_failures: 1,
      auth_lost: 1,
      qr_expired_dormant: 1,
      http_requests: 3,
      http_5xx: 1,
      http_4xx: 1
    })
    // /health probes are excluded from http_requests.
    expect(summary.counters.http_requests).toBe(3)
    expect(summary.distinctConnections).toBe(5)
  })

  it('computes the recovery rate peak per minute', () => {
    const summary = summarizeWindow([
      entry('connection recovery scheduled', { connection_id: 'c1' }, 30, T),
      entry('connection recovery scheduled', { connection_id: 'c2' }, 30, T + 10_000),
      entry('connection recovery scheduled', { connection_id: 'c3' }, 30, T + 20_000),
      entry('connection recovery scheduled', { connection_id: 'c1' }, 30, T + 120_000)
    ])
    expect(summary.counters.recovery_scheduled).toBe(4)
    expect(summary.peakRecoveryPerMin).toBe(3)
  })

  it('tracks anomalies per connection with truncated ids', () => {
    const summary = summarizeWindow([
      entry('connection recovery scheduled', { connection_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
      entry('event publish dropped after retries', { connection_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
      entry('connection recovery scheduled', { connection_id: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee' })
    ])
    expect(summary.byConnection).toEqual({
      aaaaaaaa: { recovery_scheduled: 1, publish_dropped: 1 },
      ffffffff: { recovery_scheduled: 1 }
    })
  })

  it('excludes the monitor’s own log lines', () => {
    const summary = summarizeWindow([
      entry('hourly log digest', { component: 'log-monitor' }),
      entry('connection recovery scheduled', { connection_id: 'c1' })
    ])
    expect(summary.entries).toBe(1)
    expect(summary.counters.recovery_scheduled).toBe(1)
  })

  it('counts disconnect reasons from connection state transitions', () => {
    const summary = summarizeWindow([
      entry('connection state changed', { connection_id: 'c1', status: 'degraded', raw_status: 'disconnect:500' }),
      entry('connection state changed', { connection_id: 'c1', status: 'degraded', raw_status: 'disconnect:500' }),
      entry('connection state changed', { connection_id: 'c2', status: 'degraded', raw_status: 'disconnect:428' }),
      entry('connection state changed', { connection_id: 'c3', status: 'degraded', raw_status: 'disconnect:405' }),
      entry('connection state changed', { connection_id: 'c4', status: 'degraded', raw_status: 'disconnect:503' }),
      entry('connection state changed', { connection_id: 'c5', status: 'degraded', raw_status: 'disconnect:unknown' }),
      entry('connection state changed', { connection_id: 'c6', status: 'connecting', raw_status: 'opening_socket' }),
      entry('connection state changed', { connection_id: 'c7', status: 'connected', raw_status: 'open' })
    ])
    expect(summary.counters.state_degraded).toBe(6)
    expect(summary.counters.disconnect_bad_session).toBe(2)
    expect(summary.counters.disconnect_server_closed).toBe(1)
    expect(summary.counters.disconnect_version_mismatch).toBe(1)
    expect(summary.counters.disconnect_unavailable).toBe(1)
  })

  it('deduplicates warn/error samples and redacts them', () => {
    const summary = summarizeWindow([
      entry('media message has no media_reference — mediaKey missing', { connection_id: 'aaaaaaaa-bbbb', kind: 'image' }, 40),
      entry('media message has no media_reference — mediaKey missing', { connection_id: 'aaaaaaaa-bbbb', kind: 'image' }, 40),
      entry('claim renewal failed for 972501234567', { connection_id: 'c1' }, 50),
      entry('connection claim reacquired', { connection_id: 'c1' })
    ])
    expect(summary.samples).toHaveLength(2)
    const noReference = summary.samples.find(s => s.msg.includes('no media_reference'))!
    expect(noReference.count).toBe(2)
    expect(noReference.connection).toBe('aaaaaaaa')
    expect(summary.samples.some(s => s.msg.includes('972501234567'))).toBe(false)
  })
})
