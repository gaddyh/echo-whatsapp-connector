import { exec } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import pg from 'pg'

/**
 * L3: full-stack herd simulation against a real local PostgreSQL.
 *
 * Everything below the Baileys boundary runs for real — SessionManager,
 * Session, reconnect backoff, the version-provider cache, the pg pool, the
 * repositories and the Postgres auth state — with only makeWASocket /
 * fetchLatestWaWebVersion mocked. The database is a dedicated local test
 * database (docker compose `postgres` service); the shared/production
 * DATABASE_URL from .env is never read: vitest does not load .env and this
 * file overwrites process.env before importing any src module.
 *
 * Run with: npm run test:herd-pg
 * Requires Docker. A disposable postgres:17-alpine container is started on
 * localhost:5433 (port 5432 is left alone for whatever already owns it) and
 * removed when the run finishes. If Docker is unavailable the suite skips
 * instead of failing.
 */

const makeWASocket = vi.fn()
const fetchLatestWaWebVersion = vi.fn()

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

const PG_PORT = 5433
const CONTAINER_NAME = 'echo-herd-pg'
const PG_ADMIN_URL = `postgres://postgres:postgres@localhost:${PG_PORT}/postgres`
const TEST_DB = 'echo_herd_test'
const TEST_DB_URL = `postgres://postgres:postgres@localhost:${PG_PORT}/${TEST_DB}`

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Start a disposable postgres:17-alpine container on a dedicated port.
 * Port 5432 is deliberately avoided: a native Postgres or another project's
 * container may already own it locally.
 */
async function ensurePostgres(): Promise<boolean> {
  try {
    await promisify(exec)(`docker rm -f ${CONTAINER_NAME}`)
  } catch {
    // no leftover container from a previous run
  }
  try {
    await promisify(exec)(
      `docker run -d --name ${CONTAINER_NAME} -p ${PG_PORT}:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine`
    )
  } catch (err) {
    console.log('skipping L3 herd simulation: docker unavailable', err)
    return false
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const probe = new pg.Client({ connectionString: PG_ADMIN_URL })
      await probe.connect()
      await probe.end()
      return true
    } catch {
      await sleep(1_000)
    }
  }
  console.log('skipping L3 herd simulation: postgres container did not become ready')
  return false
}

const CONNECTION_COUNT = 100
const STAGGER_MS = 50
const RECONNECT_BASE_MS = 200

const sockets: {
  socket: { ev: { on: ReturnType<typeof vi.fn> }; end: ReturnType<typeof vi.fn> }
  handlers: Map<string, (...args: any[]) => unknown>
  openedAt: number
}[] = []

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

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor deadline exceeded')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

let pgReady = false
let pool: pg.Pool | undefined
let manager: { restoreAssigned(): Promise<void>; shutdown(): Promise<void> } | undefined
let minExpiryAfterRamp = new Date(0)

