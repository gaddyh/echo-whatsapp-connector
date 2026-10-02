import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { env } from '../config/env.js'
import { listConnections, updateConnectionSettings } from '../db/repositories.js'
import { sessionManager } from '../sessions/session-manager.js'

const createSchema = z.object({
  phone_number: z.string().optional(),
  // Accepted for semantic compatibility with Echo ConnectionConfig. Baileys does
  // not need provider webhooks because the connector owns the live socket.
  webhook_url: z.string().optional(),
  webhook_token: z.string().optional(),
  subscriptions: z.record(z.string(), z.boolean()).optional()
})

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return
    if (req.headers.authorization !== `Bearer ${env.INTERNAL_API_TOKEN}`) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.get('/health', async () => ({ status: 'ok', worker_id: env.WORKER_ID }))

  app.post('/connections', async (req, reply) => {
    const body = createSchema.parse(req.body ?? {})
    const created = await sessionManager.create(body.phone_number)
    return reply.code(201).send(created)
  })

  app.get('/connections', async () => {
    const rows = await listConnections()
    return rows.map(r => ({
      connection_id: r.id,
      status: r.status,
      provider_raw_status: r.raw_status,
      worker_id: r.worker_id
    }))
  })

  app.put('/connections/:id/config', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = createSchema.partial().parse(req.body ?? {})
    // Webhook fields are retained as configuration metadata for Echo protocol parity;
    // they do not configure Baileys itself because the connector owns the live socket.
    await updateConnectionSettings(id, body)
    return reply.code(204).send()
  })

  app.post('/connections/:id/restart', async (req, reply) => {
    const { id } = req.params as { id: string }
    await sessionManager.restart(id)
    return reply.code(204).send()
  })

  app.get('/connections/:id/status', async req => {
    const { id } = req.params as { id: string }
    const status = await sessionManager.status(id)
    if (!status) throw app.httpErrors.notFound('connection not found')
    return status
  })

  app.get('/connections/:id/qr', async req => {
    const { id } = req.params as { id: string }
    return sessionManager.qr(id)
  })

  app.post('/connections/:id/pairing-code', async req => {
    const { id } = req.params as { id: string }
    const body = z.object({ phone_number: z.string().min(6) }).parse(req.body)
    return { code: await sessionManager.pairingCode(id, body.phone_number) }
  })

  app.post('/connections/:id/messages', async req => {
    const { id } = req.params as { id: string }
    const body = z.object({ chat_id: z.string().min(1), message: z.string() }).parse(req.body)
    return { provider_message_id: await sessionManager.sendText(id, body.chat_id, body.message) }
  })

  app.post('/connections/:id/unpair', async (req, reply) => {
    const { id } = req.params as { id: string }
    await sessionManager.unpair(id)
    return reply.code(204).send()
  })

  app.delete('/connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    await sessionManager.remove(id)
    return reply.code(204).send()
  })
}
