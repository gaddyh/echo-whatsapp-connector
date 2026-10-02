export type ConnectionStatus =
  | 'provisioning'
  | 'connecting'
  | 'pairing_required'
  | 'connected'
  | 'degraded'
  | 'blocked'
  | 'suspended'
  | 'unknown'

export type MessageKind = 'text' | 'image' | 'audio' | 'video' | 'document' | 'reaction' | 'other'
export type MessageDirection = 'inbound' | 'outbound'
export type MessageSource = 'user' | 'api' | null

export interface NormalizedIdentity {
  canonical_id: string
  lid?: string
  phone_jid?: string
  phone_number?: string
  display_name?: string
}

export interface NormalizedMessageEvent {
  event_type: 'message'
  event_id: string
  provider: 'baileys'
  connection_id: string
  chat_id: string
  chat_name?: string
  is_group: boolean
  provider_message_id: string
  direction: MessageDirection
  source: MessageSource
  timestamp: string
  kind: MessageKind
  text?: string
  sender?: NormalizedIdentity
  quoted_message_id?: string
  media_mime_type?: string
  media_file_name?: string
}

export interface NormalizedConnectionEvent {
  event_type: 'connection_state'
  event_id: string
  provider: 'baileys'
  connection_id: string
  status: ConnectionStatus
  provider_raw_status?: string
  timestamp: string
}

export type NormalizedEvent = NormalizedMessageEvent | NormalizedConnectionEvent
