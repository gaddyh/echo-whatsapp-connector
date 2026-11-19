import crypto from 'node:crypto'
import { Browsers } from '@whiskeysockets/baileys'

export type BrowserFingerprint = [string, string, string]

/**
 * Weighted palette of realistic linked-device fingerprints. Built only from
 * Baileys' own Browsers helpers so the tuples stay well-formed, and every
 * browserName maps to a recognized WhatsApp web client type — an unrecognized
 * name (e.g. a product name) registers as OTHER_WEB_CLIENT, which no real
 * WhatsApp Web population occupies. The palette is static on purpose: it is
 * chosen once per connection at pairing and persisted, so a fleet naturally
 * becomes a mixture of pairing-time vintages like a real device population.
 * Review the weights when bumping the Baileys package.
 */
const FINGERPRINTS: Array<{ weight: number; fingerprint: BrowserFingerprint }> = [
  { weight: 40, fingerprint: Browsers.windows('Chrome') },
  { weight: 20, fingerprint: Browsers.macOS('Chrome') },
  { weight: 15, fingerprint: Browsers.macOS('Safari') },
  { weight: 10, fingerprint: Browsers.windows('Edge') },
  { weight: 10, fingerprint: Browsers.windows('Firefox') },
  { weight: 5, fingerprint: Browsers.ubuntu('Chrome') }
]

const TOTAL_WEIGHT = FINGERPRINTS.reduce((sum, entry) => sum + entry.weight, 0)

export function pickBrowserFingerprint(): BrowserFingerprint {
  let roll = crypto.randomInt(1, TOTAL_WEIGHT + 1)
  for (const entry of FINGERPRINTS) {
    roll -= entry.weight
    if (roll <= 0) return entry.fingerprint
  }
  return FINGERPRINTS[FINGERPRINTS.length - 1]!.fingerprint
}

/** Guards the tuple persisted in connections.settings against shape drift. */
export function isBrowserFingerprint(value: unknown): value is BrowserFingerprint {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(item => typeof item === 'string' && item.length > 0)
  )
}
