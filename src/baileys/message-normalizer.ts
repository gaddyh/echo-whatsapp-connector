import type { WAMessage } from '@whiskeysockets/baileys'
import type { MessageKind, NormalizedMessageEvent } from '../events/types.js'
import { normalizeIdentity } from './identity.js'

function unwrap(message: any): any {
  let m = message
  for (;;) {
    const next = m?.ephemeralMessage?.message
      ?? m?.viewOnceMessage?.message
      ?? m?.viewOnceMessageV2?.message
      ?? m?.viewOnceMessageV2Extension?.message
      ?? m?.documentWithCaptionMessage?.message
    if (!next) return m
    m = next
  }
}

function classify(m: any): { kind: MessageKind; text?: string; mime?: string; fileName?: string; quoted?: string } {
  if (!m) return { kind: 'other' }
  if (typeof m.conversation === 'string') return { kind: 'text', text: m.conversation }
  if (m.extendedTextMessage) {
    return {
      kind: 'text',
      text: m.extendedTextMessage.text ?? undefined,
      quoted: m.extendedTextMessage.contextInfo?.stanzaId ?? undefined
    }
  }
  if (m.imageMessage) return { kind: 'image', text: m.imageMessage.caption ?? undefined, mime: m.imageMessage.mimetype ?? undefined }
  if (m.videoMessage) return { kind: 'video', text: m.videoMessage.caption ?? undefined, mime: m.videoMessage.mimetype ?? undefined }
  if (m.audioMessage) return { kind: 'audio', mime: m.audioMessage.mimetype ?? undefined }
  if (m.documentMessage) return {
    kind: 'document',
    text: m.documentMessage.caption ?? undefined,
    mime: m.documentMessage.mimetype ?? undefined,
    fileName: m.documentMessage.fileName ?? undefined
  }
  if (m.reactionMessage) return { kind: 'reaction', text: m.reactionMessage.text ?? undefined, quoted: m.reactionMessage.key?.id ?? undefined }
  return { kind: 'other' }
}

export function normalizeMessage(connectionId: string, msg: WAMessage): NormalizedMessageEvent | null {
  const id = msg.key.id
  const chatId = msg.key.remoteJid
  if (!id || !chatId) return null

  const raw = unwrap(msg.message)
  const info = classify(raw)
  const isGroup = chatId.endsWith('@g.us')
  const keyAny = msg.key as any
  const participant = isGroup ? keyAny.participant : (msg.key.fromMe ? undefined : chatId)
  const participantAlt = isGroup ? keyAny.participantAlt : keyAny.remoteJidAlt
  const sender = normalizeIdentity({ participant, participantAlt, pushName: msg.pushName })
  const timestampSeconds = Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000))

  return {
    event_type: 'message',
    event_id: `message:${connectionId}:${id}:${msg.key.fromMe ? 'out' : 'in'}`,
    provider: 'baileys',
    connection_id: connectionId,
    chat_id: chatId,
    is_group: isGroup,
    provider_message_id: id,
    direction: msg.key.fromMe ? 'outbound' : 'inbound',
    // Outbound messages seen from another linked device are USER-originated.
    // Messages sent through this connector are marked API at send time in a future status event/outbox extension.
    source: msg.key.fromMe ? 'user' : null,
    timestamp: new Date(timestampSeconds * 1000).toISOString(),
    kind: info.kind,
    text: info.text,
    sender,
    quoted_message_id: info.quoted,
    media_mime_type: info.mime,
    media_file_name: info.fileName
  }
}
