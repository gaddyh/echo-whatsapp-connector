import { beforeEach, describe, expect, it, vi } from 'vitest'

const getConnection = vi.fn()
const listConnections = vi.fn()

vi.mock('../src/config/env.js', () => ({
  env: {
    LOG_LEVEL: 'silent',
    WORKER_ID: 'worker-a',
    MAX_SESSIONS: 2,
    SESSION_START_STAGGER_MS: 0,
    RECOVERY_BACKOFF_INITIAL_MS: 1000,
    RECOVERY_BACKOFF_MAX_MS: 30000
  }
}))
vi.mock('../src/config/process-identity.js', () => ({ INSTANCE_ID: 'instance-a' }))
vi.mock('../src/db/pool.js', () => ({ pool: {} }))
vi.mock('../src/db/repositories.js', () => ({
  assignWorker: vi.fn(),
  claimConnection: vi.fn(),
  createConnection: vi.fn(),
  deleteConnectionRow: vi.fn(),
  getConnection,
  isRetryableDatabaseError: vi.fn((err: unknown) => (err as { code?: string })?.code === 'ECONNRESET'),
  listConnections,
  releaseClaim: vi.fn()
}))
vi.mock('../src/sessions/session.js', () => ({ Session: class Session {} }))

const row = {
  id: 'connection-id',
  status: 'connected',
  raw_status: 'open',
  phone_number: null,
  account_phone_number: '+972546610653',
  worker_id: 'worker-a',
  claim_owner: 'instance-a',
  claim_token: 'token',
  claim_expires_at: new Date(Date.now() - 1000),
  settings: {}
}

describe('lease-aware status', () => {
  beforeEach(() => {
    getConnection.mockReset()
    listConnections.mockReset()
  })

  it('does not report connected when the persisted lease has expired', async () => {
    getConnection.mockResolvedValue(row)
    const { SessionManager } = await import('../src/sessions/session-manager.js')
    const manager = new SessionManager()

    await expect(manager.status('connection-id')).resolves.toMatchObject({
      status: 'degraded',
      persistent_status: 'connected',
      account_phone_number: '+972546610653',
      runtime_state: 'stopped',
      lease_valid: false,
      session_present: false,
      socket_present: false
    })
  })

  it('reports claim unverified instead of healthy when the DB status read fails', async () => {
    const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    getConnection.mockRejectedValue(error)
    const { SessionManager } = await import('../src/sessions/session-manager.js')
    const manager = new SessionManager()
    ;(manager as any).runtimeStates.set('connection-id', 'claim_unverified')

    await expect(manager.status('connection-id')).resolves.toMatchObject({
      status: 'degraded',
      persistent_status: null,
      runtime_state: 'claim_unverified',
      lease_valid: null
    })
  })
})
