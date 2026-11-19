import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renewClaim = vi.fn()
const makeWASocket = vi.fn()
const updateConnectionStatusAndEvent = vi.fn()
const updateConnectionStatus = vi.fn()
const updateConnectionPhone = vi.fn()
const createPostgresAuthState = vi.fn()
const clearAuth = vi.fn()
const ensureConnectionBrowser = vi.fn()
const infoLog = vi.fn()
const eventSinkPublish = vi.fn()
const outboxAppend = vi.fn((_event: unknown): boolean => true)
const outboxDelete = vi.fn()
const enqueueBackground = vi.fn()

vi.mock('@whiskeysockets/baileys', () => ({
  Browsers: { ubuntu: vi.fn(() => ['Ubuntu', 'Echo Guard', '22.04.4']) },
  DisconnectReason: { loggedOut: 401, timedOut: 428 },
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  makeWASocket,
  downloadContentFromMessage: vi.fn(),
  BufferJSON: {},
  initAuthCreds: vi.fn()
}))

const mockEnv: Record<string, unknown> = {
  EVENT_SINK: 'db',
  CLAIM_RENEW_TIMEOUT_MS: 5000,
  DOWNLOAD_MEDIA: false,
  BAILEYS_BROWSER_NAME: '',
  RECONNECT_BASE_DELAY_MS: 2000,
  RECONNECT_MAX_DELAY_MS: 60000,
  QR_TTL_MS: 120000,
  PUBLISH_ATTEMPT_TIMEOUT_MS: 50,
  PAIRING_QR_RECOVERY_MS: 240000,
  MAX_MEDIA_BYTES: 1024,
  MEDIA_BASE_URL: 'http://localhost:8080',
  MEDIA_SIGNING_SECRET: 'test',
  MEDIA_URL_TTL_SECONDS: 300
}

vi.mock('../src/config/env.js', () => ({ env: mockEnv }))

