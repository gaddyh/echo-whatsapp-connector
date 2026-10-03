import crypto from 'node:crypto'
import { pool } from './pool.js'
import {
  connectionStateEventId,
  type ConnectionStatus,
  type NormalizedConnectionEvent,
  type NormalizedIdentity
} from '../events/types.js'

export interface ConnectionRow {
  id: string
  status: ConnectionStatus
  raw_status: string | null
  phone_number: string | null
  worker_id: string | null
  claim_owner: string | null
  claim_token: string | null
  claim_expires_at: Date | null
  settings: Record<string, unknown>
}

export class LostClaimError extends Error {
  constructor(readonly connectionId: string) {
    super(`lost connection claim: ${connectionId}`)
    this.name = 'LostClaimError'
  }
}

export async function createConnection(phoneNumber?: string): Promise<ConnectionRow> {
  const id = crypto.randomUUID()
  const res = await pool.query(
    `INSERT INTO whatsapp_connector.connections(id, phone_number)
     VALUES($1,$2)
     RETURNING id,status,raw_status,phone_number,worker_id,claim_owner,claim_token,claim_expires_at,settings`,
    [id, phoneNumber ?? null]
  )
  return res.rows[0]
}

export async function getConnection(id: string): Promise<ConnectionRow | null> {
  const res = await pool.query(
    `SELECT id,status,raw_status,phone_number,worker_id,claim_owner,claim_token,claim_expires_at,settings
       FROM whatsapp_connector.connections WHERE id=$1`, [id]
  )
  return res.rows[0] ?? null
}

export async function listConnections(): Promise<ConnectionRow[]> {
  const res = await pool.query(
    `SELECT id,status,raw_status,phone_number,worker_id,claim_owner,claim_token,claim_expires_at,settings
       FROM whatsapp_connector.connections ORDER BY created_at`
  )
  return res.rows
}

const CLAIM_TTL_SECONDS = 30

export async function claimConnection(id: string, owner: string): Promise<string | null> {
  const token = crypto.randomUUID()
  const result = await pool.query<{ claim_token: string }>(
    `UPDATE whatsapp_connector.connections
        SET claim_owner=$2, claim_token=$3::uuid,
            claim_expires_at=now() + ($4::text || ' seconds')::interval,
            updated_at=now()
      WHERE id=$1
        AND (claim_expires_at IS NULL OR claim_expires_at <= now())
      RETURNING claim_token`,
    [id, owner, token, CLAIM_TTL_SECONDS]
  )
  if (result.rows[0]?.claim_token) return result.rows[0].claim_token
  const existing = await pool.query<{ claim_token: string }>(
    `SELECT claim_token
       FROM whatsapp_connector.connections
      WHERE id=$1 AND claim_owner=$2 AND claim_expires_at > now()`,
    [id, owner]
  )
  return existing.rows[0]?.claim_token ?? null
}

export async function renewClaim(id: string, owner: string, token: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE whatsapp_connector.connections
        SET claim_expires_at=now() + ($4::text || ' seconds')::interval,
            updated_at=now()
      WHERE id=$1 AND claim_owner=$2 AND claim_token=$3::uuid
        AND claim_expires_at > now()`,
    [id, owner, token, CLAIM_TTL_SECONDS]
  )
  return result.rowCount === 1
}

export async function releaseClaim(id: string, owner: string, token: string): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_connector.connections
        SET claim_owner=NULL, claim_token=NULL, claim_expires_at=NULL, updated_at=now()
      WHERE id=$1 AND claim_owner=$2 AND claim_token=$3::uuid`,
    [id, owner, token]
  )
}

function claimPredicate(start: number): string {
  return `claim_token=$${start}::uuid AND claim_expires_at > now()`
}

export async function updateConnectionStatus(
  id: string,
  token: string,
  status: ConnectionStatus,
  rawStatus?: string,
  disconnectReason?: string
): Promise<void> {
  const result = await pool.query(
    `UPDATE whatsapp_connector.connections
        SET status=$2, raw_status=$3, updated_at=now(), last_event_at=now(),
            last_connected_at=CASE WHEN $2='connected' THEN now() ELSE last_connected_at END,
            last_disconnect_reason=COALESCE($4,last_disconnect_reason),
            reconnect_count=CASE WHEN $2='reconnecting' THEN reconnect_count+1 ELSE reconnect_count END
      WHERE id=$1 AND ${claimPredicate(5)}`,
    [id, status, rawStatus ?? null, disconnectReason ?? null, token]
  )
  if (result.rowCount !== 1) throw new LostClaimError(id)
}

