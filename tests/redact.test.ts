import { describe, expect, it } from 'vitest'
import { redactText } from '../src/monitor/redact.js'

describe('redaction', () => {
  it('truncates UUIDs to their 8-char prefix', () => {
    expect(redactText('connection c9e78864-5337-469a-88f2-42c0aa0fd9ee failed')).toBe('connection c9e78864 failed')
  })

  it('masks WhatsApp JIDs', () => {
    expect(redactText('chat 120363219342355972@newsletter and 972501234567:69@s.whatsapp.net'))
      .toBe('chat [jid] and [jid]')
  })

  it('masks phone-number digit runs but keeps short numbers', () => {
    expect(redactText('phone 972501234567 delay 2500ms')).toBe('phone [number] delay 2500ms')
    expect(redactText('+972 50 123 4567')).toBe('[number]')
  })

  it('leaves ordinary text alone', () => {
    expect(redactText('connection recovery scheduled')).toBe('connection recovery scheduled')
  })
})
