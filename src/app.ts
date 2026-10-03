import Fastify, { type FastifyBaseLogger } from 'fastify'
import sensible from '@fastify/sensible'
import { env } from './config/env.js'
import { INSTANCE_ID } from './config/process-identity.js'
import { pool } from './db/pool.js'
import { logger } from './observability/logger.js'
import { registerRoutes } from './api/routes.js'
import { sessionManager } from './sessions/session-manager.js'

const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger })
await app.register(sensible)
await registerRoutes(app)

let shuttingDown = false
const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')
  await sessionManager.shutdown()
  await app.close()
  await pool.end()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await pool.query('SELECT 1')
await sessionManager.restoreAssigned()
await app.listen({ host: env.HOST, port: env.PORT })
logger.info({ port: env.PORT, worker_id: env.WORKER_ID, instance_id: INSTANCE_ID }, 'connector started')
