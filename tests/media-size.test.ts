import { describe, expect, it } from 'vitest'
import { normalizeFileLength } from '../src/media/size.js'

describe('normalizeFileLength', () => {
  it('returns a plain number unchanged', () => {
    expect(normalizeFileLength(435915)).toBe(435915)
  })

  it('converts a protobuf Long-like object via toNumber()', () => {
    const longLike = { low: 435915, high: 0, unsigned: true, toNumber: () => 435915 }
    expect(normalizeFileLength(longLike)).toBe(435915)
  })

  it('returns undefined for null/undefined', () => {
    expect(normalizeFileLength(null)).toBeUndefined()
    expect(normalizeFileLength(undefined)).toBeUndefined()
  })

  it('returns undefined for non-numeric values', () => {
    expect(normalizeFileLength('435915')).toBeUndefined()
    expect(normalizeFileLength({ low: 1, high: 0 })).toBeUndefined()
  })

  it('returns undefined for NaN/Infinity', () => {
    expect(normalizeFileLength(Number.NaN)).toBeUndefined()
    expect(normalizeFileLength(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})
