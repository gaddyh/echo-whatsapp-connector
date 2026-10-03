import {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type WASocket
} from '@whiskeysockets/baileys'
import type { Pool } from 'pg'
import { createPostgresAuthState } from '../auth/postgres-auth-state.js'
import { env } from '../config/env.js'
import { INSTANCE_ID } from '../config/process-identity.js'
import { eventSink } from '../events/sink.js'
import type { ConnectionStatus, NormalizedConnectionEvent } from '../events/types.js'
import { logger } from '../observability/logger.js'
import { normalizeMessage } from '../baileys/message-normalizer.js'
import { resolveWaVersion } from '../baileys/version-provider.js'
import {
  getGroupSubject,
  LostClaimError,
  renewClaim,
  updateConnectionStatus,
  updateConnectionStatusAndEvent,
  upsertGroup,
  upsertIdentity
} from '../db/repositories.js'

export class Session {
  private sock?: WASocket
  private auth?: Awaited<ReturnType<typeof createPostgresAuthState>>
  private qr?: string
  private reconnectAttempt = 0
  private stopped = false
  private lostClaim = false
  private heartbeat?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  private apiSentMessageIds = new Set<string>()

  constructor(
    readonly connectionId: string,
    private readonly db: Pool,
    private readonly claimToken: string,
    private readonly onLostClaim: () => void
  ) {
    this.heartbeat = setInterval(() => void this.renew(), 10_000)
  }

  get socket(): WASocket | undefined { return this.sock }
  get latestQr(): string | undefined { return this.qr }
  get capability(): string { return this.claimToken }

  private loseClaim(err?: unknown): void {
    if (this.lostClaim) return
    this.lostClaim = true
    this.stopped = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try { this.sock?.end(undefined) } catch { /* best effort */ }
    this.sock = undefined
    logger.warn({ err, connection_id: this.connectionId, instance_id: INSTANCE_ID }, 'connection claim lost')
    this.onLostClaim()
  }

  private async renew(): Promise<void> {
    if (this.stopped || this.lostClaim) return
    try {
      if (!await renewClaim(this.connectionId, INSTANCE_ID, this.claimToken)) this.loseClaim()
    } catch (err) {
      logger.error({ err, connection_id: this.connectionId }, 'claim renewal failed')
      this.loseClaim(err)
    }
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.openSocket()
  }

  private async publishState(
    status: ConnectionStatus,
    raw?: string,
    disconnectReason?: string
  ): Promise<void> {
    try {
      if (env.EVENT_SINK === 'db') {
        await updateConnectionStatusAndEvent(this.connectionId, this.claimToken, status, raw, disconnectReason)
        return
      }

      await updateConnectionStatus(this.connectionId, this.claimToken, status, raw, disconnectReason)
      const event: NormalizedConnectionEvent = {
        event_type: 'connection_state',
        event_id: `state:${this.connectionId}:${status}:${Date.now()}`,
        provider: 'baileys',
        connection_id: this.connectionId,
        status,
        provider_raw_status: raw,
        timestamp: new Date().toISOString()
      }
      await eventSink.publish(event, this.claimToken)
    } catch (err) {
      if (err instanceof LostClaimError) {
        this.loseClaim(err)
        return
      }
      throw err
    }
  }

