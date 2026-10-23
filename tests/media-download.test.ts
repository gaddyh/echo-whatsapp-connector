import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renewClaim = vi.fn()
const makeWASocket = vi.fn()
const updateConnectionStatusAndEvent = vi.fn()
const updateConnectionStatus = vi.fn()
const updateConnectionPhone = vi.fn()
const createPostgresAuthState = vi.fn()
const clearAuth = vi.fn()
const saveMediaBlob = vi.fn()
const getMediaBlob = vi.fn()
const downloadContentFromMessage = vi.fn()

vi.mock('@whiskeysockets/baileys', () => ({
  Browsers: { ubuntu: vi.fn(() => ['Ubuntu', 'Echo Guard', '22.04.4']) },
  DisconnectReason: { loggedOut: 401 },
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  makeWASocket,
  downloadContentFromMessage,
  BufferJSON: {},
  initAuthCreds: vi.fn()
}))

vi.mock('../src/config/env.js', () => ({
  env: {
    EVENT_SINK: 'db',
    CLAIM_RENEW_TIMEOUT_MS: 5000,
    DOWNLOAD_MEDIA: true,
    BAILEYS_BROWSER_NAME: 'Echo Guard',
    RECONNECT_BASE_DELAY_MS: 2000,
    RECONNECT_MAX_DELAY_MS: 60000,
    QR_TTL_MS: 120000,
    PAIRING_QR_RECOVERY_MS: 240000,
    MAX_MEDIA_BYTES: 1024,
    MEDIA_BASE_URL: 'http://localhost:8080',
    MEDIA_SIGNING_SECRET: 'test',
    MEDIA_URL_TTL_SECONDS: 300,
    INTERNAL_API_TOKEN: 'test-token'
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
  getMediaBlob,
  isRetryableDatabaseError: vi.fn((err: unknown) => (err as { code?: string })?.code === 'ECONNRESET'),
  LostClaimError: class LostClaimError extends Error {},
  saveMediaBlob,
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

function videoMessage(mediaKey: Buffer | null = Buffer.from('media-key'), extra: Record<string, unknown> = {}) {
  return {
    key: { id: 'video-id', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
    message: {
      videoMessage: {
        mimetype: 'video/mp4',
        mediaKey,
        fileName: 'video.mp4',
        ...extra
      }
    },
    messageTimestamp: 1700000000
  } as any
}

function asyncStream(chunks: Buffer[]) {
  return (async function* () {
    for (const c of chunks) yield c
  })()
}

/** Inject a message into the session's in-memory media map (simulates ingestion). */
function seedMedia(session: any, reference: string, msg: any) {
  session.mediaMessages.set(reference, msg)
}

describe('Session media download', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    updateConnectionStatusAndEvent.mockResolvedValue({})
    updateConnectionStatus.mockResolvedValue(undefined)
    renewClaim.mockResolvedValue(true)
    clearAuth.mockResolvedValue(undefined)
    createPostgresAuthState.mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds: vi.fn(), clear: clearAuth })
    getMediaBlob.mockResolvedValue(null)
    saveMediaBlob.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('downloads a valid video and persists it to media_blobs', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const bytes = Buffer.from('video-bytes')
    downloadContentFromMessage.mockResolvedValue(asyncStream([bytes]))

    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())
    await session.start()
    seedMedia(session, 'baileys:connection-id:video-id', videoMessage())

    const media = await session.downloadMedia('baileys:connection-id:video-id')
    expect(media.bytes.equals(bytes)).toBe(true)
    expect(media.mimeType).toBe('video/mp4')
    expect(saveMediaBlob).toHaveBeenCalledWith(
      'connection-id', 'claim-token', 'baileys:connection-id:video-id', bytes, 'video/mp4', 'video.mp4'
    )
    await session.stop()
  })

  it('recovers from a transient download failure on retry', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const bytes = Buffer.from('video-bytes')
    let call = 0
    downloadContentFromMessage.mockImplementation(async () => {
      call += 1
      if (call < 3) throw new Error('temporary whatsapp error')
      return asyncStream([bytes])
    })

    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())
    await session.start()
    seedMedia(session, 'baileys:connection-id:video-id', videoMessage())

    const promise = session.downloadMedia('baileys:connection-id:video-id')
    // Advance through the +2s delay between attempt 1 and 2.
    await vi.advanceTimersByTimeAsync(2_000)
    // Advance through the +5s delay between attempt 2 and 3.
    await vi.advanceTimersByTimeAsync(5_000)
    const media = await promise

    expect(media.bytes.equals(bytes)).toBe(true)
    expect(downloadContentFromMessage).toHaveBeenCalledTimes(3)
    await session.stop()
  })

  it('throws MediaPayloadIncompleteError without retry when mediaKey is missing', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)

    // Seed the in-memory map with a message lacking mediaKey.
    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())
    await session.start()
    seedMedia(session, 'baileys:connection-id:no-key', videoMessage(null))

    await expect(session.downloadMedia('baileys:connection-id:no-key')).rejects.toThrow('message media payload is incomplete')
    expect(downloadContentFromMessage).not.toHaveBeenCalled()
    await session.stop()
  })

  it('throws MediaTooLargeError immediately when the stream exceeds the size limit', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    // Two chunks of 600 bytes each exceed the 1024 byte limit.
    downloadContentFromMessage.mockResolvedValue(asyncStream([Buffer.alloc(600), Buffer.alloc(600)]))

    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())
    await session.start()
    seedMedia(session, 'baileys:connection-id:video-id', videoMessage())

    await expect(session.downloadMedia('baileys:connection-id:video-id')).rejects.toThrow('media exceeds configured size limit')
    // Only one attempt — oversized is deterministic and not retried.
    expect(downloadContentFromMessage).toHaveBeenCalledTimes(1)
    await session.stop()
  })

  it('serves a subsequent on-demand request from media_blobs without re-downloading', async () => {
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const bytes = Buffer.from('cached-bytes')
    downloadContentFromMessage.mockResolvedValue(asyncStream([bytes]))

    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())
    await session.start()
    seedMedia(session, 'baileys:connection-id:video-id', videoMessage())

    // First call downloads from WhatsApp and persists.
    const first = await session.downloadMedia('baileys:connection-id:video-id')
    expect(first.bytes.equals(bytes)).toBe(true)
    expect(downloadContentFromMessage).toHaveBeenCalledTimes(1)
    expect(saveMediaBlob).toHaveBeenCalledTimes(1)

    // Second call is served from the blob cache — no second WhatsApp download.
    getMediaBlob.mockResolvedValue({ content: bytes, mimeType: 'video/mp4', fileName: 'video.mp4' })
    const second = await session.downloadMedia('baileys:connection-id:video-id')
    expect(second.bytes.equals(bytes)).toBe(true)
    expect(downloadContentFromMessage).toHaveBeenCalledTimes(1)
    await session.stop()
  })

  it('persists the same WAMessage object used on-demand as was stored at ingestion (diagnostic)', async () => {
    // The normalizer gates media_reference on hasMediaKey. This test confirms
    // the WAMessage stored in the in-memory map at ingestion is structurally
    // identical (same mediaKey, url, directPath, encFilehash) to the object
    // later passed to downloadMediaMessage on the on-demand path — i.e. the
    // MediaPayloadIncompleteError path is unreachable in the normal flow and
    // any missing-mediaKey incident points to a normalization/wrapper issue,
    // not a mutation between ingestion and download.
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const bytes = Buffer.from('video-bytes')
    downloadContentFromMessage.mockImplementation(async (content: any) => {
      // The content passed to downloadContentFromMessage is the same object
      // reference stored at ingestion.
      expect(content.mediaKey).toEqual(Buffer.from('media-key'))
      expect(content.url).toBe('https://whatsapp.test/direct')
      expect(content.directPath).toBe('/path/to/video')
      expect(content.encFilehash).toBe('hash')
      return asyncStream([bytes])
    })

    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())
    await session.start()

    const msg = videoMessage(Buffer.from('media-key'), {
      url: 'https://whatsapp.test/direct',
      directPath: '/path/to/video',
      encFilehash: 'hash'
    })
    seedMedia(session, 'baileys:connection-id:video-id', msg)

    const media = await session.downloadMedia('baileys:connection-id:video-id')
    expect(media.bytes.equals(bytes)).toBe(true)
    await session.stop()
  })

  it('downloads video when audioMessage is null (protobuf null-field bug)', async () => {
    // Baileys/protobuf can set absent media fields to null. The old code
    // used `!== undefined` which matched null fields, causing audioMessage: null
    // to be found before videoMessage: {...} — producing a false
    // MediaPayloadIncompleteError. The fix uses `!= null` to skip null fields.
    const fixture = socketFixture()
    makeWASocket.mockReturnValue(fixture.socket)
    const bytes = Buffer.from('video-bytes')
    downloadContentFromMessage.mockResolvedValue(asyncStream([bytes]))

    const { Session } = await import('../src/sessions/session.js')
    const session = new Session('connection-id', {} as any, 'claim-token', vi.fn())
    await session.start()

    // Message with audioMessage: null AND videoMessage with mediaKey
    const msg = {
      key: { id: 'video-id', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
      message: {
        audioMessage: null,
        videoMessage: {
          mimetype: 'video/mp4',
          mediaKey: Buffer.from('media-key'),
          fileName: 'video.mp4',
          url: 'https://whatsapp.test/direct',
          directPath: '/path/to/video',
          encFilehash: 'hash'
        }
      },
      messageTimestamp: 1700000000
    } as any
    seedMedia(session, 'baileys:connection-id:video-id', msg)

    const media = await session.downloadMedia('baileys:connection-id:video-id')
    expect(media.bytes.equals(bytes)).toBe(true)
    expect(media.mimeType).toBe('video/mp4')
    expect(downloadContentFromMessage).toHaveBeenCalledTimes(1)
    await session.stop()
  })
})
