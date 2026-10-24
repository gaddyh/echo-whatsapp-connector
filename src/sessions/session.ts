import {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  makeWASocket,
  downloadContentFromMessage,
  type WASocket,
  type WAMessage
} from '@whiskeysockets/baileys'
import type { Pool } from 'pg'
import { createPostgresAuthState } from '../auth/postgres-auth-state.js'
import { env } from '../config/env.js'
import { INSTANCE_ID } from '../config/process-identity.js'
import { eventSink } from '../events/sink.js'
import type { ConnectionStatus, NormalizedConnectionEvent } from '../events/types.js'
import { logger } from '../observability/logger.js'
import { normalizeMessage, unwrapMessage } from '../baileys/message-normalizer.js'
import { phoneFromJid } from '../baileys/identity.js'
import { signedMediaUrl } from '../media/signed-urls.js'
import { MediaDownloadError, MediaPayloadIncompleteError, MediaTooLargeError } from '../media/errors.js'
import { normalizeFileLength } from '../media/size.js'
import { resolveWaVersion } from '../baileys/version-provider.js'
import {
  getGroupSubject,
  getMediaBlob,
  isRetryableDatabaseError,
  LostClaimError,
  saveMediaBlob,
  renewClaim,
  updateConnectionStatus,
  updateConnectionStatusAndEvent,
  upsertGroup,
  upsertIdentity,
  updateConnectionPhone
} from '../db/repositories.js'

const RECONNECT_JITTER_RATIO = 0.25

/** Bounded backoff (ms) for transient WhatsApp media download failures. */
const MEDIA_RETRY_DELAYS_MS = [0, 2_000, 5_000]

export type SessionRuntimeState = 'starting' | 'healthy' | 'degraded' | 'claim_unverified' | 'stopped'
export type SessionLossReason = 'claim_lost' | 'claim_unverified'

export class Session {
  private sock?: WASocket
  private auth?: Awaited<ReturnType<typeof createPostgresAuthState>>
  private qr?: string
  private qrIssuedAt?: number
  private pairingProgressAt?: number
  private socketOpening = false
  private socketUsable = false
  private openingPromise?: Promise<void>
  private pairingPreparation?: Promise<void>
  private logoutInFlight?: Promise<void>
  private reconnectAttempt = 0
  private stopped = false
  private lostClaim = false
  private heartbeat?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  private renewalInFlight = false
  private generation = 0
  private runtime: SessionRuntimeState = 'starting'
  private apiSentMessageIds = new Set<string>()
  private readonly mediaMessages = new Map<string, WAMessage>()
  private accountPhoneNumber?: string

  constructor(
    readonly connectionId: string,
    private readonly db: Pool,
    private readonly claimToken: string,
    private readonly onLostClaim: (reason: SessionLossReason, err?: unknown) => void
  ) {
    this.heartbeat = setInterval(() => void this.renew(), 10_000)
  }

  get socket(): WASocket | undefined { return this.sock }
  get latestQr(): string | undefined {
    if (!this.socketUsable || !this.qr || this.qrIssuedAt === undefined) return undefined
    return Date.now() - this.qrIssuedAt <= env.QR_TTL_MS ? this.qr : undefined
  }
  get capability(): string { return this.claimToken }
  get authenticatedPhoneNumber(): string | undefined { return this.accountPhoneNumber }
  get runtimeState(): SessionRuntimeState { return this.runtime }
  get pairingSocketUsable(): boolean { return this.socketUsable }

  private isActive(generation = this.generation): boolean {
    return !this.stopped && !this.lostClaim && generation === this.generation
  }

  private loseClaim(reason: SessionLossReason, err?: unknown): void {
    if (this.lostClaim || this.stopped) return
    this.lostClaim = true
    this.stopped = true
    this.runtime = reason === 'claim_unverified' ? 'claim_unverified' : 'degraded'
    this.generation += 1
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try { this.sock?.end(undefined) } catch { /* best effort */ }
    this.sock = undefined
    this.socketUsable = false
    this.socketOpening = false
    logger.warn({ err, connection_id: this.connectionId, instance_id: INSTANCE_ID, reason }, 'connection ownership lost')
    this.onLostClaim(reason, err)
  }

