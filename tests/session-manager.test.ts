import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const claimConnection = vi.fn()
const assignWorker = vi.fn()
const getConnection = vi.fn()
const listConnections = vi.fn()
const releaseClaim = vi.fn()

const fakeSessions: {
  connectionId: string
  capability: string
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  lostClaim: (reason: string, err?: unknown) => void
}[] = []

const mockEnv = {
  WORKER_ID: 'worker-a',
  MAX_SESSIONS: 10,
  SESSION_START_STAGGER_MS: 5000,
  RECOVERY_BACKOFF_INITIAL_MS: 1000,
  RECOVERY_BACKOFF_MAX_MS: 30000
}

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }))
vi.mock('../src/config/env.js', () => ({ env: mockEnv }))
vi.mock('../src/config/process-identity.js', () => ({ INSTANCE_ID: 'instance-a' }))
vi.mock('../src/db/pool.js', () => ({ pool: {} }))
vi.mock('../src/db/repositories.js', () => ({
  assignWorker,
  claimConnection,
  createConnection: vi.fn(),
  deleteConnectionRow: vi.fn(),
  getConnection,
  getMediaBlob: vi.fn(),
  isRetryableDatabaseError: vi.fn((err: unknown) => (err as { code?: string })?.code === 'ECONNRESET'),
  listConnections,
  releaseClaim
}))
vi.mock('../src/observability/logger.js', () => ({
  logger: { child: vi.fn(() => ({})), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
}))
vi.mock('../src/sessions/session.js', () => {
  class Session {
    start = vi.fn(async () => {})
    stop = vi.fn(async () => {})
    constructor(
      readonly connectionId: string,
      _db: unknown,
      readonly capability: string,
      readonly lostClaim: (reason: string, err?: unknown) => void
    ) {
      fakeSessions.push(this)
    }
  }
  return { Session }
})

async function load() {
  return (await import('../src/sessions/session-manager.js')).sessionManager
}

function startedConnectionIds(): string[] {
  return fakeSessions.map(session => session.connectionId)
}

describe('SessionManager herding controls', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.resetAllMocks()
    fakeSessions.length = 0
    mockEnv.WORKER_ID = 'worker-a'
    mockEnv.MAX_SESSIONS = 10
    mockEnv.SESSION_START_STAGGER_MS = 5000
    mockEnv.RECOVERY_BACKOFF_INITIAL_MS = 1000
    mockEnv.RECOVERY_BACKOFF_MAX_MS = 30000
    claimConnection.mockResolvedValue('token-1')
    getConnection.mockResolvedValue({ id: 'c1', status: 'connected', worker_id: 'worker-a', raw_status: null })
    assignWorker.mockResolvedValue(undefined)
    releaseClaim.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('restores only this worker’s eligible connections with staggered delays', async () => {
    listConnections.mockResolvedValue([
      { id: 'c1', worker_id: 'worker-a', status: 'connected' },
      { id: 'foreign', worker_id: 'worker-b', status: 'connected' },
      { id: 'c2', worker_id: 'worker-a', status: 'degraded' },
      { id: 'unpaired', worker_id: 'worker-a', status: 'pairing_required' },
      { id: 'c3', worker_id: 'worker-a', status: 'connected' }
    ])
    const sessionManager = await load()

    await sessionManager.restoreAssigned()

    expect(claimConnection).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(startedConnectionIds()).toEqual(['c1'])
    await vi.advanceTimersByTimeAsync(4_998)
    expect(startedConnectionIds()).toEqual(['c1'])
    await vi.advanceTimersByTimeAsync(1)
    expect(startedConnectionIds()).toEqual(['c1', 'c2'])
    await vi.advanceTimersByTimeAsync(4_999)
    expect(startedConnectionIds()).toEqual(['c1', 'c2'])
    await vi.advanceTimersByTimeAsync(1)
    expect(startedConnectionIds()).toEqual(['c1', 'c2', 'c3'])
    expect(claimConnection).toHaveBeenCalledTimes(3)
  })

  it('caps restored sessions at MAX_SESSIONS', async () => {
    mockEnv.MAX_SESSIONS = 2
    listConnections.mockResolvedValue([
      { id: 'c1', worker_id: 'worker-a', status: 'connected' },
      { id: 'c2', worker_id: 'worker-a', status: 'connected' },
      { id: 'c3', worker_id: 'worker-a', status: 'connected' }
    ])
    const sessionManager = await load()

    await sessionManager.restoreAssigned()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(startedConnectionIds()).toEqual(['c1', 'c2'])
    expect(claimConnection).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent starts into a single session', async () => {
    const sessionManager = await load()

    const [first, second] = await Promise.all([
      sessionManager.start('c1'),
      sessionManager.start('c1')
    ])

    expect(first).toBe(second)
    expect(claimConnection).toHaveBeenCalledTimes(1)
    expect(fakeSessions).toHaveLength(1)
  })

  it('retries recovery with exponential backoff after retryable claim failures', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    claimConnection
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce('token-2')
    listConnections.mockResolvedValue([{ id: 'c1', worker_id: 'worker-a', status: 'connected' }])
    const sessionManager = await load()

    await sessionManager.restoreAssigned()

    await vi.advanceTimersByTimeAsync(1)
    expect(claimConnection).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(998)
    expect(claimConnection).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(claimConnection).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(claimConnection).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(claimConnection).toHaveBeenCalledTimes(3)
    expect(startedConnectionIds()).toEqual(['c1'])
  })

  it('stops recovery after a non-retryable start failure', async () => {
    claimConnection.mockRejectedValue(new Error('connection not found'))
    listConnections.mockResolvedValue([{ id: 'c1', worker_id: 'worker-a', status: 'connected' }])
    const sessionManager = await load()

    await sessionManager.restoreAssigned()
    await vi.advanceTimersByTimeAsync(1)
    expect(claimConnection).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(claimConnection).toHaveBeenCalledTimes(1)
    expect(fakeSessions).toHaveLength(0)
  })

  it('rejects automatic recovery of pairing-required connections', async () => {
    getConnection.mockResolvedValue({ id: 'c1', status: 'pairing_required', worker_id: 'worker-a', raw_status: null })
    const sessionManager = await load()

    await expect(sessionManager.start('c1', true))
      .rejects.toThrow('connection is not eligible for automatic recovery')
    expect(claimConnection).not.toHaveBeenCalled()
  })

  it('schedules recovery and reclaims with the previous token after a lost claim', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    claimConnection.mockResolvedValueOnce('token-1').mockResolvedValue('token-2')
    const sessionManager = await load()

    await sessionManager.start('c1')
    expect(fakeSessions).toHaveLength(1)

    fakeSessions[0]!.lostClaim('claim_lost')

    await vi.advanceTimersByTimeAsync(999)
    expect(claimConnection).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(claimConnection).toHaveBeenCalledTimes(2)
    expect(claimConnection).toHaveBeenLastCalledWith('c1', 'instance-a', 'token-1')
    expect(fakeSessions).toHaveLength(2)
    expect(fakeSessions[1]!.capability).toBe('token-2')
  })

  it('enforces the worker session capacity', async () => {
    mockEnv.MAX_SESSIONS = 1
    const sessionManager = await load()

    await sessionManager.start('c1')
    await expect(sessionManager.start('c2')).rejects.toThrow('worker session capacity reached')
    expect(claimConnection).toHaveBeenCalledTimes(1)
  })
})
