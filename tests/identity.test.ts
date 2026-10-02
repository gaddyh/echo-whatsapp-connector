import { describe, expect, it } from 'vitest'
import { normalizeIdentity } from '../src/baileys/identity.js'

describe('normalizeIdentity', () => {
  it('prefers LID as canonical while retaining PN', () => {
    expect(normalizeIdentity({
      participant: '123456789@lid',
      participantAlt: '972501234567@s.whatsapp.net',
      pushName: 'Maya'
    })).toEqual({
      canonical_id: '123456789@lid',
      lid: '123456789@lid',
      phone_jid: '972501234567@s.whatsapp.net',
      phone_number: '972501234567',
      display_name: 'Maya'
    })
  })
})
