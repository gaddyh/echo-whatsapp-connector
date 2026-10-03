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

  it('supports phone-only and alternate-only identities', () => {
    expect(normalizeIdentity({ participant: '972501234567@s.whatsapp.net' })).toMatchObject({
      canonical_id: '972501234567@s.whatsapp.net',
      phone_number: '972501234567'
    })
    expect(normalizeIdentity({ participantAlt: 'contact@example' })).toEqual({
      canonical_id: 'contact@example',
      lid: undefined,
      phone_jid: undefined,
      phone_number: undefined,
      display_name: undefined
    })
  })

  it('returns undefined without either participant identity', () => {
    expect(normalizeIdentity({})).toBeUndefined()
    expect(normalizeIdentity({ participant: null, participantAlt: null })).toBeUndefined()
  })
})
