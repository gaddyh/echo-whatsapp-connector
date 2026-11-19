import { describe, expect, it } from 'vitest'
import { Browsers } from '@whiskeysockets/baileys'
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
})
