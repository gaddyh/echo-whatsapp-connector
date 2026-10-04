import { describe, expect, it } from 'vitest'
import { normalizeMessage } from '../src/baileys/message-normalizer.js'

describe('normalized message events', () => {
  it('emits a versioned inbound text event with canonical identity fields', () => {
    const event = normalizeMessage('connection-id', {
      key: {
        id: 'message-id',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false
      },
      message: { conversation: 'hello' },
      pushName: 'Alice',
      messageTimestamp: 1700000000
    } as any)

    expect(event).toMatchObject({
      schema_version: 1,
      event_type: 'message',
      provider: 'baileys',
      connection_id: 'connection-id',
      chat_id: '15551234567@s.whatsapp.net',
      is_group: false,
      provider_message_id: 'message-id',
      direction: 'inbound',
      source: null,
      kind: 'text',
      text: 'hello'
    })
    expect(event?.sender).toMatchObject({
      canonical_id: '15551234567@s.whatsapp.net',
      display_name: 'Alice'
    })
  })

  it('emits a versioned outbound event and preserves API source correlation', () => {
    const event = normalizeMessage('connection-id', {
      key: {
        id: 'message-id',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: true
      },
      message: { conversation: 'sent' },
      messageTimestamp: 1700000000
    } as any)

    expect(event).toMatchObject({
      schema_version: 1,
      direction: 'outbound',
      source: 'user',
      text: 'sent'
    })
  })

  it('includes media metadata without pretending to provide media bytes', () => {
    const event = normalizeMessage('connection-id', {
      key: {
        id: 'audio-id',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false
      },
      message: {
        audioMessage: {
          mimetype: 'audio/ogg; codecs=opus'
        }
      }
    } as any)

    expect(event).toMatchObject({
      schema_version: 1,
      kind: 'audio',
      media_mime_type: 'audio/ogg; codecs=opus'
    })
    expect(event?.media_reference).toBe('baileys:connection-id:audio-id')
    expect(event).not.toHaveProperty('media_download_url')
  })
})
