import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression tests for boolean environment parsing. z.coerce.boolean()
 * coerces via Boolean(), so the string 'false' parsed as true — meaning
 * DATABASE_SSL=false enabled SSL and DOWNLOAD_MEDIA=false enabled media
 * downloads. z.stringbool() parses the words instead.
 */

async function load() {
  return (await import('../src/config/env.js')).env
}

describe('boolean environment parsing', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.DATABASE_SSL
    delete process.env.DOWNLOAD_MEDIA
    process.env.DATABASE_URL = 'postgres://localhost:5432/test'
    process.env.AUTH_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')
    process.env.INTERNAL_API_TOKEN = 'test'
  })

  it('parses explicit "false" as false', async () => {
    process.env.DATABASE_SSL = 'false'
    process.env.DOWNLOAD_MEDIA = 'false'
    const env = await load()
    expect(env.DATABASE_SSL).toBe(false)
    expect(env.DOWNLOAD_MEDIA).toBe(false)
  })

  it('parses explicit "true" as true, case-insensitively', async () => {
    process.env.DATABASE_SSL = 'true'
    process.env.DOWNLOAD_MEDIA = 'TRUE'
    const env = await load()
    expect(env.DATABASE_SSL).toBe(true)
    expect(env.DOWNLOAD_MEDIA).toBe(true)
  })

  it('keeps the documented defaults when unset', async () => {
    const env = await load()
    expect(env.DATABASE_SSL).toBe(false)
    expect(env.DOWNLOAD_MEDIA).toBe(true)
  })
})