  private async renew(): Promise<void> {
    if (!this.isActive() || this.renewalInFlight) return
    this.renewalInFlight = true
    try {
      if (!await renewClaim(this.connectionId, INSTANCE_ID, this.claimToken, env.CLAIM_RENEW_TIMEOUT_MS)) {
        this.loseClaim('claim_lost')
      }
    } catch (err) {
      const retryable = isRetryableDatabaseError(err)
      logger.error({ err, connection_id: this.connectionId, retryable }, 'claim renewal failed')
      this.loseClaim('claim_unverified', err)
    } finally {
      this.renewalInFlight = false
    }
  }

  async start(resetLoggedOutAuth = false): Promise<void> {
    this.stopped = false
    this.runtime = 'starting'
    if (resetLoggedOutAuth) {
      const auth = await createPostgresAuthState(this.db, this.connectionId, this.claimToken)
      await auth.clear()
      logger.info(
        { event: 'reconnect.auth_cleared', connection_id: this.connectionId, reason: 'restart' },
        'logged-out connection auth cleared after restart'
      )
    }
    await this.openSocket()
  }

  private async publishState(
    status: ConnectionStatus,
    raw?: string,
    disconnectReason?: string,
    generation = this.generation,
    force = false
  ): Promise<void> {
    if (!force && !this.isActive(generation)) return
    try {
      if (env.EVENT_SINK === 'db') {
        await updateConnectionStatusAndEvent(this.connectionId, this.claimToken, status, raw, disconnectReason)
        return
      }

      await updateConnectionStatus(this.connectionId, this.claimToken, status, raw, disconnectReason)
      const event: NormalizedConnectionEvent = {
        schema_version: 1,
        event_type: 'connection_state',
        event_id: `state:${this.connectionId}:${status}:${Date.now()}`,
        provider: 'baileys',
        connection_id: this.connectionId,
        status,
        provider_raw_status: raw,
        runtime_state: status === 'connected'
          ? 'healthy'
          : status === 'pairing_required'
            ? 'stopped'
            : status === 'degraded'
              ? 'degraded'
              : 'starting',
        timestamp: new Date().toISOString()
      }
      await eventSink.publish(event, this.claimToken, () => this.isActive(generation))
    } catch (err) {
      if (err instanceof LostClaimError) {
        this.loseClaim('claim_lost', err)
        return
      }
      throw err
    }
  }

  private async openSocket(): Promise<void> {
    if (this.openingPromise) return this.openingPromise
    const opening = this.openSocketInternal()
    this.openingPromise = opening
    try {
      await opening
    } finally {
      if (this.openingPromise === opening) this.openingPromise = undefined
    }
  }