describe.skipIf(process.env.RUN_HERD_PG !== '1')('L3: herd simulation against real local PostgreSQL', () => {
  beforeAll(async () => {
    fetchLatestWaWebVersion.mockResolvedValue({ version: [2, 3000, 12345], isLatest: true })
    installSocketFactory()

    if (!await ensurePostgres()) return

    let admin: pg.Client | undefined
    try {
      admin = new pg.Client({ connectionString: PG_ADMIN_URL })
      await admin.connect()
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      await admin.query(`CREATE DATABASE ${TEST_DB}`)
      await admin.end()
      admin = undefined
    } finally {
      await admin?.end()
    }

    process.env.DATABASE_URL = TEST_DB_URL
    // NB: z.coerce.boolean() treats the string 'false' as true; only the
    // empty string coerces to false, so SSL stays off for the local server.
    process.env.DATABASE_SSL = ''
    process.env.DB_POOL_MAX = '10'
    process.env.AUTH_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')
    process.env.INTERNAL_API_TOKEN = 'herd-test-token'
    process.env.LOG_LEVEL = 'warn'
    process.env.WORKER_ID = 'herd-worker'
    process.env.MAX_SESSIONS = '150'
    process.env.SESSION_START_STAGGER_MS = String(STAGGER_MS)
    process.env.RECONNECT_BASE_DELAY_MS = String(RECONNECT_BASE_MS)
    process.env.RECONNECT_MAX_DELAY_MS = '10000'
    process.env.RECOVERY_BACKOFF_INITIAL_MS = '1000'
    process.env.RECOVERY_BACKOFF_MAX_MS = '30000'
    process.env.EVENT_SINK = 'db'
    process.env.DOWNLOAD_MEDIA = 'false'
    process.env.BAILEYS_BROWSER_NAME = 'Echo Guard'
    process.env.WA_WEB_VERSION_OVERRIDE = ''

    const managerModule = await import('../src/sessions/session-manager.js')
    manager = managerModule.sessionManager
    ;({ pool } = await import('../src/db/pool.js'))

    const migrationsDir = path.resolve(process.cwd(), 'migrations')
    const files = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort()
    for (const file of files) {
      await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'))
    }

    const { createConnection, assignWorker } = await import('../src/db/repositories.js')
    for (let i = 0; i < CONNECTION_COUNT; i++) {
      const row = await createConnection()
      await assignWorker(row.id, 'herd-worker')
    }
    pgReady = true
  }, 240_000)

  afterAll(async () => {
    await manager?.shutdown().catch(() => {})
    await pool?.end()
    if (pgReady) {
      await promisify(exec)(`docker rm -f ${CONTAINER_NAME}`).catch(() => {})
      console.log('L3 herd simulation finished; disposable postgres container removed')
    }
  })

  it('restarts 100 connections with a staggered ramp and fenced claims', async ctx => {
    if (!pgReady || !pool) return ctx.skip()
    const rampStart = Date.now()

    await manager!.restoreAssigned()
    await waitFor(() => makeWASocket.mock.calls.length === CONNECTION_COUNT, 30_000)

    expect(fetchLatestWaWebVersion).toHaveBeenCalledTimes(1)

    const rampBuckets = new Map<number, number>()
    for (const entry of sockets.slice(0, CONNECTION_COUNT)) {
      const bucket = Math.floor((entry.openedAt - rampStart) / 100)
      rampBuckets.set(bucket, (rampBuckets.get(bucket) ?? 0) + 1)
    }
    expect(Math.max(...rampBuckets.values())).toBeLessThanOrEqual(8)

    const claims = await pool.query(
      `SELECT count(*)::int AS n
         FROM whatsapp_connector.connections
        WHERE worker_id=$1 AND claim_owner IS NOT NULL AND claim_expires_at > now()`,
      ['herd-worker']
    )
    expect(claims.rows[0].n).toBe(CONNECTION_COUNT)

    const inbox = await pool.query('SELECT count(*)::int AS n FROM whatsapp_connector.event_inbox')
    expect(inbox.rows[0].n).toBeGreaterThanOrEqual(CONNECTION_COUNT)

    const minExpiry = await pool.query(
      `SELECT min(claim_expires_at) AS e
         FROM whatsapp_connector.connections WHERE worker_id=$1`,
      ['herd-worker']
    )
    minExpiryAfterRamp = minExpiry.rows[0].e as Date
    expect(minExpiryAfterRamp.getTime()).toBeGreaterThan(Date.now())
  }, 45_000)

  it('survives a full claim-renewal wave through the pool', async ctx => {
    if (!pgReady || !pool) return ctx.skip()

    // Heartbeat renews every 10s; all sessions were created within the ramp
    // window, so the whole wave completes shortly after the earliest session
    // turns 10s old. Renewal pushes each claim_expires_at 30s past its
    // renewal time, so the min expiry moving ~10s forward proves every
    // session renewed through the shared pool.
    const target = minExpiryAfterRamp.getTime() + 9_000
    const deadline = Date.now() + 30_000
    let renewed = false
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        `SELECT min(claim_expires_at) AS e
           FROM whatsapp_connector.connections WHERE worker_id=$1`,
        ['herd-worker']
      )
      if ((rows[0].e as Date).getTime() > target) {
        renewed = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    expect(renewed).toBe(true)
    // No claim loss => no recovery restarts => socket count unchanged.
    expect(makeWASocket.mock.calls.length).toBe(CONNECTION_COUNT)
  }, 45_000)

  it('mass-disconnects 100 sockets and reconnects with real state writes', async ctx => {
    if (!pgReady || !pool) return ctx.skip()
    const disconnectAt = Date.now()

    await Promise.all(
      sockets.slice(0, CONNECTION_COUNT).map(entry =>
        entry.handlers.get('connection.update')!({
          connection: 'close',
          lastDisconnect: { error: { output: { statusCode: 500 } } }
        })
      )
    )
    await waitFor(() => makeWASocket.mock.calls.length === 2 * CONNECTION_COUNT, 30_000)

    const retries = sockets.slice(CONNECTION_COUNT).map(entry => entry.openedAt - disconnectAt)
    expect(retries).toHaveLength(CONNECTION_COUNT)
    console.log('L3 retry spread', {
      min: Math.min(...retries),
      max: Math.max(...retries),
      aboveBase: retries.filter(elapsed => elapsed > RECONNECT_BASE_MS).length
    })

    // The reconnect delay stays within the jitter band [0.75, 1.25] x base;
    // open times additionally carry the latency of 100 concurrent
    // degraded/connecting transactions through the pool, so the upper
    // bound is deliberately generous.
    for (const elapsed of retries) {
      expect(elapsed).toBeGreaterThanOrEqual(149)
      expect(elapsed).toBeLessThanOrEqual(2_000)
    }

    // Every retry socket publishes 'connecting' over the real sink.
    const inbox = await pool.query('SELECT count(*)::int AS n FROM whatsapp_connector.event_inbox')
    expect(inbox.rows[0].n).toBeGreaterThanOrEqual(3 * CONNECTION_COUNT)

    const degradedEvents = await pool.query(
      `SELECT count(*)::int AS n
         FROM whatsapp_connector.event_inbox
        WHERE payload->>'status' = 'degraded'`
    )
    expect(degradedEvents.rows[0].n).toBeGreaterThanOrEqual(CONNECTION_COUNT)

    // Each connection recorded the disconnect (degraded) and then re-entered
    // connecting when its retry socket opened.
    const statuses = await pool.query(
      'SELECT DISTINCT status FROM whatsapp_connector.connections WHERE worker_id=$1',
      ['herd-worker']
    )
    expect(statuses.rows.map(row => row.status)).toEqual(['connecting'])
  }, 60_000)
})
