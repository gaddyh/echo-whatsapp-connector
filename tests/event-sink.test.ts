import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedConnectionEvent } from '../src/events/types.js'

const connect = vi.fn()
const clientQuery = vi.fn()
const client = { query: clientQuery, release: vi.fn() }

vi.mock('../src/config/env.js', () => ({ env: { EVENT_SINK: 'db' } }))
vi.mock('../src/db/pool.js', () => ({ pool: { connect } }))
vi.mock('../src/db/repositories.js', () => ({
  LostClaimError: class LostClaimError extends Error {
    constructor(readonly connectionId: string) {
      super(`lost connection claim: ${connectionId}`)
    }
  }
}))

const event: NormalizedConnectionEvent = {
  schema_version: 1,
  event_type: 'connection_state' as const,
  event_id: 'state:connection-id:1',
  provider: 'baileys' as const,
  connection_id: 'connection-id',
  status: 'connected' as const,
  provider_raw_status: 'open',
  timestamp: new Date().toISOString()
}

describe('database event fencing', () => {
  beforeEach(() => {
    connect.mockReset()
    clientQuery.mockReset()
    client.release.mockReset()
    connect.mockResolvedValue(client)
  })

  it('rejects locally before opening a transaction after ownership is unverified', async () => {
    const { eventSink } = await import('../src/events/sink.js')

    await expect(eventSink.publish(event, 'claim-token', () => false)).rejects.toThrow('lost connection claim')
    expect(connect).not.toHaveBeenCalled()
  })

  it('uses the database claim check as the final fence for an in-flight write', async () => {
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce(undefined)

    const { eventSink } = await import('../src/events/sink.js')

    await expect(eventSink.publish(event, 'claim-token', () => true)).rejects.toThrow('lost connection claim')
    expect(clientQuery.mock.calls[0]?.[0]).toBe('BEGIN')
    expect(clientQuery.mock.calls[1]?.[0]).toContain('claim_token=$2::uuid')
    expect(clientQuery.mock.calls[2]?.[0]).toBe('ROLLBACK')
  })

  it('inserts only after the claim check succeeds', async () => {
    clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)

    const { eventSink } = await import('../src/events/sink.js')

    await expect(eventSink.publish(event, 'claim-token', () => true)).resolves.toBeUndefined()
    expect(clientQuery.mock.calls[2]?.[0]).toContain('INSERT INTO whatsapp_connector.event_inbox')
    expect(clientQuery.mock.calls[3]?.[0]).toBe('COMMIT')
  })
})