  private async openSocketInternal(): Promise<void> {
    if (this.stopped || this.lostClaim) return
    this.socketOpening = true
    const generation = this.generation
    await this.publishState('connecting', 'opening_socket', undefined, generation)
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
    this.socketOpening = false
    this.socketUsable = true
    this.pairingProgressAt = Date.now()

    sock.ev.on('creds.update', async () => {
      try { await this.auth?.saveCreds() }
      catch (err) {
        if (err instanceof LostClaimError) this.loseClaim('claim_lost', err)
        else logger.error({ err, connection_id: this.connectionId }, 'failed to persist credentials')
      }
    })

    sock.ev.on('connection.update', async update => {
      if (!this.isActive(generation)) return
      if (update.qr) {
        this.qr = update.qr
        this.qrIssuedAt = Date.now()
        this.pairingProgressAt = this.qrIssuedAt
        logger.info({ event: 'reconnect.qr_emitted', connection_id: this.connectionId }, 'pairing QR emitted')
        await this.publishState('pairing_required', 'qr_ready', undefined, generation)
      }
      if (update.connection === 'open') {
        this.qr = undefined
        this.qrIssuedAt = undefined
        this.reconnectAttempt = 0
        const accountPhoneNumber = phoneFromJid(sock.user?.id)
        this.accountPhoneNumber = accountPhoneNumber
        if (accountPhoneNumber) {
          try {
            await updateConnectionPhone(
              this.connectionId,
              this.claimToken,
              accountPhoneNumber
            )
            logger.info(
              {
                connection_id: this.connectionId,
                account_phone_number: accountPhoneNumber
              },
              'authenticated WhatsApp account'
            )
          } catch (err) {
            if (err instanceof LostClaimError) this.loseClaim('claim_lost', err)
            else logger.error(
              { err, connection_id: this.connectionId },
              'failed to persist authenticated WhatsApp account phone'
            )
          }
        } else {
          logger.warn(
            { connection_id: this.connectionId },
            'authenticated WhatsApp account has no phone JID'
          )
        }
        this.runtime = 'healthy'
        await this.publishState('connected', 'open', undefined, generation)
        return
      }
      if (update.connection === 'close') {
        this.socketUsable = false
        this.socketOpening = false
        const statusCode = Number((update.lastDisconnect?.error as any)?.output?.statusCode ?? 0)
        const handling = this.handleDisconnect(statusCode, generation)
        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          this.logoutInFlight = handling
        }
        try {
          await handling
        } finally {
          if (this.logoutInFlight === handling) this.logoutInFlight = undefined
        }
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // type === 'notify' = live message, 'append' = history sync replay
      if (type !== 'notify' || !this.isActive(generation)) return
      for (const msg of messages) {
        if (!this.isActive(generation)) return
        const event = normalizeMessage(this.connectionId, msg)
        if (!event) continue
        if (event.media_reference) {
          this.mediaMessages.set(event.media_reference, msg)
          if (env.DOWNLOAD_MEDIA) {
            try {
              // Diagnostic: snapshot the unwrapped message structure to
              // understand why mediaKey is sometimes missing at download time
              // despite the normalizer finding it.
              const rawForDiag = unwrapMessage(msg.message) as Record<string, any>
              const mediaKeys = Object.keys(rawForDiag).filter(k => k.endsWith('Message'))
              const diagFields: Record<string, unknown> = {}
              for (const mk of mediaKeys) {
                const c = rawForDiag[mk]
                if (c && typeof c === 'object') {
                  diagFields[mk] = {
                    has_mediaKey: c.mediaKey != null,
                    has_url: !!c.url,
                    has_directPath: !!c.directPath,
                    has_encFilehash: !!c.encFilehash,
                    has_mediaKeyTimestamp: c.mediaKeyTimestamp != null,
                    mimetype: c.mimetype,
                  }
                }
              }
              logger.info(
                {
                  connection_id: this.connectionId,
                  media_reference: event.media_reference,
                  kind: event.kind,
                  mime: event.media_mime_type,
                  unwrapped_message_types: mediaKeys,
                  diag_fields: diagFields,
                  has_msg_message: !!msg.message,
                  msg_message_keys: msg.message ? Object.keys(msg.message) : null,
                },
                'media ingestion download start'
              )
              const media = await this.downloadMediaMessage(msg)
              logger.info(
                { connection_id: this.connectionId, media_reference: event.media_reference, bytes: media.bytes.length },
                'media ingestion download succeeded'
              )
              await saveMediaBlob(
                this.connectionId,
                this.claimToken,
                event.media_reference,
                media.bytes,
                media.mimeType,
                media.fileName
              )
              event.media_size = media.bytes.length
              logger.info(
                { connection_id: this.connectionId, media_reference: event.media_reference },
                'media ingestion blob persisted'
              )
            } catch (err) {
              if (err instanceof LostClaimError) {
                this.loseClaim('claim_lost', err)
              } else {
                logger.warn(
                  {
                    err,
                    connection_id: this.connectionId,
                    media_reference: event.media_reference,
                    kind: event.kind,
                    error_name: err instanceof Error ? err.name : typeof err,
                    error_message: err instanceof Error ? err.message : String(err),
                  },
                  'media ingestion download or persistence failed'
                )
              }
            }
          }
          event.media_download_url = signedMediaUrl(
            this.connectionId,
            event.media_reference
          )
        }
        if (event.direction === 'outbound' && this.apiSentMessageIds.has(event.provider_message_id)) {
          event.source = 'api'
          this.apiSentMessageIds.delete(event.provider_message_id)
        }
        if (event.sender) {
          try { await upsertIdentity(this.connectionId, this.claimToken, event.sender) }
          catch (err) {
            if (err instanceof LostClaimError) this.loseClaim('claim_lost', err)
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
            if (err instanceof LostClaimError) this.loseClaim('claim_lost', err)
            else logger.warn({ err, connection_id: this.connectionId, chat_id: event.chat_id }, 'group subject lookup failed')
          }
        }
        if (!this.isActive(generation)) return
        try { await eventSink.publish(event, this.claimToken, () => this.isActive(generation)) }
        catch (err) {
          if (err instanceof LostClaimError) this.loseClaim('claim_lost', err)
          else logger.error({ err, connection_id: this.connectionId }, 'event publish failed')
        }
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
          if (err instanceof LostClaimError) this.loseClaim('claim_lost', err)
          else logger.warn({ err, connection_id: this.connectionId }, 'contact upsert failed')
        }
      }
    })

