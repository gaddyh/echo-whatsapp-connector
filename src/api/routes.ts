import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { env } from '../config/env.js'
import { updateConnectionSettings } from '../db/repositories.js'
import { MediaDownloadError, MediaPayloadIncompleteError, MediaTooLargeError } from '../media/errors.js'
import { sessionManager } from '../sessions/session-manager.js'
import { signedMediaUrl, verifyMediaSignature } from '../media/signed-urls.js'

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
    if (req.url === '/health' || req.url.startsWith('/media/')) return
    if (req.headers.authorization !== `Bearer ${env.INTERNAL_API_TOKEN}`) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.get('/health', async () => ({ status: 'ok', worker_id: env.WORKER_ID }))

  app.get('/media/:connectionId/:reference', async (req, reply) => {
    const { connectionId, reference } = req.params as { connectionId: string; reference: string }
    const query = z.object({
      expires: z.coerce.number().int(),
      signature: z.string().min(1)
    }).parse(req.query)
    if (!verifyMediaSignature(connectionId, reference, query.expires, query.signature)) {
      return reply.code(403).send({ error: 'invalid or expired media URL' })
    }
    try {
      const media = await sessionManager.downloadMedia(connectionId, reference)
      if (media.mimeType) reply.type(media.mimeType)
      if (media.fileName) reply.header('content-disposition', `inline; filename="${media.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}"`)
      return reply.send(media.bytes)
    } catch (err) {
      // Map typed media errors to accurate HTTP codes so callers (and operators)
      // can distinguish deterministic failures from transient ones. External
      // response bodies stay generic; structured internal logs carry the
      // failure category, connection id and reference. Media keys and bytes
      // are never logged.
      if (err instanceof MediaTooLargeError) {
        req.log.warn(
          {
            err,
            connection_id: connectionId,
            reference,
            category: 'too_large',
            bytes_read: err.bytesRead,
            declared_file_length: err.declaredFileLength,
            limit: err.limit
          },
          'media download rejected: oversized'
        )
        return reply.code(413).send({ error: 'media too large' })
      }
      if (err instanceof MediaPayloadIncompleteError) {
        req.log.warn({ err, connection_id: connectionId, reference, category: 'unavailable' }, 'media download rejected: payload unavailable')
        return reply.code(404).send({ error: 'media unavailable' })
      }
      if (err instanceof MediaDownloadError) {
        req.log.warn({ err, connection_id: connectionId, reference, category: 'transient' }, 'media download failed: transient')
        return reply.code(503).send({ error: 'media temporarily unavailable' })
      }
      req.log.error({ err, connection_id: connectionId, reference, category: 'unknown' }, 'media download failed: unexpected error')
      return reply.code(500).send({ error: 'media unavailable' })
    }
  })

  app.get('/connections/:id/media-url', async req => {
    const { id } = req.params as { id: string }
    const query = z.object({ reference: z.string().min(1) }).parse(req.query)
    return { media_download_url: signedMediaUrl(id, query.reference) }
  })

  app.post('/connections', async (req, reply) => {
    const body = createSchema.parse(req.body ?? {})
    const created = await sessionManager.create(body.phone_number)
    return reply.code(201).send(created)
  })

  app.get('/connections', async () => sessionManager.listStatus())

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

  app.post('/connections/:id/prepare-pairing', async req => {
    const { id } = req.params as { id: string }
    return sessionManager.preparePairing(id)
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