export async function updateConnectionStatusAndEvent(
  id: string,
  token: string,
  status: ConnectionStatus,
  rawStatus?: string,
  disconnectReason?: string
): Promise<NormalizedConnectionEvent> {
  const client = await pool.connect()
  const timestamp = new Date().toISOString()
  try {
    await client.query('BEGIN')
    const result = await client.query<{ state_version: number }>(
      `UPDATE whatsapp_connector.connections
          SET status=$2, raw_status=$3, state_version=state_version+1,
              updated_at=now(), last_event_at=now(),
              last_connected_at=CASE WHEN $2='connected' THEN now() ELSE last_connected_at END,
              last_disconnect_reason=COALESCE($4,last_disconnect_reason),
              reconnect_count=CASE WHEN $2='reconnecting' THEN reconnect_count+1 ELSE reconnect_count END
        WHERE id=$1 AND ${claimPredicate(5)}
        RETURNING state_version`,
      [id, status, rawStatus ?? null, disconnectReason ?? null, token]
    )
    const stateVersion = result.rows[0]?.state_version
    if (stateVersion === undefined) throw new LostClaimError(id)

    const event: NormalizedConnectionEvent = {
      event_type: 'connection_state',
      event_id: connectionStateEventId(id, stateVersion),
      provider: 'baileys',
      connection_id: id,
      status,
      provider_raw_status: rawStatus,
      state_version: stateVersion,
      timestamp
    }
    await client.query(
      `INSERT INTO whatsapp_connector.event_inbox(
         event_id, connection_id, event_type, payload)
       VALUES($1,$2,$3,$4::jsonb)
       ON CONFLICT(connection_id, event_id) DO NOTHING`,
      [event.event_id, id, event.event_type, JSON.stringify(event)]
    )
    await client.query('COMMIT')
    return event
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}


export async function assignWorker(id: string, workerId: string | null): Promise<void> {
  await pool.query(
    'UPDATE whatsapp_connector.connections SET worker_id=$2, updated_at=now() WHERE id=$1',
    [id, workerId]
  )
}


export async function updateConnectionSettings(id: string, settings: Record<string, unknown>): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_connector.connections
        SET settings = settings || $2::jsonb, updated_at=now()
      WHERE id=$1`,
    [id, JSON.stringify(settings)]
  )
}

export async function deleteConnectionRow(id: string): Promise<void> {
  await pool.query('DELETE FROM whatsapp_connector.connections WHERE id=$1', [id])
}

export async function upsertIdentity(connectionId: string, token: string, identity: NormalizedIdentity): Promise<void> {
  const result = await pool.query(
    `INSERT INTO whatsapp_connector.identities(
       connection_id, canonical_id, lid, phone_jid, phone_number, push_name, saved_name)
     SELECT $1,$2,$3,$4,$5,$6,NULL
      WHERE EXISTS (
        SELECT 1 FROM whatsapp_connector.connections
         WHERE id=$1 AND ${claimPredicate(7)}
      )
     ON CONFLICT(connection_id, canonical_id) DO UPDATE SET
       lid=COALESCE(EXCLUDED.lid, whatsapp_connector.identities.lid),
       phone_jid=COALESCE(EXCLUDED.phone_jid, whatsapp_connector.identities.phone_jid),
       phone_number=COALESCE(EXCLUDED.phone_number, whatsapp_connector.identities.phone_number),
       push_name=COALESCE(EXCLUDED.push_name, whatsapp_connector.identities.push_name),
       updated_at=now()
      WHERE EXISTS (
        SELECT 1 FROM whatsapp_connector.connections
         WHERE id=$1 AND ${claimPredicate(7)}
      )`,
    [
      connectionId,
      identity.canonical_id,
      identity.lid ?? null,
      identity.phone_jid ?? null,
      identity.phone_number ?? null,
      identity.display_name ?? null,
      token
    ]
  )
  if (result.rowCount !== 1) throw new LostClaimError(connectionId)
}

export async function upsertGroup(
  connectionId: string,
  token: string,
  groupJid: string,
  subject?: string,
  ownerJid?: string
): Promise<void> {
  const result = await pool.query(
    `INSERT INTO whatsapp_connector.groups(connection_id, group_jid, subject, owner_jid)
     SELECT $1,$2,$3,$4
      WHERE EXISTS (
        SELECT 1 FROM whatsapp_connector.connections
         WHERE id=$1 AND ${claimPredicate(5)}
      )
     ON CONFLICT(connection_id, group_jid) DO UPDATE SET
       subject=COALESCE(EXCLUDED.subject, whatsapp_connector.groups.subject),
       owner_jid=COALESCE(EXCLUDED.owner_jid, whatsapp_connector.groups.owner_jid),
       updated_at=now()
      WHERE EXISTS (
        SELECT 1 FROM whatsapp_connector.connections
         WHERE id=$1 AND ${claimPredicate(5)}
      )`,
    [connectionId, groupJid, subject ?? null, ownerJid ?? null, token]
  )
  if (result.rowCount !== 1) throw new LostClaimError(connectionId)
}

export async function findIdentityName(connectionId: string, canonicalId: string): Promise<string | undefined> {
  const res = await pool.query(
    `SELECT COALESCE(saved_name, push_name) AS display_name
       FROM whatsapp_connector.identities
      WHERE connection_id=$1 AND canonical_id=$2`,
    [connectionId, canonicalId]
  )
  return res.rows[0]?.display_name ?? undefined
}

export async function getGroupSubject(connectionId: string, groupJid: string): Promise<string | undefined> {
  const res = await pool.query(
    'SELECT subject FROM whatsapp_connector.groups WHERE connection_id=$1 AND group_jid=$2',
    [connectionId, groupJid]
  )
  return res.rows[0]?.subject ?? undefined
}