    sock.ev.on('groups.upsert', async groups => {
      for (const g of groups as any[]) {
        try { await upsertGroup(this.connectionId, this.claimToken, g.id, g.subject, g.ownerPn ?? g.owner) }
        catch (err) {
          if (err instanceof LostClaimError) this.loseClaim('claim_lost', err)
          else logger.warn({ err, connection_id: this.connectionId }, 'group upsert failed')
        }
      }
    })

    sock.ev.on('groups.update', async groups => {
      for (const g of groups as any[]) {
        if (!g.id) continue
        try { await upsertGroup(this.connectionId, this.claimToken, g.id, g.subject, g.owner ?? undefined) }
        catch (err) {
          if (err instanceof LostClaimError) this.loseClaim('claim_lost', err)
          else logger.warn({ err, connection_id: this.connectionId }, 'group update failed')
        }
      }
    })
  }

  private async handleDisconnect(statusCode: number, generation = this.generation): Promise<void> {
    if (!this.isActive(generation)) return

    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = undefined
      }
      logger.info({ event: 'reconnect.auth_lost', connection_id: this.connectionId, status_code: statusCode }, 'authenticated connection logged out')
      await this.publishState(
        'pairing_required',
        `logged_out:${statusCode}`,
        `logged_out:${statusCode}`,
        generation
      )
      if (!this.isActive(generation)) return
      await this.auth?.clear()
      logger.info(
        { event: 'reconnect.auth_cleared', connection_id: this.connectionId },
        'logged-out connection auth cleared for pairing'
      )
      if (!this.isActive(generation)) return
      this.generation += 1
      try { this.sock?.end(undefined) } catch { /* best effort */ }
      this.sock = undefined
      this.socketUsable = false
      this.runtime = 'stopped'
      this.qr = undefined
      this.qrIssuedAt = undefined
      return
    }

    this.runtime = 'degraded'
    await this.publishState(
      'degraded',
      `disconnect:${statusCode || 'unknown'}`,
      `disconnect:${statusCode || 'unknown'}`,
      generation
    )
    const base = Math.min(
      env.RECONNECT_MAX_DELAY_MS,
      env.RECONNECT_BASE_DELAY_MS * 2 ** Math.min(this.reconnectAttempt++, 8)
    )
    const delay = Math.floor(base * (1 - RECONNECT_JITTER_RATIO * Math.random()))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.stopped && !this.lostClaim) void this.openSocket().catch(err => {
        if (err instanceof LostClaimError) this.loseClaim('claim_lost', err)
        else logger.error({ err, connection_id: this.connectionId }, 'reconnect failed')
      })
    }, delay)
  }

  async preparePairing(): Promise<void> {
    if (this.pairingPreparation) return this.pairingPreparation
    const preparation = (async () => {
      if (this.logoutInFlight) await this.logoutInFlight
      if (this.stopped || this.lostClaim) return
      if (this.socketOpening) {
        if (this.openingPromise) await this.openingPromise
        return
      }
      if (this.runtime === 'healthy') return
      if (this.socketUsable && this.pairingProgressAt !== undefined &&
          Date.now() - this.pairingProgressAt < env.PAIRING_QR_RECOVERY_MS) {
        logger.info({ event: 'reconnect.pairing_pending', connection_id: this.connectionId }, 'waiting for pairing QR')
        return
      }
      logger.info({ event: 'reconnect.pairing_restarted', connection_id: this.connectionId }, 'restarting unavailable pairing socket')
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = undefined
      }
      this.generation += 1
      try { this.sock?.end(undefined) } catch { /* best effort */ }
      this.sock = undefined
      this.socketUsable = false
      this.socketOpening = false
      this.qr = undefined
      this.qrIssuedAt = undefined
      this.runtime = 'starting'
      await this.openSocket()
    })()
    this.pairingPreparation = preparation
    try {
      await preparation
    } finally {
      if (this.pairingPreparation === preparation) this.pairingPreparation = undefined
    }
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.sock) await this.openSocket()
    return await this.sock!.requestPairingCode(phoneNumber.replace(/\D/g, ''))
  }

  async downloadMedia(reference: string): Promise<{ bytes: Buffer; mimeType?: string; fileName?: string }> {
    logger.info({ connection_id: this.connectionId, reference }, 'on-demand media download start')
    const stored = await getMediaBlob(this.connectionId, reference)
    if (stored) {
      logger.info({ connection_id: this.connectionId, reference, bytes: stored.content.length }, 'on-demand media served from blob cache')
      return { bytes: stored.content, mimeType: stored.mimeType, fileName: stored.fileName }
    }
    const message = this.mediaMessages.get(reference)
    if (!message) {
      logger.warn(
        { connection_id: this.connectionId, reference, media_messages_size: this.mediaMessages.size },
        'on-demand media download failed: message not in in-memory map'
      )
      throw new MediaPayloadIncompleteError('media reference is unavailable')
    }
    logger.info(
      { connection_id: this.connectionId, reference, has_message: !!message.message },
      'on-demand media download: message found in memory, downloading'
    )
    const media = await this.downloadMediaMessage(message)
    // Persist the on-demand download so subsequent requests are served from
    // PostgreSQL instead of re-downloading from WhatsApp. A persist failure
    // is recorded as a visible reliability event but does not withhold the
    // already-downloaded bytes from the caller.
    try {
      await saveMediaBlob(
        this.connectionId,
        this.claimToken,
        reference,
        media.bytes,
        media.mimeType,
        media.fileName
      )
    } catch (err) {
      if (err instanceof LostClaimError) {
        this.loseClaim('claim_lost', err)
        throw err
      }
      logger.error(
        { err, event: 'media.persist_failed', connection_id: this.connectionId, reference },
        'on-demand media download succeeded but persistence failed'
      )
    }
    return media
  }

  private async downloadMediaMessage(msg: WAMessage): Promise<{ bytes: Buffer; mimeType?: string; fileName?: string }> {
    if (!msg.message) throw new MediaPayloadIncompleteError('message does not contain media')
    const raw = unwrapMessage(msg.message) as Record<string, any>
    // Use != null (excludes both null and undefined) because Baileys/protobuf
    // can set absent media fields to null. Using !== undefined would match
    // null fields and pick the wrong media type (e.g. audioMessage: null
    // would be found before videoMessage: {...}).
    const mediaType = ['audio', 'image', 'video', 'document', 'sticker']
      .find(type => raw[`${type}Message`] != null)
    if (!mediaType) throw new MediaPayloadIncompleteError('message does not contain downloadable media')
    const content = raw[`${mediaType}Message`]
    // Defense in depth: animated stickers must never be downloaded as static
    // images. The normalizer classifies them as `other` (no media_reference),
    // so this path is unreachable in the normal flow — but reject explicitly
    // if a sticker payload reaches here directly.
    if (mediaType === 'sticker' && content?.isAnimated === true) {
      throw new MediaPayloadIncompleteError('animated stickers are not supported')
    }
    if (!content || content.mediaKey == null) {
      logger.warn(
        {
          connection_id: this.connectionId,
          media_type: mediaType,
          has_content: !!content,
          has_media_key: !!content?.mediaKey,
          has_url: !!content?.url,
          has_direct_path: !!content?.directPath,
          has_enc_filehash: !!content?.encFilehash,
        },
        'media download rejected: payload incomplete'
      )
      throw new MediaPayloadIncompleteError()
    }
    logger.info(
      {
        connection_id: this.connectionId,
        media_type: mediaType,
        has_url: !!content.url,
        has_direct_path: !!content.directPath,
        // WhatsApp declares the file size on the payload (fileLength). Log it
        // before the stream starts so operators can see the true size even
        // when the download is aborted mid-stream for exceeding the limit.
        // Baileys/protobuf encodes 64-bit fileLength as a Long object at
        // runtime; normalizeFileLength converts it to a plain number.
        declared_file_length: normalizeFileLength(content.fileLength)
      },
      'media download: payload valid, starting download'
    )
    // Bounded retry for transient WhatsApp download failures only.
    // Deterministic failures (missing mediaKey, oversized) throw above or
    // inside the loop and are never retried.
    let lastError: unknown
    for (let attempt = 0; attempt < MEDIA_RETRY_DELAYS_MS.length; attempt++) {
      if (!this.isActive()) throw new MediaDownloadError('connection lease no longer owned')
      if (MEDIA_RETRY_DELAYS_MS[attempt]! > 0) {
        await delay(MEDIA_RETRY_DELAYS_MS[attempt]!)
        if (!this.isActive()) throw new MediaDownloadError('connection lease no longer owned')
      }
      try {
        const stream = await downloadContentFromMessage(content, mediaType as any)
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of stream) {
          const buffer = Buffer.from(chunk)
          size += buffer.length
          if (size > env.MAX_MEDIA_BYTES) {
            throw new MediaTooLargeError(size, env.MAX_MEDIA_BYTES, normalizeFileLength(content.fileLength))
          }
          chunks.push(buffer)
        }
        return {
          bytes: Buffer.concat(chunks),
          mimeType: content.mimetype,
          fileName: content.fileName
        }
      } catch (err) {
        // Deterministic failures fail immediately — no retry.
        if (err instanceof MediaTooLargeError || err instanceof MediaPayloadIncompleteError) throw err
        lastError = err
        logger.warn(
          { err, connection_id: this.connectionId, attempt: attempt + 1, max_attempts: MEDIA_RETRY_DELAYS_MS.length },
          'transient media download attempt failed'
        )
      }
    }
    throw new MediaDownloadError('media download failed after retries', lastError)
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
    this.socketUsable = false
    this.socketOpening = false
    this.qr = undefined
    this.qrIssuedAt = undefined
    await this.publishState('pairing_required', 'operator_unpair', undefined, this.generation, true)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.runtime = 'stopped'
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try { this.sock?.end(undefined) } catch { /* best effort */ }
    this.sock = undefined
    this.socketUsable = false
    this.socketOpening = false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