  private async openSocket(): Promise<void> {
    if (this.stopped || this.lostClaim) return
    await this.publishState('connecting', 'opening_socket')
    if (this.stopped || this.lostClaim) return
    this.auth = await createPostgresAuthState(this.db, this.connectionId, this.claimToken)
    const version = await resolveWaVersion()

    const sock = makeWASocket({
      version,
      auth: {
        creds: this.auth.state.creds,
        keys: makeCacheableSignalKeyStore(this.auth.state.keys, logger as any)
      },
      browser: Browsers.ubuntu(env.BAILEYS_BROWSER_NAME),
      logger: logger.child({ connection_id: this.connectionId, component: 'baileys' }) as any,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined
    })
    this.sock = sock

    sock.ev.on('creds.update', async () => {
      try { await this.auth?.saveCreds() }
      catch (err) {
        if (err instanceof LostClaimError) this.loseClaim(err)
        else logger.error({ err, connection_id: this.connectionId }, 'failed to persist credentials')
      }
    })

    sock.ev.on('connection.update', async update => {
      if (update.qr) {
        this.qr = update.qr
        await this.publishState('pairing_required', 'qr_ready')
      }
      if (update.connection === 'open') {
        this.qr = undefined
        this.reconnectAttempt = 0
        await this.publishState('connected', 'open')
        return
      }
      if (update.connection === 'close') {
        const statusCode = Number((update.lastDisconnect?.error as any)?.output?.statusCode ?? 0)
        await this.handleDisconnect(statusCode)
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // type === 'notify' = live message, 'append' = history sync replay
      if (type !== 'notify') return
      for (const msg of messages) {
        const event = normalizeMessage(this.connectionId, msg)
        if (!event) continue
        if (event.direction === 'outbound' && this.apiSentMessageIds.has(event.provider_message_id)) {
          event.source = 'api'
          this.apiSentMessageIds.delete(event.provider_message_id)
        }
        if (event.sender) {
          try { await upsertIdentity(this.connectionId, this.claimToken, event.sender) }
          catch (err) {
            if (err instanceof LostClaimError) this.loseClaim(err)
            else logger.warn({ err, connection_id: this.connectionId }, 'identity upsert failed')
          }
        }
        if (event.is_group) {
          try {
            let subject = await getGroupSubject(this.connectionId, event.chat_id)
            if (!subject && this.sock) {
              const meta = await this.sock.groupMetadata(event.chat_id)
              subject = meta?.subject
              if (subject) await upsertGroup(this.connectionId, this.claimToken, event.chat_id, subject, meta?.owner)
            }
            if (subject) event.chat_name = subject
          } catch (err) {
            if (err instanceof LostClaimError) this.loseClaim(err)
            else logger.warn({ err, connection_id: this.connectionId, chat_id: event.chat_id }, 'group subject lookup failed')
          }
        }
        try { await eventSink.publish(event) }
        catch (err) { logger.error({ err, connection_id: this.connectionId }, 'event publish failed') }
      }
    })

    sock.ev.on('contacts.upsert', async contacts => {
      for (const c of contacts as any[]) {
        const id = c.id as string | undefined
        if (!id) continue
        const lid = c.lid ?? (id.endsWith('@lid') ? id : undefined)
        const phoneJid = c.phoneNumber ?? (id.endsWith('@s.whatsapp.net') ? id : undefined)
        const canonical = lid ?? phoneJid ?? id
        try {
          await upsertIdentity(this.connectionId, this.claimToken, {
            canonical_id: canonical,
            lid,
            phone_jid: phoneJid,
            phone_number: phoneJid?.split('@')[0],
            display_name: c.name ?? c.notify ?? c.verifiedName
          })
        } catch (err) {
          if (err instanceof LostClaimError) this.loseClaim(err)
          else logger.warn({ err, connection_id: this.connectionId }, 'contact upsert failed')
        }
      }
    })

    sock.ev.on('groups.upsert', async groups => {
      for (const g of groups as any[]) {
        try { await upsertGroup(this.connectionId, this.claimToken, g.id, g.subject, g.ownerPn ?? g.owner) }
        catch (err) {
          if (err instanceof LostClaimError) this.loseClaim(err)
          else logger.warn({ err, connection_id: this.connectionId }, 'group upsert failed')
        }
      }
    })

    sock.ev.on('groups.update', async groups => {
      for (const g of groups as any[]) {
        if (!g.id) continue
        try { await upsertGroup(this.connectionId, this.claimToken, g.id, g.subject, g.owner ?? undefined) }
        catch (err) {
          if (err instanceof LostClaimError) this.loseClaim(err)
          else logger.warn({ err, connection_id: this.connectionId }, 'group update failed')
        }
      }
    })
  }

  private async handleDisconnect(statusCode: number): Promise<void> {
    if (this.stopped) return

    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
      await this.publishState(
        'pairing_required',
        `logged_out:${statusCode}`,
        `logged_out:${statusCode}`
      )
      return
    }

    await this.publishState(
      'degraded',
      `disconnect:${statusCode || 'unknown'}`,
      `disconnect:${statusCode || 'unknown'}`
    )
    const delay = Math.min(
      env.RECONNECT_MAX_DELAY_MS,
      env.RECONNECT_BASE_DELAY_MS * 2 ** Math.min(this.reconnectAttempt++, 8)
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.stopped && !this.lostClaim) void this.openSocket().catch(err => {
        if (err instanceof LostClaimError) this.loseClaim(err)
        else logger.error({ err, connection_id: this.connectionId }, 'reconnect failed')
      })
    }, delay)
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.sock) await this.openSocket()
    return await this.sock!.requestPairingCode(phoneNumber.replace(/\D/g, ''))
  }

  async sendText(chatId: string, text: string): Promise<string> {
    if (!this.sock) throw new Error('connection socket is not running')
    const result = await this.sock.sendMessage(chatId, { text })
    const id = result?.key.id
    if (!id) throw new Error('Baileys sendMessage returned no message id')
    this.apiSentMessageIds.add(id)
    return id
  }

  async unpair(): Promise<void> {
    this.stopped = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.sock) {
      try { await this.sock.logout() }
      catch (err) { logger.warn({ err, connection_id: this.connectionId }, 'logout returned error') }
    }
    await this.auth?.clear()
    this.sock = undefined
    this.qr = undefined
    await this.publishState('pairing_required', 'operator_unpair')
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try { this.sock?.end(undefined) } catch { /* best effort */ }
    this.sock = undefined
  }
}
