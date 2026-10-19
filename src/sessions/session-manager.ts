import QRCode from 'qrcode'
import { env } from '../config/env.js'
import { INSTANCE_ID } from '../config/process-identity.js'
import { pool } from '../db/pool.js'
import {
  assignWorker,
  claimConnection,
  createConnection,
  deleteConnectionRow,
  getConnection,
  isRetryableDatabaseError,
  listConnections,
  releaseClaim
} from '../db/repositories.js'
import { logger } from '../observability/logger.js'
import { Session, type SessionLossReason, type SessionRuntimeState } from './session.js'

type ConnectionRow = Awaited<ReturnType<typeof getConnection>> extends infer T
  ? Exclude<T, null>
  : never

const RECOVERY_JITTER_RATIO = 0.25

class ClaimUnavailableError extends Error {}
class RecoveryNotAllowedError extends Error {}

export interface ConnectionRuntimeStatus {
  connection_id: string
  status: string
  persistent_status: ConnectionRow['status'] | null
  provider_raw_status: string | null
  phone_number?: string | null
  account_phone_number?: string | null
  worker_id: string | null
  runtime_state: SessionRuntimeState | 'recovering'
  claim_expires_at: Date | null
  lease_valid: boolean | null
  session_present: boolean
  socket_present: boolean
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly restoreTimers = new Map<string, NodeJS.Timeout>()
  private readonly recoveryAttempts = new Map<string, number>()
  private readonly recoveryGenerations = new Map<string, number>()
  private readonly recoveryTokens = new Map<string, string>()
  private readonly starting = new Map<string, Promise<Session>>()
  private readonly runtimeStates = new Map<string, SessionRuntimeState>()
  private shuttingDown = false

  private nextRecoveryGeneration(connectionId: string): number {
    const generation = (this.recoveryGenerations.get(connectionId) ?? 0) + 1
    this.recoveryGenerations.set(connectionId, generation)
    return generation
  }

  private cancelRecovery(connectionId: string): void {
    const timer = this.restoreTimers.get(connectionId)
    if (timer) clearTimeout(timer)
    this.restoreTimers.delete(connectionId)
    this.nextRecoveryGeneration(connectionId)
    this.recoveryAttempts.delete(connectionId)
    this.recoveryTokens.delete(connectionId)
  }

  private recoveryDelay(connectionId: string): number {
    const attempt = this.recoveryAttempts.get(connectionId) ?? 0
    const base = Math.min(
      env.RECOVERY_BACKOFF_MAX_MS,
      env.RECOVERY_BACKOFF_INITIAL_MS * 2 ** Math.min(attempt, 8)
    )
    this.recoveryAttempts.set(connectionId, attempt + 1)
    const jitter = Math.floor(base * RECOVERY_JITTER_RATIO * Math.random())
    return Math.min(env.RECOVERY_BACKOFF_MAX_MS, base + jitter)
  }

  private shouldRetryRecovery(err: unknown): boolean {
    return err instanceof ClaimUnavailableError || isRetryableDatabaseError(err)
  }

  private scheduleRestore(
    connectionId: string,
    delayMs?: number,
    state: SessionRuntimeState = 'degraded'
  ): void {
    if (this.shuttingDown || this.restoreTimers.has(connectionId)) return
    const generation = this.nextRecoveryGeneration(connectionId)
    const delay = delayMs ?? this.recoveryDelay(connectionId)
    this.runtimeStates.set(connectionId, state)
    const timer = setTimeout(() => {
      this.restoreTimers.delete(connectionId)
      if (this.shuttingDown || this.recoveryGenerations.get(connectionId) !== generation) return
      this.runtimeStates.set(connectionId, 'starting')
      void this.start(connectionId, true).then(() => {
        this.recoveryAttempts.delete(connectionId)
      }).catch(err => {
        if (err instanceof RecoveryNotAllowedError) {
          this.runtimeStates.set(connectionId, 'stopped')
          return
        }
        if (this.shouldRetryRecovery(err)) {
          logger.debug({ err, connection_id: connectionId }, 'connection recovery retry scheduled')
          this.scheduleRestore(connectionId)
          return
        }
        this.runtimeStates.set(connectionId, 'degraded')
        logger.warn({ err, connection_id: connectionId }, 'connection recovery stopped')
      })
    }, delay)
    this.restoreTimers.set(connectionId, timer)
    logger.info({ connection_id: connectionId, delay_ms: delay, generation }, 'connection recovery scheduled')
  }

