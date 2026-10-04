import crypto from 'node:crypto'
import { env } from '../config/env.js'

function signingSecret(): string {
  return env.MEDIA_SIGNING_SECRET || env.INTERNAL_API_TOKEN
}

function signature(connectionId: string, reference: string, expires: number): string {
  return crypto
    .createHmac('sha256', signingSecret())
    .update(`${connectionId}\n${reference}\n${expires}`)
    .digest('base64url')
}

export function signedMediaUrl(
  connectionId: string,
  reference: string,
  now = Math.floor(Date.now() / 1000)
): string {
  const expires = now + env.MEDIA_URL_TTL_SECONDS
  const base = env.MEDIA_BASE_URL.replace(/\/$/, '')
  const params = new URLSearchParams({
    expires: String(expires),
    signature: signature(connectionId, reference, expires)
  })
  return `${base}/media/${encodeURIComponent(connectionId)}/${encodeURIComponent(reference)}?${params}`
}

export function verifyMediaSignature(
  connectionId: string,
  reference: string,
  expires: number,
  candidate: string,
  now = Math.floor(Date.now() / 1000)
): boolean {
  if (!Number.isSafeInteger(expires) || expires < now) return false
  const expected = Buffer.from(signature(connectionId, reference, expires))
  const actual = Buffer.from(candidate)
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}
