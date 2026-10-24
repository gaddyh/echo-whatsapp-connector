import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const downloadMedia = vi.fn()

vi.mock('../src/config/env.js', () => ({
  env: {
    INTERNAL_API_TOKEN: 'test-token',
    WORKER_ID: 'worker-a',
    MEDIA_BASE_URL: 'http://localhost:8080',
    MEDIA_SIGNING_SECRET: 'test',
    MEDIA_URL_TTL_SECONDS: 300
  }
}))
vi.mock('../src/config/process-identity.js', () => ({ INSTANCE_ID: 'instance-a' }))
vi.mock('../src/db/pool.js', () => ({ pool: {} }))
vi.mock('../src/db/repositories.js', () => ({ updateConnectionSettings: vi.fn() }))
vi.mock('../src/sessions/session-manager.js', () => ({ sessionManager: { downloadMedia } }))

// signed-urls is mocked with controllable functions.
const signedMediaUrlMock = vi.fn(() => 'http://media.test')
const verifyMediaSignatureMock = vi.fn(() => true)
vi.mock('../src/media/signed-urls.js', () => ({
  signedMediaUrl: signedMediaUrlMock,
  verifyMediaSignature: verifyMediaSignatureMock
}))

describe('media route HTTP status codes', () => {
  afterEach(() => {
    vi.resetAllMocks()
    verifyMediaSignatureMock.mockReturnValue(true)
  })

  async function buildApp() {
    const app = Fastify()
    const { registerRoutes } = await import('../src/api/routes.js')
    await registerRoutes(app)
    return app
  }

  it('returns 200 with bytes for a successful download', async () => {
    downloadMedia.mockResolvedValue({ bytes: Buffer.from('ok'), mimeType: 'video/mp4', fileName: 'v.mp4' })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/media/c/r?expires=9999&signature=x' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('ok')
    await app.close()
  })

  it('returns 413 for oversized media', async () => {
    const { MediaTooLargeError } = await import('../src/media/errors.js')
    downloadMedia.mockRejectedValue(new MediaTooLargeError(1200, 1024, 50_000_000))
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/media/c/r?expires=9999&signature=x' })
    expect(res.statusCode).toBe(413)
    await app.close()
  })

  it('returns 404 for an unavailable media payload', async () => {
    const { MediaPayloadIncompleteError } = await import('../src/media/errors.js')
    downloadMedia.mockRejectedValue(new MediaPayloadIncompleteError())
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/media/c/r?expires=9999&signature=x' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns 503 for a transient download failure', async () => {
    const { MediaDownloadError } = await import('../src/media/errors.js')
    downloadMedia.mockRejectedValue(new MediaDownloadError('transient'))
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/media/c/r?expires=9999&signature=x' })
    expect(res.statusCode).toBe(503)
    await app.close()
  })

  it('returns 403 for an invalid signature', async () => {
    verifyMediaSignatureMock.mockReturnValue(false)
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/media/c/r?expires=9999&signature=x' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})