  private onLostClaim(connectionId: string, session: Session, reason: SessionLossReason, err?: unknown): void {
    if (this.sessions.get(connectionId) === session) this.sessions.delete(connectionId)
    this.recoveryTokens.set(connectionId, session.capability)
    const runtimeState: SessionRuntimeState = reason === 'claim_unverified' ? 'claim_unverified' : 'degraded'
    this.runtimeStates.set(connectionId, runtimeState)
    logger.warn({ err, connection_id: connectionId, reason }, 'scheduling connection recovery')
    this.scheduleRestore(connectionId, undefined, runtimeState)
    void session.stop()
  }

  private async startSession(connectionId: string, automatic: boolean): Promise<Session> {
    if (this.sessions.size >= env.MAX_SESSIONS) throw new Error('worker session capacity reached')
    const row = await getConnection(connectionId)
    if (!row) throw new Error('connection not found')
    if (automatic && (row.status === 'pairing_required' || row.worker_id !== env.WORKER_ID)) {
      throw new RecoveryNotAllowedError('connection is not eligible for automatic recovery')
    }
    const previousToken = automatic ? this.recoveryTokens.get(connectionId) : undefined
    const claimToken = await claimConnection(connectionId, INSTANCE_ID, previousToken)
    if (!claimToken) throw new ClaimUnavailableError('connection is owned by another worker process')
    this.recoveryTokens.delete(connectionId)

    let session: Session
    const onLostClaim = (reason: SessionLossReason, err?: unknown) => {
      this.onLostClaim(connectionId, session, reason, err)
    }
    session = new Session(connectionId, pool, claimToken, onLostClaim)
    this.sessions.set(connectionId, session)
    this.runtimeStates.set(connectionId, 'starting')
    try {
      await assignWorker(connectionId, env.WORKER_ID)
      await session.start()
      logger.info({ connection_id: connectionId, instance_id: INSTANCE_ID }, 'connection claim reacquired')
      return session
    } catch (err) {
      this.sessions.delete(connectionId)
      this.runtimeStates.set(connectionId, 'degraded')
      if (automatic) this.recoveryTokens.set(connectionId, claimToken)
      await session.stop()
      try { await releaseClaim(connectionId, INSTANCE_ID, claimToken) }
      catch (releaseErr) { logger.warn({ err: releaseErr, connection_id: connectionId }, 'failed to release startup claim') }
      throw err
    }
  }

  async restoreAssigned(): Promise<void> {
    const rows = await listConnections()
    const candidates = rows.filter(r => r.worker_id === env.WORKER_ID && r.status !== 'pairing_required')
    for (let i = 0; i < Math.min(candidates.length, env.MAX_SESSIONS); i++) {
      const row = candidates[i]!
      const delay = i * env.SESSION_START_STAGGER_MS
      this.scheduleRestore(row.id, delay)
    }
  }

  async create(phoneNumber?: string): Promise<{ connection_id: string; status: string }> {
    const row = await createConnection(phoneNumber)
    await assignWorker(row.id, env.WORKER_ID)
    await this.start(row.id)
    return { connection_id: row.id, status: row.status }
  }

  async start(connectionId: string, automatic = false): Promise<Session> {
    const existing = this.sessions.get(connectionId)
    if (existing) return existing
    const inFlight = this.starting.get(connectionId)
    if (inFlight) return inFlight
    const promise = this.startSession(connectionId, automatic)
    this.starting.set(connectionId, promise)
    try {
      return await promise
    } finally {
      if (this.starting.get(connectionId) === promise) this.starting.delete(connectionId)
    }
  }

  async restart(connectionId: string): Promise<void> {
    this.cancelRecovery(connectionId)
    const existing = this.sessions.get(connectionId)
    if (existing) {
      await existing.stop()
      this.sessions.delete(connectionId)
      try { await releaseClaim(connectionId, INSTANCE_ID, existing.capability) }
      catch (err) { logger.warn({ err, connection_id: connectionId }, 'failed to release restart claim') }
    }
    await this.start(connectionId)
  }

