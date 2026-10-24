/**
 * Normalize a WhatsApp media size field to a plain number.
 *
 * Baileys/protobuf encodes 64-bit integers (e.g. ``fileLength``) as Long
 * objects of the form ``{ low, high, unsigned }`` at runtime, even though
 * the TypeScript types declare them as ``number``. A plain ``number`` is
 * returned unchanged. ``null``/``undefined`` and non-numeric values
 * return ``undefined``.
 */
export function normalizeFileLength(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (value && typeof value === 'object' && typeof (value as any).toNumber === 'function') {
    const n = (value as { toNumber: () => number }).toNumber()
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
