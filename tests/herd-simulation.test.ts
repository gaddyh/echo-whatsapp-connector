import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Herd simulation at 100-connection scale.
 *
 * The whole stack below the Baileys boundary runs for real: SessionManager,
 * Session, reconnect backoff, recovery scheduling and the version-provider
 * cache. Only makeWASocket / fetchLatestWaWebVersion (the WhatsApp edge) and
 * the Postgres repositories are mocked, so no real client or account is
 * involved.
 *
 * Delays are scaled down (env is mutable per test) so a 100-connection ramp
 * finishes in seconds; the ratios that define herding are preserved.
 */

const makeWASocket = vi.fn()
const fetchLatestWaWebVersion = vi.fn()
const renewClaim = vi.fn()
const claimConnection = vi.fn()
const assignWorker = vi.fn()
const releaseClaim = vi.fn()
const getConnection = vi.fn()
const listConnections = vi.fn()
const createPostgresAuthState = vi.fn()

const sockets: {
  socket: { ev: { on: ReturnType<typeof vi.fn> }; end: ReturnType<typeof vi.fn> }
  handlers: Map<string, (...args: any[]) => unknown>
  openedAt: number
}[] = []

const mockEnv = {
  WORKER_ID: 'worker-a',
  MAX_SESSIONS: 150,
  SESSION_START_STAGGER_MS: 50,
  RECOVERY_BACKOFF_INITIAL_MS: 1000,
  RECOVERY_BACKOFF_MAX_MS: 30000,
  RECONNECT_BASE_DELAY_MS: 200,
  RECONNECT_MAX_DELAY_MS: 10000,
  EVENT_SINK: 'db',
  CLAIM_RENEW_TIMEOUT_MS: 5000,
  DOWNLOAD_MEDIA: false,
  BAILEYS_BROWSER_NAME: '',
  QR_TTL_MS: 120000,
  PAIRING_QR_RECOVERY_MS: 240000,
  MAX_MEDIA_BYTES: 1024,
  MEDIA_BASE_URL: 'http://localhost:8080',
  MEDIA_SIGNING_SECRET: 'test',
  MEDIA_URL_TTL_SECONDS: 300,
  WA_WEB_VERSION_OVERRIDE: ''
}

vi.mock('@whiskeysockets/baileys', () => ({
  Browsers: { ubuntu: vi.fn(() => ['Ubuntu', 'Echo Guard', '22.04.4']) },
  DisconnectReason: { loggedOut: 401 },
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  makeWASocket: (...args: unknown[]) => makeWASocket(...args),
  downloadContentFromMessage: vi.fn(),
  BufferJSON: {},
  initAuthCreds: vi.fn(),
  fetchLatestWaWebVersion: (...args: unknown[]) => fetchLatestWaWebVersion(...args)
}))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }))
vi.mock('../src/config/env.js', () => ({ env: mockEnv }))
vi.mock('../src/config/process-identity.js', () => ({ INSTANCE_ID: 'instance-a' }))
vi.mock('../src/db/pool.js', () => ({ pool: {} }))
vi.mock('../src/observability/logger.js', () => ({
  logger: { child: vi.fn(() => ({})), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
}))
vi.mock('../src/auth/postgres-auth-state.js', () => ({ createPostgresAuthState }))
vi.mock('../src/events/sink.js', () => ({ eventSink: { publish: vi.fn() } }))
vi.mock('../src/media/signed-urls.js', () => ({ signedMediaUrl: vi.fn(() => 'http://media.test') }))
vi.mock('../src/db/repositories.js', () => {
  class LostClaimError extends Error {
    constructor(readonly connectionId: string) {
      super(`lost connection claim: ${connectionId}`)
      this.name = 'LostClaimError'
    }
  }
  return {
    LostClaimError,
    assignWorker: (...args: unknown[]) => assignWorker(...args),
    claimConnection: (...args: unknown[]) => claimConnection(...args),
    createConnection: vi.fn(),
    deleteConnectionRow: vi.fn(),
    ensureConnectionBrowser: vi.fn(async () => ['Windows', 'Chrome', '10.0.22631']),
    findIdentityName: vi.fn(),
    getConnection: (...args: unknown[]) => getConnection(...args),
    getGroupSubject: vi.fn(async () => undefined),
    getMediaBlob: vi.fn(async () => null),
    isRetryableDatabaseError: vi.fn(() => false),
    listConnections: (...args: unknown[]) => listConnections(...args),
    releaseClaim: (...args: unknown[]) => releaseClaim(...args),
    renewClaim: (...args: unknown[]) => renewClaim(...args),
    saveMediaBlob: vi.fn(),
    updateConnectionPhone: vi.fn(),
    updateConnectionSettings: vi.fn(),
    updateConnectionStatus: vi.fn(),
    updateConnectionStatusAndEvent: vi.fn(),
    upsertGroup: vi.fn(),
    upsertIdentity: vi.fn()
  }
})

type SessionManager = Awaited<ReturnType<typeof load>>
let manager: SessionManager | undefined

async function load() {
  return (await import('../src/sessions/session-manager.js')).sessionManager
}

function seedConnections(count: number): void {
  listConnections.mockResolvedValue(
    Array.from({ length: count }, (_, i) => ({
      id: `conn-${i}`,
      worker_id: 'worker-a',
      status: 'connected',
      raw_status: null
    }))
  )
}

function installSocketFactory(): void {
  makeWASocket.mockImplementation(() => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const socket = {
      ev: { on: vi.fn((name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler)) },
      end: vi.fn()
    }
    sockets.push({ socket, handlers, openedAt: Date.now() })
    return socket
  })
}

