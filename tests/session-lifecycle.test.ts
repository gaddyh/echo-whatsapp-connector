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
    QR_TTL_MS: 120000,
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
    renewClaim.mockResolvedValue(true)
    createPostgresAuthState.mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds: vi.fn(), clear: vi.fn() })
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  it('uses bounded jitter and resets reconnect attempts after a successful connection', async () => {
    const fixtures = [socketFixture(), socketFixture(), socketFixture()]
    let fixtureIndex = 0
    makeWASocket.mockImplementation(() => fixtures[fixtureIndex++]!.socket)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const onLostClaim = vi.fn()
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', onLostClaim)

    await session.start()
    await fixtures[0]!.handlers.get('connection.update')!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } }
    })

    expect(makeWASocket).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_749)
    expect(makeWASocket).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(makeWASocket).toHaveBeenCalledTimes(2)

    await fixtures[1]!.handlers.get('connection.update')!({ connection: 'open' })
    await fixtures[1]!.handlers.get('connection.update')!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } }
    })
    await vi.advanceTimersByTimeAsync(1_750)

    expect(makeWASocket).toHaveBeenCalledTimes(3)
  })

  it('does not reconnect after a logged-out disconnect clears a pending timer', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const onLostClaim = vi.fn()
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', onLostClaim)

    await session.start()
    const connectionUpdate = fixture.handlers.get('connection.update')!
    await connectionUpdate({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } }
    })
    await connectionUpdate({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } }
    })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(makeWASocket).toHaveBeenCalledOnce()
    expect(updateConnectionStatusAndEvent).toHaveBeenLastCalledWith(
      'connection-id',
      'claim-token',
      'pairing_required',
      'logged_out:401',
      'logged_out:401'
    )
  })

  it('expires stale QR data and prepares a fresh pairing socket on request', async () => {
    const first = socketFixture()
    const second = socketFixture()
    makeWASocket.mockReturnValueOnce(first.socket).mockReturnValueOnce(second.socket)
    const onLostClaim = vi.fn()
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', onLostClaim)

    await session.start()
    await first.handlers.get('connection.update')!({ qr: 'qr-1' })
    expect(session.latestQr).toBe('qr-1')
    await vi.advanceTimersByTimeAsync(120_001)
    expect(session.latestQr).toBeUndefined()

    await session.preparePairing()
    expect(makeWASocket).toHaveBeenCalledTimes(2)
  })

  it('keeps capped reconnect delays below the maximum', async () => {
    const fixtures = Array.from({ length: 7 }, () => socketFixture())
    const queue = [...fixtures]
    makeWASocket.mockImplementation(() => queue.shift()!.socket)
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const onLostClaim = vi.fn()
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', onLostClaim)

    await session.start()
    let currentIndex = 0
    let current = fixtures[currentIndex]!
    const expectedDelays = [1_500, 3_000, 6_000, 12_000, 24_000, 45_000]
    for (const delay of expectedDelays) {
      await current.handlers.get('connection.update')!({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 500 } } }
      })
      const callsBefore = makeWASocket.mock.calls.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(makeWASocket).toHaveBeenCalledTimes(callsBefore)
      await vi.advanceTimersByTimeAsync(1)
      expect(makeWASocket).toHaveBeenCalledTimes(callsBefore + 1)
      current = fixtures[++currentIndex]!
    }
  })
})