  private runtimeStatus(row: ConnectionRow): ConnectionRuntimeStatus {
    const session = this.sessions.get(row.id)
    const runtimeState = session?.runtimeState ?? (
      this.restoreTimers.has(row.id) ? 'recovering' : this.runtimeStates.get(row.id) ?? 'stopped'
    )
    const leaseValid = row.claim_expires_at !== null && row.claim_expires_at.getTime() > Date.now()
    const healthy = row.status !== 'pairing_required'
      && runtimeState === 'healthy'
      && leaseValid
      && session?.socket !== undefined
      && !this.restoreTimers.has(row.id)
    const status = row.status === 'pairing_required'
      ? row.status
      : healthy
        ? row.status
        : runtimeState === 'recovering' || runtimeState === 'starting'
          ? 'connecting'
          : 'degraded'
    return {
      connection_id: row.id,
      status,
      persistent_status: row.status,
      provider_raw_status: row.raw_status,
      phone_number: row.phone_number,
      account_phone_number: session?.authenticatedPhoneNumber ?? row.account_phone_number,
      worker_id: row.worker_id,
      runtime_state: runtimeState,
      claim_expires_at: row.claim_expires_at,
      lease_valid: leaseValid,
      session_present: session !== undefined,
      socket_present: session?.socket !== undefined
    }
  }

  private localRuntimeStatus(connectionId: string): ConnectionRuntimeStatus | null {
    const session = this.sessions.get(connectionId)
    const runtimeState = session?.runtimeState ?? this.runtimeStates.get(connectionId)
    if (!runtimeState) return null
    return {
      connection_id: connectionId,
      status: 'degraded',
      persistent_status: null,
      provider_raw_status: null,
      worker_id: env.WORKER_ID,
      runtime_state: runtimeState === 'healthy' ? 'claim_unverified' : runtimeState,
      claim_expires_at: null,
      lease_valid: null,
      session_present: session !== undefined,
      socket_present: session?.socket !== undefined
    }
  }

  async status(connectionId: string): Promise<ConnectionRuntimeStatus | null> {
    try {
      const row = await getConnection(connectionId)
      return row ? this.runtimeStatus(row) : null
    } catch (err) {
      if (!isRetryableDatabaseError(err)) throw err
      return this.localRuntimeStatus(connectionId)
    }
  }

  async listStatus(): Promise<ConnectionRuntimeStatus[]> {
    const rows = await listConnections()
    return rows.map(row => this.runtimeStatus(row))
  }

  async qr(connectionId: string) {
    const session = await this.start(connectionId)
    const qr = session.latestQr
    if (!qr) {
      const row = await getConnection(connectionId)
      return row?.status === 'connected'
        ? { outcome: 'already_authorized' as const }
        : { outcome: 'timeout' as const, message: 'QR not available yet' }
    }
    const dataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M' })
    return {
      outcome: 'qr_ready' as const,
      image_base64: dataUrl.replace(/^data:image\/png;base64,/, '')
    }
  }

  async pairingCode(connectionId: string, phoneNumber: string): Promise<string> {
    const session = await this.start(connectionId)
    return session.requestPairingCode(phoneNumber)
  }

  async sendText(connectionId: string, chatId: string, text: string): Promise<string> {
    const session = await this.start(connectionId)
    return session.sendText(chatId, text)
  }

  async downloadMedia(connectionId: string, reference: string): Promise<{ bytes: Buffer; mimeType?: string; fileName?: string }> {
    const session = await this.start(connectionId)
    return session.downloadMedia(reference)
  }

  async unpair(connectionId: string): Promise<void> {
    this.cancelRecovery(connectionId)
    const session = await this.start(connectionId)
    await session.unpair()
    this.sessions.delete(connectionId)
    await releaseClaim(connectionId, INSTANCE_ID, session.capability)
    this.runtimeStates.set(connectionId, 'stopped')
  }

  async remove(connectionId: string): Promise<void> {
    this.cancelRecovery(connectionId)
    const session = this.sessions.get(connectionId)
    if (session) {
      await session.stop()
      this.sessions.delete(connectionId)
      try { await releaseClaim(connectionId, INSTANCE_ID, session.capability) }
      catch (err) { logger.warn({ err, connection_id: connectionId }, 'failed to release removal claim') }
    }
    this.runtimeStates.delete(connectionId)
    await deleteConnectionRow(connectionId)
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    logger.info({ sessions: this.sessions.size }, 'stopping sessions')
    for (const timer of this.restoreTimers.values()) clearTimeout(timer)
    this.restoreTimers.clear()
    for (const connectionId of this.recoveryGenerations.keys()) this.nextRecoveryGeneration(connectionId)
    const sessions = [...this.sessions.values()]
    await Promise.allSettled(sessions.map(async session => {
      await session.stop()
      try { await releaseClaim(session.connectionId, INSTANCE_ID, session.capability) }
      catch (err) { logger.warn({ err, connection_id: session.connectionId }, 'failed to release shutdown claim') }
    }))
    this.sessions.clear()
    this.starting.clear()
  }
}

export const sessionManager = new SessionManager()
