import { beforeAll, describe, expect, it, vi } from 'vitest'

let encrypt: typeof import('../src/auth/crypto.js').encrypt
let decrypt: typeof import('../src/auth/crypto.js').decrypt

beforeAll(async () => {
  process.env.AUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.INTERNAL_API_TOKEN = 'test-token'
  ;({ encrypt, decrypt } = await import('../src/auth/crypto.js'))
})

describe('auth encryption', () => {
  it('round trips encrypted payloads', () => {
    const plain = Buffer.from('sensitive auth state')
    expect(decrypt(encrypt(plain))).toEqual(plain)
  })

  it('rejects truncated envelopes', () => {
    expect(() => decrypt(Buffer.alloc(27))).toThrow('invalid encrypted payload')
  })

  it('rejects tampered payloads', () => {
    const encrypted = encrypt(Buffer.from('payload'))
    encrypted[encrypted.length - 1]! ^= 1
    expect(() => decrypt(encrypted)).toThrow()
  })

  it('rejects encryption keys with the wrong decoded length', async () => {
    vi.resetModules()
    process.env.AUTH_ENCRYPTION_KEY = Buffer.alloc(31, 7).toString('base64')
    await expect(import('../src/auth/crypto.js')).rejects.toThrow('exactly 32 bytes')
    process.env.AUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  })
})
