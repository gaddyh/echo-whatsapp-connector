import crypto from 'node:crypto'
import { pool } from './pool.js'
import type { ConnectionStatus, NormalizedIdentity } from '../events/types.js'

export interface ConnectionRow {
  id: string
  status: ConnectionStatus
  raw_status: string | null
  phone_number: string | null
  worker_id: string | null
  settings: Record<string, unknown>
}

export async function createConnection(phoneNumber?: string): Promise<ConnectionRow> {
  const id = crypto.randomUUID()
  const res = await pool.query(
    `INSERT INTO whatsapp_connector.connections(id, phone_number)
     VALUES($1,$2)
     RETURNING id,status,raw_status,phone_number,worker_id,settings`,
    [id, phoneNumber ?? null]
  )
  return res.rows[0]
}

export async function getConnection(id: string): Promise<ConnectionRow | null> {
  const res = await pool.query(
    `SELECT id,status,raw_status,phone_number,worker_id,settings
       FROM whatsapp_connector.connections WHERE id=$1`, [id]
  )
  return res.rows[0] ?? null
}

export async function listConnections(): Promise<ConnectionRow[]> {
  const res = await pool.query(
    `SELECT id,status,raw_status,phone_number,worker_id,settings
       FROM whatsapp_connector.connections ORDER BY created_at`
  )
  return res.rows
}

export async function updateConnectionStatus(
  id: string,
  status: ConnectionStatus,
  rawStatus?: string,
  disconnectReason?: string
): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_connector.connections
        SET status=$2, raw_status=$3, updated_at=now(), last_event_at=now(),
            last_connected_at=CASE WHEN $2='connected' THEN now() ELSE last_connected_at END,
            last_disconnect_reason=COALESCE($4,last_disconnect_reason),
            reconnect_count=CASE WHEN $2='reconnecting' THEN reconnect_count+1 ELSE reconnect_count END
      WHERE id=$1`,
    [id, status, rawStatus ?? null, disconnectReason ?? null]
  )
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

export async function upsertIdentity(connectionId: string, identity: NormalizedIdentity): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_connector.identities(
       connection_id, canonical_id, lid, phone_jid, phone_number, push_name, saved_name)
     VALUES($1,$2,$3,$4,$5,$6,NULL)
     ON CONFLICT(connection_id, canonical_id) DO UPDATE SET
       lid=COALESCE(EXCLUDED.lid, whatsapp_connector.identities.lid),
       phone_jid=COALESCE(EXCLUDED.phone_jid, whatsapp_connector.identities.phone_jid),
       phone_number=COALESCE(EXCLUDED.phone_number, whatsapp_connector.identities.phone_number),
       push_name=COALESCE(EXCLUDED.push_name, whatsapp_connector.identities.push_name),
       updated_at=now()`,
    [
      connectionId,
      identity.canonical_id,
      identity.lid ?? null,
      identity.phone_jid ?? null,
      identity.phone_number ?? null,
      identity.display_name ?? null
    ]
  )
}

export async function upsertGroup(
  connectionId: string,
  groupJid: string,
  subject?: string,
  ownerJid?: string
): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_connector.groups(connection_id, group_jid, subject, owner_jid)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(connection_id, group_jid) DO UPDATE SET
       subject=COALESCE(EXCLUDED.subject, whatsapp_connector.groups.subject),
       owner_jid=COALESCE(EXCLUDED.owner_jid, whatsapp_connector.groups.owner_jid),
       updated_at=now()`,
    [connectionId, groupJid, subject ?? null, ownerJid ?? null]
  )
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