vi.mock('../src/config/process-identity.js', () => ({ INSTANCE_ID: 'instance-a' }))
vi.mock('../src/observability/logger.js', () => ({
  logger: { child: vi.fn(() => ({})), warn: vi.fn(), error: vi.fn(), info: infoLog, debug: vi.fn() }
}))
vi.mock('../src/auth/postgres-auth-state.js', () => ({ createPostgresAuthState }))
vi.mock('../src/baileys/version-provider.js', () => ({ resolveWaVersion: vi.fn(async () => [2, 3000, 1]) }))
vi.mock('../src/events/sink.js', () => ({ eventSink: { publish: eventSinkPublish } }))
vi.mock('../src/events/outbox.js', () => ({
  getOutbox: () => ({ append: outboxAppend, delete: outboxDelete })
}))
vi.mock('../src/events/background-queue.js', () => ({ enqueueBackground }))
vi.mock('../src/media/signed-urls.js', () => ({ signedMediaUrl: vi.fn(() => 'http://media.test') }))
vi.mock('../src/db/repositories.js', () => ({
  getGroupSubject: vi.fn(async () => undefined),
  getMediaBlob: vi.fn(async () => null),
  ensureConnectionBrowser,
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

function textMessage(id = 'msg-1') {
  return {
    key: { id, remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
    message: { conversation: 'hello' },
    messageTimestamp: 1700000000
  } as any
}

describe('Session claim lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    mockEnv.BAILEYS_BROWSER_NAME = ''
    ensureConnectionBrowser.mockResolvedValue(['Windows', 'Chrome', '10.0.22631'])
    updateConnectionStatusAndEvent.mockResolvedValue({})
    updateConnectionStatus.mockResolvedValue(undefined)
    renewClaim.mockResolvedValue(true)
    clearAuth.mockResolvedValue(undefined)
    createPostgresAuthState.mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds: vi.fn(), clear: clearAuth })
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
    await vi.advanceTimersByTimeAsync(1_999)
    expect(makeWASocket).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(makeWASocket).toHaveBeenCalledTimes(2)

    await fixtures[1]!.handlers.get('connection.update')!({ connection: 'open' })
    await fixtures[1]!.handlers.get('connection.update')!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } }
    })
    await vi.advanceTimersByTimeAsync(2_000)

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

  it('clears persisted auth after confirmed logout before creating a new QR socket', async () => {
    const first = socketFixture()
    const second = socketFixture()
    makeWASocket.mockReturnValueOnce(first.socket).mockReturnValueOnce(second.socket)
    createPostgresAuthState
      .mockResolvedValueOnce({ state: { creds: { registered: true }, keys: {} }, clear: clearAuth, saveCreds: vi.fn() })
      .mockResolvedValueOnce({ state: { creds: { registered: false }, keys: {} }, clear: clearAuth, saveCreds: vi.fn() })
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())

    await session.start()
    await first.handlers.get('connection.update')!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } }
    })
    expect(clearAuth).toHaveBeenCalledOnce()
    expect(infoLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'reconnect.auth_cleared', connection_id: 'connection-id' }),
      expect.any(String)
    )
    await session.preparePairing()
    expect(makeWASocket).toHaveBeenCalledTimes(2)
    expect(makeWASocket.mock.calls[1]![0].auth.creds.registered).toBe(false)
    await second.handlers.get('connection.update')!({ qr: 'fresh-qr' })
    expect(session.latestQr).toBe('fresh-qr')
    await session.stop()
  })

  it('waits for persisted logout reset before preparing a socket on a fast click', async () => {
    const first = socketFixture()
    const second = socketFixture()
    makeWASocket.mockReturnValueOnce(first.socket).mockReturnValueOnce(second.socket)
    createPostgresAuthState
      .mockResolvedValueOnce({ state: { creds: { registered: true }, keys: {} }, clear: clearAuth, saveCreds: vi.fn() })
      .mockResolvedValueOnce({ state: { creds: { registered: false }, keys: {} }, clear: clearAuth, saveCreds: vi.fn() })
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())
    await session.start()
    let finishPublish!: (value: object) => void
    updateConnectionStatusAndEvent.mockImplementationOnce(() => new Promise(resolve => { finishPublish = resolve }))
    const closing = first.handlers.get('connection.update')!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } }
    })
    const preparing = session.preparePairing()
    await Promise.resolve()
    expect(makeWASocket).toHaveBeenCalledOnce()
    finishPublish({})
    await Promise.all([closing, preparing])
    expect(clearAuth).toHaveBeenCalledOnce()
    expect(makeWASocket).toHaveBeenCalledTimes(2)
    expect(makeWASocket.mock.calls[1]![0].auth.creds.registered).toBe(false)
    await session.stop()
  })

  it('resets persisted logged-out credentials before opening a QR socket after restart', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    createPostgresAuthState
      .mockResolvedValueOnce({ state: { creds: { registered: true }, keys: {} }, clear: clearAuth, saveCreds: vi.fn() })
      .mockResolvedValueOnce({ state: { creds: { registered: false }, keys: {} }, clear: clearAuth, saveCreds: vi.fn() })
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())

    await session.start(true)
    expect(clearAuth).toHaveBeenCalledOnce()
    expect(makeWASocket.mock.calls[0]![0].auth.creds.registered).toBe(false)
    await fixture.handlers.get('connection.update')!({ qr: 'fresh-restart-qr' })
    expect(session.latestQr).toBe('fresh-restart-qr')
    await session.stop()
  })

  it('does not clear auth for a transient disconnect', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())
    await session.start()
    await fixture.handlers.get('connection.update')!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } }
    })
    expect(clearAuth).not.toHaveBeenCalled()
    await session.stop()
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

    await first.handlers.get('connection.update')!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } }
    })
    await Promise.all([session.preparePairing(), session.preparePairing()])
    expect(makeWASocket).toHaveBeenCalledTimes(2)
  })

  it('does not restart a live pairing socket while QR is preparing', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const onLostClaim = vi.fn()
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', onLostClaim)

    await session.start()
    await Promise.all([session.preparePairing(), session.preparePairing()])
    expect(makeWASocket).toHaveBeenCalledOnce()
    expect(fixture.socket.end).not.toHaveBeenCalled()
  })

  it('restarts a stalled pairing socket only after a bounded wait without a fresh QR', async () => {
    const first = socketFixture()
    const second = socketFixture()
    makeWASocket.mockReturnValueOnce(first.socket).mockReturnValueOnce(second.socket)
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())

    await session.start()
    await first.handlers.get('connection.update')!({ qr: 'expired-qr' })
    await vi.advanceTimersByTimeAsync(120_001)
    expect(session.latestQr).toBeUndefined()
    await session.preparePairing()
    expect(makeWASocket).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(119_999)
    await Promise.all([session.preparePairing(), session.preparePairing()])
    expect(makeWASocket).toHaveBeenCalledTimes(2)
    expect(first.socket.end).toHaveBeenCalledOnce()
    await second.handlers.get('connection.update')!({ qr: 'replacement-qr' })
    expect(session.latestQr).toBe('replacement-qr')
    await session.stop()
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
    const expectedDelays = [2_500, 5_000, 10_000, 20_000, 40_000, 60_000]
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

  it('goes dormant as pairing_required when a never-paired connection exhausts its QR refs', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())

    await session.start()
    await fixture.handlers.get('connection.update')!({ qr: 'stale-qr' })
    expect(session.latestQr).toBe('stale-qr')

    await fixture.handlers.get('connection.update')!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } }
    })

    expect(updateConnectionStatusAndEvent).toHaveBeenLastCalledWith(
      'connection-id',
      'claim-token',
      'pairing_required',
      'qr_expired',
      undefined
    )
    expect(session.runtimeState).toBe('stopped')
    expect(session.latestQr).toBeUndefined()
    expect(clearAuth).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(makeWASocket).toHaveBeenCalledOnce()
  })

  it('keeps reconnecting a paired connection on the same timeout code', async () => {
    const fixtures = [socketFixture(), socketFixture()]
    let fixtureIndex = 0
    makeWASocket.mockImplementation(() => fixtures[fixtureIndex++]!.socket)
    createPostgresAuthState.mockResolvedValue({
      state: { creds: { me: { id: '972500000000:2@s.whatsapp.net' }, registered: true }, keys: {} },
      saveCreds: vi.fn(),
      clear: clearAuth
    })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())

    await session.start()
    await fixtures[0]!.handlers.get('connection.update')!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } }
    })

    expect(updateConnectionStatusAndEvent).toHaveBeenLastCalledWith(
      'connection-id',
      'claim-token',
      'degraded',
      'disconnect:428',
      'disconnect:428'
    )
    await vi.advanceTimersByTimeAsync(1_999)
    expect(makeWASocket).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(makeWASocket).toHaveBeenCalledTimes(2)
    expect(clearAuth).not.toHaveBeenCalled()
  })

  it('revives a qr_expired connection on demand without clearing auth', async () => {
    const first = socketFixture()
    const second = socketFixture()
    makeWASocket.mockReturnValueOnce(first.socket).mockReturnValueOnce(second.socket)
    createPostgresAuthState
      .mockResolvedValueOnce({ state: { creds: { registered: false }, keys: {} }, clear: clearAuth, saveCreds: vi.fn() })
      .mockResolvedValueOnce({ state: { creds: { registered: false }, keys: {} }, clear: clearAuth, saveCreds: vi.fn() })
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())

    await session.start()
    await first.handlers.get('connection.update')!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } }
    })
    expect(clearAuth).not.toHaveBeenCalled()

    await session.preparePairing()
    expect(makeWASocket).toHaveBeenCalledTimes(2)
    await second.handlers.get('connection.update')!({ qr: 'fresh-qr' })
    expect(session.latestQr).toBe('fresh-qr')
    await session.stop()
  })

  it('spreads reconnect retries below the base delay on low jitter draws', async () => {
    const fixtures = [socketFixture(), socketFixture()]
    let fixtureIndex = 0
    makeWASocket.mockImplementation(() => fixtures[fixtureIndex++]!.socket)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const onLostClaim = vi.fn()
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', onLostClaim)

    await session.start()
    await fixtures[0]!.handlers.get('connection.update')!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } }
    })

    expect(makeWASocket).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_499)
    expect(makeWASocket).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(makeWASocket).toHaveBeenCalledTimes(2)
  })

  it('appends to the outbox, publishes and deletes on success', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    eventSinkPublish.mockResolvedValueOnce(undefined)
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())

    await session.start()
    await fixture.handlers.get('messages.upsert')!({ messages: [textMessage()], type: 'notify' })

    expect(outboxAppend).toHaveBeenCalledOnce()
    expect(eventSinkPublish).toHaveBeenCalledOnce()
    const appended = outboxAppend.mock.calls[0]![0] as { event_id: string }
    expect(appended.event_id).toEqual(expect.any(String))
    expect(outboxDelete).toHaveBeenCalledWith('connection-id', appended.event_id)
    await session.stop()
  })

  it('leaves a failed publish in the outbox for replay', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    eventSinkPublish.mockRejectedValue(new Error('db down'))
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())

    await session.start()
    await fixture.handlers.get('messages.upsert')!({ messages: [textMessage()], type: 'notify' })

    expect(outboxAppend).toHaveBeenCalledOnce()
    expect(outboxDelete).not.toHaveBeenCalled()
    await session.stop()
  })

  it('loses the claim but keeps the event in the outbox', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const { LostClaimError } = await import('../src/db/repositories.js')
    eventSinkPublish.mockRejectedValue(new LostClaimError('connection-id'))
    const onLostClaim = vi.fn()
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', onLostClaim)

    await session.start()
    await fixture.handlers.get('messages.upsert')!({ messages: [textMessage()], type: 'notify' })

    expect(onLostClaim).toHaveBeenCalledWith('claim_lost', expect.any(LostClaimError))
    expect(outboxDelete).not.toHaveBeenCalled()
  })

  it('contains an outbox append failure: the event still publishes (RC-9)', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    outboxAppend.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    outboxDelete.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    eventSinkPublish.mockResolvedValueOnce(undefined)
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())

    await session.start()
    // Must not throw out of the handler — an outbox failure can never
    // crash the ingestion path.
    await expect(
      fixture.handlers.get('messages.upsert')!({ messages: [textMessage()], type: 'notify' })
    ).resolves.toBeUndefined()

    expect(eventSinkPublish).toHaveBeenCalledOnce()
    await session.stop()
  })

  it('times out a hanging publish and leaves the event in the outbox', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    eventSinkPublish.mockImplementation(() => new Promise(() => {}))
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())

    await session.start()
    const processing = fixture.handlers.get('messages.upsert')!({ messages: [textMessage()], type: 'notify' })
    await vi.advanceTimersByTimeAsync(51)
    await processing

    expect(outboxAppend).toHaveBeenCalledOnce()
    expect(outboxDelete).not.toHaveBeenCalled()
    await session.stop()
  })

  it('opens sockets with the persisted browser fingerprint', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    ensureConnectionBrowser.mockResolvedValue(['Mac OS', 'Safari', '14.4.1'])
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())

    await session.start()

    expect(ensureConnectionBrowser).toHaveBeenCalledWith('connection-id', 'claim-token')
    expect(makeWASocket.mock.calls[0]![0].browser).toEqual(['Mac OS', 'Safari', '14.4.1'])
    await session.stop()
  })

  it('uses the fixed browser name from the environment when set', async () => {
    mockEnv.BAILEYS_BROWSER_NAME = 'Echo Guard'
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())

    await session.start()

    expect(ensureConnectionBrowser).not.toHaveBeenCalled()
    expect(makeWASocket.mock.calls[0]![0].browser).toEqual(['Ubuntu', 'Echo Guard', '22.04.4'])
    await session.stop()
  })
})