/** Deterministic PRNG so the "random" herd is reproducible run to run. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor deadline exceeded')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('herd simulation at 100 connections', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    sockets.length = 0
    manager = undefined
    mockEnv.SESSION_START_STAGGER_MS = 50
    mockEnv.MAX_SESSIONS = 150
    installSocketFactory()
    fetchLatestWaWebVersion.mockResolvedValue({ version: [2, 3000, 12345], isLatest: true })
    claimConnection.mockImplementation(async (_id: string, _owner: string) => `token-${sockets.length}`)
    getConnection.mockResolvedValue({ id: 'conn-x', status: 'connected', worker_id: 'worker-a', raw_status: null })
    renewClaim.mockResolvedValue(true)
    assignWorker.mockResolvedValue(undefined)
    releaseClaim.mockResolvedValue(undefined)
    createPostgresAuthState.mockResolvedValue({
      state: { creds: {}, keys: {} },
      saveCreds: vi.fn(),
      clear: vi.fn()
    })
  })

  afterEach(async () => {
    await manager?.shutdown().catch(() => {})
    manager = undefined
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('L1: deterministic (fake timers)', () => {
    it('restarts 100 connections one per stagger bucket with a single version fetch', async () => {
      vi.useFakeTimers()
      seedConnections(100)
      manager = await load()

      await manager.restoreAssigned()

      expect(makeWASocket).not.toHaveBeenCalled()
      for (let opened = 1; opened <= 100; opened++) {
        await vi.advanceTimersByTimeAsync(opened === 1 ? 1 : 50)
        expect(makeWASocket).toHaveBeenCalledTimes(opened)
      }
      expect(fetchLatestWaWebVersion).toHaveBeenCalledTimes(1)
      expect(renewClaim).not.toHaveBeenCalled()
    })
  })

  describe('L2: statistical (real timers, seeded RNG)', () => {
    it('keeps the 100-connection restart ramp smooth and spreads a mass reconnect', async () => {
      mockEnv.SESSION_START_STAGGER_MS = 20
      vi.spyOn(Math, 'random').mockImplementation(mulberry32(1234))
      seedConnections(100)
      manager = await load()

      const rampStart = Date.now()
      await manager.restoreAssigned()
      await waitFor(() => makeWASocket.mock.calls.length === 100, 10_000)

      expect(fetchLatestWaWebVersion).toHaveBeenCalledTimes(1)

      const rampBuckets = new Map<number, number>()
      for (const entry of sockets.slice(0, 100)) {
        const bucket = Math.floor((entry.openedAt - rampStart) / 100)
        rampBuckets.set(bucket, (rampBuckets.get(bucket) ?? 0) + 1)
      }
      // Expected ~5 per bucket (1 per 20ms stagger); the ceiling tolerates
      // timer bunching when the runner executes files in parallel workers.
      // A reconnect storm would put dozens in one bucket.
      expect(Math.max(...rampBuckets.values())).toBeLessThanOrEqual(10)

      const massDisconnectAt = Date.now()
      for (const entry of sockets.slice(0, 100)) {
        await entry.handlers.get('connection.update')!({
          connection: 'close',
          lastDisconnect: { error: { output: { statusCode: 500 } } }
        })
      }
      await waitFor(() => makeWASocket.mock.calls.length === 200, 10_000)

      const retries = sockets.slice(100).map(entry => entry.openedAt - massDisconnectAt)
      expect(retries).toHaveLength(100)

      // Jitter band is [0.75, 1.25] x base = [150, 250] ms; real timers may
      // open late under the load of 100 concurrent retries, so the upper
      // bound carries scheduling slack. No retry may straggle beyond the wave.
      for (const elapsed of retries) {
        expect(elapsed).toBeGreaterThanOrEqual(149)
        expect(elapsed).toBeLessThanOrEqual(400)
      }

      // The old shrink-only jitter put every retry at or below the base.
      const aboveBase = retries.filter(elapsed => elapsed > 200).length
      expect(aboveBase).toBeGreaterThanOrEqual(30)
      expect(aboveBase).toBeLessThanOrEqual(70)

      const retryBuckets = new Map<number, number>()
      for (const elapsed of retries) {
        const bucket = Math.floor(elapsed / 10)
        retryBuckets.set(bucket, (retryBuckets.get(bucket) ?? 0) + 1)
      }
      console.log('herd stats', {
        min: Math.min(...retries),
        max: Math.max(...retries),
        aboveBase: retries.filter(elapsed => elapsed > 200).length,
        maxRetryBucket: Math.max(...retryBuckets.values()),
        maxRampBucket: Math.max(...rampBuckets.values())
      })
      expect(Math.max(...retryBuckets.values())).toBeLessThanOrEqual(25)
    }, 20_000)
  })
})
