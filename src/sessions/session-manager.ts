import QRCode from 'qrcode'
import { env } from '../config/env.js'
import { pool } from '../db/pool.js'
import {
  assignWorker,
  createConnection,
  deleteConnectionRow,
  getConnection,
  listConnections
} from '../db/repositories.js'
import { logger } from '../observability/logger.js'
import { Session } from './session.js'

export class SessionManager {
  private readonly sessions = new Map<string, Session>()

  async restoreAssigned(): Promise<void> {
    const rows = await listConnections()
    const candidates = rows.filter(r => r.worker_id === env.WORKER_ID && r.status !== 'pairing_required')
    for (let i = 0; i < Math.min(candidates.length, env.MAX_SESSIONS); i++) {
      const row = candidates[i]!
      setTimeout(() => void this.start(row.id), i * env.SESSION_START_STAGGER_MS)
    }
  }

  async create(phoneNumber?: string): Promise<{ connection_id: string; status: string }> {
    const row = await createConnection(phoneNumber)
    await assignWorker(row.id, env.WORKER_ID)
    await this.start(row.id)
    return { connection_id: row.id, status: row.status }
  }

  async start(connectionId: string): Promise<Session> {
    const existing = this.sessions.get(connectionId)
    if (existing) return existing
    if (this.sessions.size >= env.MAX_SESSIONS) throw new Error('worker session capacity reached')
    const row = await getConnection(connectionId)
    if (!row) throw new Error('connection not found')
    const session = new Session(connectionId, pool)
    this.sessions.set(connectionId, session)
    await assignWorker(connectionId, env.WORKER_ID)
    try { await session.start() }
    catch (err) {
      this.sessions.delete(connectionId)
      throw err
    }
    return session
  }

  async restart(connectionId: string): Promise<void> {
    const existing = this.sessions.get(connectionId)
    if (existing) {
      await existing.stop()
      this.sessions.delete(connectionId)
    }
    await this.start(connectionId)
  }

  async status(connectionId: string) {
    const row = await getConnection(connectionId)
    if (!row) return null
    return {
      connection_id: row.id,
      status: row.status,
      provider_raw_status: row.raw_status,
      worker_id: row.worker_id
    }
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

  async unpair(connectionId: string): Promise<void> {
    const session = await this.start(connectionId)
    await session.unpair()
  }

  async remove(connectionId: string): Promise<void> {
    const session = this.sessions.get(connectionId)
    if (session) {
      await session.stop()
      this.sessions.delete(connectionId)
    }
    await deleteConnectionRow(connectionId)
  }

  async shutdown(): Promise<void> {
    logger.info({ sessions: this.sessions.size }, 'stopping sessions')
    await Promise.allSettled([...this.sessions.values()].map(s => s.stop()))
    this.sessions.clear()
  }
}

export const sessionManager = new SessionManager()
