import { fetchLatestWaWebVersion } from '@whiskeysockets/baileys'
import { env } from '../config/env.js'
import { logger } from '../observability/logger.js'

/** How long a successfully fetched WA web version is reused across socket opens. */
const VERSION_CACHE_TTL_MS = 10 * 60_000

let cachedVersion: [number, number, number] | undefined
let cachedAt = 0
let inFlight: Promise<[number, number, number]> | undefined

export async function resolveWaVersion(): Promise<[number, number, number]> {
  const override = env.WA_WEB_VERSION_OVERRIDE.trim()
  if (override) {
    const parts = override.split('.').map(Number)
    if (parts.length !== 3 || parts.some(Number.isNaN)) {
      throw new Error('WA_WEB_VERSION_OVERRIDE must be three dot-separated integers')
    }
    return parts as [number, number, number]
  }
  if (cachedVersion && Date.now() - cachedAt < VERSION_CACHE_TTL_MS) return cachedVersion
  if (inFlight) return inFlight
  const pending = (async () => {
    const { version, isLatest, error } = await fetchLatestWaWebVersion()
    if (isLatest && version) {
      cachedVersion = version as [number, number, number]
      cachedAt = Date.now()
      return cachedVersion
    }
    logger.warn({ err: error }, 'wa web version fetch failed; using last known good version')
    return cachedVersion ?? (version as [number, number, number])
  })()
  inFlight = pending
  try {
    return await pending
  } finally {
    if (inFlight === pending) inFlight = undefined
  }
}
