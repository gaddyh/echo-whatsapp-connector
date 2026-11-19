import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogRingBuffer } from '../src/observability/log-ring.js'

const generateDigest = vi.fn()
const infoLog = vi.fn()
const errorLog = vi.fn()

const mockEnv: Record<string, unknown> = {
  LOG_MONITOR_DIGEST_MS: 100,
  OPENAI_API_KEY: 'test-key',
  OPENAI_MODEL: 'gpt-test',
  OPS_ALERT_ENDPOINT: '',
  OPS_ALERT_TOKEN: 'alert-token',
  WORKER_ID: 'worker-a'
}

vi.mock('../src/config/env.js', () => ({ env: mockEnv }))
vi.mock('../src/observability/logger.js', () => ({
  logger: { child: vi.fn(() => ({})), warn: vi.fn(), error: errorLog, info: infoLog, debug: vi.fn() },
  logRing: {}
}))
vi.mock('../src/sessions/session-manager.js', () => ({
  sessionManager: { runtimeSnapshot: vi.fn(() => ({ healthy: 7 })) }
}))
vi.mock('../src/monitor/llm-summarizer.js', () => ({ generateDigest }))

const fetchMock = vi.fn()

const T = 1_700_000_000_000

function digest(oneLiner: string, stillOpen: Array<Record<string, string>> = []) {
  return { attention: false, happened: [], resolved: [], still_open: stillOpen, one_liner: oneLiner }
}

describe('log monitor digest loop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    mockEnv.OPENAI_API_KEY = 'test-key'
    mockEnv.OPS_ALERT_ENDPOINT = ''
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    const { stopLogMonitor, resetMonitorStateForTests } = await import('../src/monitor/log-monitor.js')
    stopLogMonitor()
    resetMonitorStateForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function load() {
    const monitor = await import('../src/monitor/log-monitor.js')
    monitor.resetMonitorStateForTests()
    return monitor
  }

  it('builds the payload from the ring and carries the previous digest forward', async () => {
    const { runDigest, resetMonitorStateForTests } = await load()
    resetMonitorStateForTests()
    const ring = new LogRingBuffer(100)
    ring.push({ level: 30, time: T, msg: 'connection recovery scheduled', connection_id: 'c1' })
    ring.push({ level: 30, time: T, msg: 'event publish dropped after retries', connection_id: 'c1' })
    generateDigest.mockResolvedValueOnce(digest('first', [{ id: 'drop-c1', title: 'drops', severity: 'high' }]))

    await runDigest({ ring, runtimeSnapshot: () => ({ healthy: 7 }), now: () => T + 3_600_000 })

    const firstPayload = generateDigest.mock.calls[0]![0] as Record<string, any>
    expect(firstPayload.counters.recovery_scheduled).toBe(1)
    expect(firstPayload.counters.publish_dropped).toBe(1)
    expect(firstPayload.previous_digest).toBeNull()
    expect(firstPayload.live_snapshot).toEqual({
      sessions_by_state: { healthy: 7 },
      taken_at: firstPayload.window.to
    })
    // First digest covers since monitor start (epoch after test reset).
    expect(firstPayload.window.from).toBe(new Date(0).toISOString())
    expect(firstPayload.window.to).toBe(new Date(T + 3_600_000).toISOString())

    generateDigest.mockResolvedValueOnce(digest('second'))
    await runDigest({ ring, runtimeSnapshot: () => ({}), now: () => T + 7_200_000 })

    const secondPayload = generateDigest.mock.calls[1]![0] as Record<string, any>
    expect(secondPayload.previous_digest.one_liner).toBe('first')
    expect(secondPayload.previous_digest.still_open).toEqual([{ id: 'drop-c1', title: 'drops', severity: 'high' }])
    expect(secondPayload.window.from).toBe(new Date(T + 3_600_000).toISOString())
    expect(secondPayload.live_snapshot).toBeUndefined()
  })

  it('posts the digest to the alert endpoint when configured', async () => {
    mockEnv.OPS_ALERT_ENDPOINT = 'https://alerts.test/hook'
    const { runDigest, resetMonitorStateForTests } = await load()
    resetMonitorStateForTests()
    generateDigest.mockResolvedValueOnce(digest('quiet hour'))
    fetchMock.mockResolvedValueOnce({ ok: true })

    await runDigest({ ring: new LogRingBuffer(10), runtimeSnapshot: () => ({}), now: () => T })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://alerts.test/hook')
    expect(init.headers).toMatchObject({ authorization: 'Bearer alert-token' })
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ severity: 'info', title: 'quiet hour', source: 'connector', worker_id: 'worker-a' })
    expect(body.body).toContain('quiet hour')
    expect(body.window).toEqual({ from: new Date(0).toISOString(), to: new Date(T).toISOString() })
    expect(body.metrics.counters).toBeDefined()
    expect(body.metrics.peak_recovery_per_min).toBeDefined()
  })

  it('keeps the digest flowing when endpoint delivery fails', async () => {
    mockEnv.OPS_ALERT_ENDPOINT = 'https://alerts.test/hook'
    const { runDigest, resetMonitorStateForTests } = await load()
    resetMonitorStateForTests()
    generateDigest.mockResolvedValueOnce(digest('quiet hour'))
    fetchMock.mockRejectedValueOnce(new Error('connection refused'))

    const result = await runDigest({ ring: new LogRingBuffer(10), runtimeSnapshot: () => ({}), now: () => T })

    expect(result.one_liner).toBe('quiet hour')
  })

  it('refuses to start without an API key', async () => {
    mockEnv.OPENAI_API_KEY = ''
    const { startLogMonitor, stopLogMonitor } = await load()

    startLogMonitor()
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'log-monitor' }),
      'log monitor enabled without OPENAI_API_KEY; not starting'
    )
    stopLogMonitor()
  })

  it('runs the digest on the configured interval and stops cleanly', async () => {
    const { startLogMonitor, stopLogMonitor, resetMonitorStateForTests } = await load()
    resetMonitorStateForTests()
    const ring = new LogRingBuffer(100)
    generateDigest.mockResolvedValue(digest('ticked'))

    startLogMonitor(ring)
    expect(infoLog).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'log-monitor', digest_interval_ms: 100 }),
      'log monitor started'
    )

    await vi.advanceTimersByTimeAsync(100)
    expect(generateDigest).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(100)
    expect(generateDigest).toHaveBeenCalledTimes(2)

    stopLogMonitor()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(generateDigest).toHaveBeenCalledTimes(2)
  })
})
