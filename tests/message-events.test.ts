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
    expect(event).not.toHaveProperty('media_reference')
    expect(event).not.toHaveProperty('media_download_url')
  })

  it('unwraps wrapped media before emitting a media reference', () => {
    const event = normalizeMessage('connection-id', {
      key: {
        id: 'wrapped-audio-id',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false
      },
      message: {
        ephemeralMessage: {
          message: {
            audioMessage: {
              mimetype: 'audio/ogg',
              mediaKey: Buffer.from('media-key')
            }
          }
        }
      }
    } as any)

    expect(event?.media_reference).toBe('baileys:connection-id:wrapped-audio-id')
  })

  it('emits a media reference only when the media payload can be downloaded', () => {
    const event = normalizeMessage('connection-id', {
      key: {
        id: 'audio-id',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false
      },
      message: {
        audioMessage: {
          mimetype: 'audio/ogg',
          mediaKey: Buffer.from('media-key')
        }
      }
    } as any)

    expect(event?.media_reference).toBe('baileys:connection-id:audio-id')
  })

  it('classifies a static sticker as an image with image/webp mime and a media reference', () => {
    const event = normalizeMessage('connection-id', {
      key: {
        id: 'sticker-id',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false
      },
      message: {
        stickerMessage: {
          mimetype: 'image/webp',
          mediaKey: Buffer.from('sticker-media-key'),
          isAnimated: false
        }
      }
    } as any)

    expect(event).toMatchObject({
      kind: 'image',
      media_mime_type: 'image/webp'
    })
    expect(event?.media_reference).toBe('baileys:connection-id:sticker-id')
  })

  it('classifies a static sticker as image even when isAnimated is absent', () => {
    // WhatsApp stickers may omit isAnimated for static stickers. The
    // normalizer must treat absent/false/null as static.
    const event = normalizeMessage('connection-id', {
      key: {
        id: 'sticker-no-anim-flag',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false
      },
      message: {
        stickerMessage: {
          mimetype: 'image/webp',
          mediaKey: Buffer.from('sticker-media-key')
        }
      }
    } as any)

    expect(event?.kind).toBe('image')
    expect(event?.media_mime_type).toBe('image/webp')
    expect(event?.media_reference).toBe('baileys:connection-id:sticker-no-anim-flag')
  })

  it('classifies an animated sticker as other and emits no media reference', () => {
    const event = normalizeMessage('connection-id', {
      key: {
        id: 'animated-sticker-id',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false
      },
      message: {
        stickerMessage: {
          mimetype: 'image/webp',
          mediaKey: Buffer.from('sticker-media-key'),
          isAnimated: true
        }
      }
    } as any)

    expect(event?.kind).toBe('other')
    expect(event).not.toHaveProperty('media_reference')
    expect(event).not.toHaveProperty('media_download_url')
  })

  it('does not emit a media reference for a static sticker without a mediaKey', () => {
    const event = normalizeMessage('connection-id', {
      key: {
        id: 'sticker-no-key',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false
      },
      message: {
        stickerMessage: {
          mimetype: 'image/webp',
          isAnimated: false
        }
      }
    } as any)

    // Classified as image (so Echo knows a sticker was sent) but not
    // downloadable — consistent with audio/image messages lacking mediaKey.
    expect(event?.kind).toBe('image')
    expect(event?.media_mime_type).toBe('image/webp')
    expect(event).not.toHaveProperty('media_reference')
    expect(event).not.toHaveProperty('media_download_url')
  })

  it('emits a sticker event compatible with the existing image enrichment contract', () => {
    // A static sticker event must expose the same fields a real image
    // message event exposes (kind, media_mime_type, media_reference), so
    // Echo's image enrichment pipeline consumes it without modification.
    const stickerEvent = normalizeMessage('connection-id', {
      key: {
        id: 'sticker-contract',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false
      },
      message: {
        stickerMessage: {
          mimetype: 'image/webp',
          mediaKey: Buffer.from('sticker-media-key'),
          isAnimated: false
        }
      }
    } as any)

    const imageEvent = normalizeMessage('connection-id', {
      key: {
        id: 'image-contract',
        remoteJid: '15551234567@s.whatsapp.net',
        fromMe: false
      },
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          mediaKey: Buffer.from('image-media-key')
        }
      }
    } as any)

    // Both events must carry the same media-related keys.
    const stickerMediaKeys = Object.keys(stickerEvent ?? {}).filter(k => k.startsWith('media_') || k === 'kind')
    const imageMediaKeys = Object.keys(imageEvent ?? {}).filter(k => k.startsWith('media_') || k === 'kind')
    expect(stickerMediaKeys.sort()).toEqual(imageMediaKeys.sort())
    expect(stickerEvent?.kind).toBe('image')
    expect(imageEvent?.kind).toBe('image')
    expect(stickerEvent).toHaveProperty('media_reference')
    expect(imageEvent).toHaveProperty('media_reference')
  })
})
