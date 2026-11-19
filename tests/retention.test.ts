import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()

const mockEnv = {
  EVENT_RETENTION_DAYS: 7,
  UNPROCESSED_EVENT_RETENTION_DAYS: 30,
  MEDIA_RETENTION_DAYS: 30,
  RETENTION_SWEEP_INTERVAL_MS: 3_600_000
}

vi.mock('../src/db/pool.js', () => ({ pool: { query: (...args: unknown[]) => query(...args) } }))
vi.mock('../src/config/env.js', () => ({ env: mockEnv }))
vi.mock('../src/observability/logger.js', () => ({
  logger: { child: vi.fn(() => ({})), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
}))

describe('retention sweep', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    mockEnv.EVENT_RETENTION_DAYS = 7
    mockEnv.UNPROCESSED_EVENT_RETENTION_DAYS = 30
    mockEnv.MEDIA_RETENTION_DAYS = 30
  })

  it('deletes processed events, unprocessed stragglers and old media blobs', async () => {
    query
      .mockResolvedValueOnce({ rowCount: 12 })
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce({ rowCount: 5 })
    const { runRetentionSweep } = await import('../src/db/retention.js')

    const result = await runRetentionSweep()

    expect(result).toEqual({ processedEventsDeleted: 12, unprocessedEventsDeleted: 3, mediaBlobsDeleted: 5 })
    expect(query.mock.calls[0]![0]).toContain('event_inbox')
    expect(query.mock.calls[0]![0]).toContain('processed_at IS NOT NULL')
    expect(query.mock.calls[0]![1]).toEqual(['7'])
    expect(query.mock.calls[1]![0]).toContain('processed_at IS NULL')
    expect(query.mock.calls[1]![0]).toContain('received_at')
    expect(query.mock.calls[1]![1]).toEqual(['30'])
    expect(query.mock.calls[2]![0]).toContain('media_blobs')
    expect(query.mock.calls[2]![0]).toContain('created_at')
    expect(query.mock.calls[2]![1]).toEqual(['30'])
  })

  it('skips retention rules disabled with zero days', async () => {
    mockEnv.EVENT_RETENTION_DAYS = 0
    mockEnv.MEDIA_RETENTION_DAYS = 0
    query.mockResolvedValue({ rowCount: 1 })
    const { runRetentionSweep } = await import('../src/db/retention.js')

    await runRetentionSweep()

    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]![0]).toContain('processed_at IS NULL')
  })

  it('logs database failures instead of throwing', async () => {
    query.mockRejectedValue(new Error('db down'))
    const { runRetentionSweep } = await import('../src/db/retention.js')

    const result = await runRetentionSweep()

    expect(result).toEqual({ processedEventsDeleted: 0, unprocessedEventsDeleted: 0, mediaBlobsDeleted: 0 })
  })
})
