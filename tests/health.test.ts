import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const poolQuery = vi.fn()

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
vi.mock('../src/db/pool.js', () => ({ pool: { query: (...args: unknown[]) => poolQuery(...args) } }))
vi.mock('../src/db/repositories.js', () => ({ updateConnectionSettings: vi.fn() }))
vi.mock('../src/sessions/session-manager.js', () => ({ sessionManager: {} }))
vi.mock('../src/media/signed-urls.js', () => ({
  signedMediaUrl: vi.fn(() => 'http://media.test'),
  verifyMediaSignature: vi.fn(() => true)
}))

describe('health endpoint', () => {
  afterEach(() => {
    vi.resetAllMocks()
    vi.useRealTimers()
  })

  async function buildApp() {
    const app = Fastify()
    const { registerRoutes } = await import('../src/api/routes.js')
    await registerRoutes(app)
    return app
  }

  it('returns ok without authentication when the database responds', async () => {
    poolQuery.mockResolvedValue({ rows: [{ ok: 1 }] })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', worker_id: 'worker-a' })
    await app.close()
  })

  it('returns 503 when the database query fails', async () => {
    poolQuery.mockRejectedValue(new Error('connection refused'))
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'unhealthy', database: 'unreachable', worker_id: 'worker-a' })
    await app.close()
  })

  it('returns 503 when the database probe hangs past the timeout', async () => {
    vi.useFakeTimers()
    poolQuery.mockReturnValue(new Promise(() => {}))
    const app = await buildApp()
    const pending = app.inject({ method: 'GET', url: '/health' })
    await vi.advanceTimersByTimeAsync(2_001)
    const res = await pending
    expect(res.statusCode).toBe(503)
    expect(res.json().status).toBe('unhealthy')
    await app.close()
  })
})
