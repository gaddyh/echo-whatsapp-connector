import crypto from 'node:crypto'
import { env } from '../config/env.js'

const key = Buffer.from(env.AUTH_ENCRYPTION_KEY, 'base64')
if (key.length !== 32) {
  throw new Error('AUTH_ENCRYPTION_KEY must decode to exactly 32 bytes')
}

export function encrypt(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted])
}

export function decrypt(envelope: Buffer): Buffer {
  if (envelope.length < 28) throw new Error('invalid encrypted payload')
  const iv = envelope.subarray(0, 12)
  const tag = envelope.subarray(12, 28)
  const ciphertext = envelope.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
