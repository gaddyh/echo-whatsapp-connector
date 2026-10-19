import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renewClaim = vi.fn()
const makeWASocket = vi.fn()
const updateConnectionStatusAndEvent = vi.fn()
const updateConnectionStatus = vi.fn()
const updateConnectionPhone = vi.fn()
const createPostgresAuthState = vi.fn()

vi.mock('@whiskeysockets/baileys', () => ({
  Browsers: { ubuntu: vi.fn(() => ['Ubuntu', 'Echo Guard', '22.04.4']) },
  DisconnectReason: { loggedOut: 401 },
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  makeWASocket,
  downloadContentFromMessage: vi.fn(),
  BufferJSON: {},
  initAuthCreds: vi.fn()
}))

vi.mock('../src/config/env.js', () => ({
  env: {
    EVENT_SINK: 'db',
    CLAIM_RENEW_TIMEOUT_MS: 5000,
    DOWNLOAD_MEDIA: false,
    BAILEYS_BROWSER_NAME: 'Echo Guard',
    RECONNECT_BASE_DELAY_MS: 2000,
    RECONNECT_MAX_DELAY_MS: 60000,
    MAX_MEDIA_BYTES: 1024,
    MEDIA_BASE_URL: 'http://localhost:8080',
    MEDIA_SIGNING_SECRET: 'test',
    MEDIA_URL_TTL_SECONDS: 300
  }
}))

vi.mock('../src/config/process-identity.js', () => ({ INSTANCE_ID: 'instance-a' }))
vi.mock('../src/observability/logger.js', () => ({
  logger: { child: vi.fn(() => ({})), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
}))
vi.mock('../src/auth/postgres-auth-state.js', () => ({ createPostgresAuthState }))
vi.mock('../src/baileys/version-provider.js', () => ({ resolveWaVersion: vi.fn(async () => [2, 3000, 1]) }))
vi.mock('../src/events/sink.js', () => ({ eventSink: { publish: vi.fn() } }))
vi.mock('../src/media/signed-urls.js', () => ({ signedMediaUrl: vi.fn(() => 'http://media.test') }))
vi.mock('../src/db/repositories.js', () => ({
  getGroupSubject: vi.fn(async () => undefined),
  getMediaBlob: vi.fn(async () => null),
  isRetryableDatabaseError: vi.fn((err: unknown) => (err as { code?: string })?.code === 'ECONNRESET'),
  LostClaimError: class LostClaimError extends Error {},
  saveMediaBlob: vi.fn(),
  renewClaim,
  updateConnectionStatus,
  updateConnectionStatusAndEvent,
  updateConnectionPhone,
  upsertGroup: vi.fn(),
  upsertIdentity: vi.fn()
}))

function socketFixture() {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const socket = {
    user: { id: '972546610653:0@s.whatsapp.net' },
    ev: { on: vi.fn((name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler)) },
    end: vi.fn()
  }
  return { socket, handlers }
}

describe('Session claim lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    updateConnectionStatusAndEvent.mockResolvedValue({})
    updateConnectionStatus.mockResolvedValue(undefined)
    updateConnectionPhone.mockResolvedValue(undefined)
    createPostgresAuthState.mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds: vi.fn(), clear: vi.fn() })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes the socket and reports unverified ownership after a renewal transport error', async () => {
    const failure = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    renewClaim.mockRejectedValue(failure)
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const onLostClaim = vi.fn()
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', onLostClaim)

    await session.start()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(renewClaim).toHaveBeenCalledWith('connection-id', 'instance-a', 'claim-token', 5000)
    expect(fixture.socket.end).toHaveBeenCalledOnce()
    expect(onLostClaim).toHaveBeenCalledWith('claim_unverified', failure)
    expect(session.runtimeState).toBe('claim_unverified')
  })

  it('persists and exposes the authenticated account phone on open', async () => {
    renewClaim.mockResolvedValue(true)
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const onLostClaim = vi.fn()
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', onLostClaim)

    await session.start()
    await fixture.handlers.get('connection.update')?.({ connection: 'open' })

    expect(updateConnectionPhone).toHaveBeenCalledWith(
      'connection-id',
      'claim-token',
      '972546610653'
    )
    expect(session.authenticatedPhoneNumber).toBe('972546610653')
  })

  it('closes the socket once when the fencing update returns false', async () => {
    renewClaim.mockResolvedValue(false)
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const onLostClaim = vi.fn()
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', onLostClaim)

    await session.start()
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(20_000)

    expect(fixture.socket.end).toHaveBeenCalledOnce()
    expect(onLostClaim).toHaveBeenCalledOnce()
    expect(onLostClaim.mock.calls[0]?.[0]).toBe('claim_lost')
  })
})
