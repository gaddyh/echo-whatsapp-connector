import { fetchLatestWaWebVersion } from '@whiskeysockets/baileys'
import { env } from '../config/env.js'

export async function resolveWaVersion(): Promise<[number, number, number]> {
  const override = env.WA_WEB_VERSION_OVERRIDE.trim()
  if (override) {
    const parts = override.split('.').map(Number)
    if (parts.length !== 3 || parts.some(Number.isNaN)) {
      throw new Error('WA_WEB_VERSION_OVERRIDE must be three dot-separated integers')
    }
    return parts as [number, number, number]
  }
  const { version } = await fetchLatestWaWebVersion()
  return version as [number, number, number]
}
