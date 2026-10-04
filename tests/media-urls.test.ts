import { beforeAll, describe, expect, it } from 'vitest'

let signedMediaUrl: typeof import('../src/media/signed-urls.js').signedMediaUrl
let verifyMediaSignature: typeof import('../src/media/signed-urls.js').verifyMediaSignature

beforeAll(async () => {
  process.env.AUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.INTERNAL_API_TOKEN = 'test-token'
  process.env.MEDIA_SIGNING_SECRET = 'media-secret'
  ;({ signedMediaUrl, verifyMediaSignature } = await import('../src/media/signed-urls.js'))
})

describe('signed media URLs', () => {
  it('binds a short-lived URL to the connection and reference', () => {
    const url = signedMediaUrl('connection-id', 'baileys:connection-id:message-id', 100)
    const parsed = new URL(url)
    const expires = Number(parsed.searchParams.get('expires'))
    const signature = parsed.searchParams.get('signature')!

    expect(parsed.pathname).toContain('/media/connection-id/baileys%3Aconnection-id%3Amessage-id')
    expect(verifyMediaSignature('connection-id', 'baileys:connection-id:message-id', expires, signature, 101)).toBe(true)
    expect(verifyMediaSignature('other-connection', 'baileys:connection-id:message-id', expires, signature, 101)).toBe(false)
  })

  it('rejects expired and tampered signatures', () => {
    const url = signedMediaUrl('connection-id', 'baileys:connection-id:message-id', 100)
    const parsed = new URL(url)
    const expires = Number(parsed.searchParams.get('expires'))
    const signature = parsed.searchParams.get('signature')!

    expect(verifyMediaSignature('connection-id', 'baileys:connection-id:message-id', expires, signature, expires + 1)).toBe(false)
    expect(verifyMediaSignature('connection-id', 'baileys:connection-id:message-id', expires, `${signature}x`, 101)).toBe(false)
  })
})
