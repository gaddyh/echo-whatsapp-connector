import { describe, expect, it } from 'vitest'
import {
  Browsers,
  buildPairingQRData,
  Curve,
  generateRegistrationNode,
  getCompanionPlatformId,
  proto
} from '@whiskeysockets/baileys'
import { isBrowserFingerprint, pickBrowserFingerprint } from '../src/baileys/browser-fingerprint.js'

/** Names Baileys maps to real WhatsApp web client types; anything else becomes OTHER_WEB_CLIENT. */
const RECOGNIZED_BROWSERS = new Set(['Chrome', 'Safari', 'Edge', 'Firefox', 'Opera', 'IE'])

const PALETTE_ENTRIES = new Set(
  [
    Browsers.windows('Chrome'),
    Browsers.macOS('Chrome'),
    Browsers.macOS('Safari'),
    Browsers.windows('Edge'),
    Browsers.windows('Firefox'),
    Browsers.ubuntu('Chrome')
  ].map(fingerprint => JSON.stringify(fingerprint))
)

describe('browser fingerprint palette', () => {
  it('picks only palette entries whose browser maps to a real web client type', () => {
    for (let i = 0; i < 300; i++) {
      const fingerprint = pickBrowserFingerprint()
      expect(PALETTE_ENTRIES.has(JSON.stringify(fingerprint))).toBe(true)
      expect(RECOGNIZED_BROWSERS.has(fingerprint[1])).toBe(true)
    }
  })

  it('produces more than one distinct fingerprint across a realistic fleet draw', () => {
    const distinct = new Set<string>()
    for (let i = 0; i < 100; i++) distinct.add(JSON.stringify(pickBrowserFingerprint()))
    // With 100 connections and these weights the palette reliably yields several
    // distinct fingerprints; a single-value result would mean the pick collapsed.
    expect(distinct.size).toBeGreaterThanOrEqual(3)
  })

  it('validates the persisted tuple shape', () => {
    expect(isBrowserFingerprint(['Windows', 'Chrome', '10.0.22631'])).toBe(true)
    expect(isBrowserFingerprint(['Ubuntu', 'Echo Guard', '22.04.4'])).toBe(true)
    expect(isBrowserFingerprint(null)).toBe(false)
    expect(isBrowserFingerprint('Windows')).toBe(false)
    expect(isBrowserFingerprint(['Windows', 'Chrome'])).toBe(false)
    expect(isBrowserFingerprint(['Windows', 'Chrome', 42])).toBe(false)
    expect(isBrowserFingerprint(['', 'Chrome', '1.0'])).toBe(false)
  })

  it('registers every palette entry as a real web client type, never OTHER_WEB_CLIENT', () => {
    for (const entry of PALETTE_ENTRIES) {
      const fingerprint = JSON.parse(entry) as [string, string, string]
      expect(getCompanionPlatformId(fingerprint)).not.toBe('9')
    }
  })

  it('round-trips every palette entry through the real registration protobuf', () => {
    const identity = Curve.generateKeyPair()
    const preKey = Curve.generateKeyPair()
    const creds = {
      registrationId: 1234,
      signedIdentityKey: identity,
      signedPreKey: { keyId: 7, keyPair: preKey, signature: Buffer.alloc(64) }
    }
    for (const entry of PALETTE_ENTRIES) {
      const fingerprint = JSON.parse(entry) as [string, string, string]
      const node = generateRegistrationNode(creds as never, {
        version: [2, 3000, 1234567],
        browser: fingerprint,
        syncFullHistory: false
      } as never) as { devicePairingData?: { deviceProps?: Uint8Array } }

      // The real DeviceProps protobuf encodes our tuple; decode it back and
      // verify the OS and platform type survive the actual registration path.
      const propsBuffer = node.devicePairingData?.deviceProps
      expect(propsBuffer).toBeTruthy()
      const deviceProps = proto.DeviceProps.decode(propsBuffer!)
      expect(deviceProps.os).toBe(fingerprint[0])
      const platformTypeEnum = proto.DeviceProps.PlatformType as unknown as Record<string, number>
      expect(deviceProps.platformType).toBe(platformTypeEnum[fingerprint[1].toUpperCase()])

      // The pairing QR carries the same web client type.
      const qr = buildPairingQRData('ref', 'k1', 'k2', 'k3', fingerprint)
      expect(qr.endsWith(`,${getCompanionPlatformId(fingerprint)}`)).toBe(true)
    }
  })
})
