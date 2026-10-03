import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationState,
  type SignalDataTypeMap
} from '@whiskeysockets/baileys'
import type { Pool } from 'pg'
import { decrypt, encrypt } from './crypto.js'
import { LostClaimError } from '../db/repositories.js'

function encode(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8')
}

function decode<T>(value: Buffer): T {
  return JSON.parse(decrypt(value).toString('utf8'), BufferJSON.reviver) as T
}

export async function createPostgresAuthState(
  db: Pool,
  connectionId: string,
  claimToken: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; clear: () => Promise<void> }> {
  const assertClaim = async (client: Pick<Pool, 'query'>): Promise<void> => {
    const result = await client.query(
      `SELECT 1 FROM whatsapp_connector.connections
        WHERE id=$1 AND claim_token=$2::uuid AND claim_expires_at > now()
        FOR UPDATE`,
      [connectionId, claimToken]
    )
    if (result.rowCount !== 1) throw new LostClaimError(connectionId)
  }
  const credsRes = await db.query(
    'SELECT encrypted_payload FROM whatsapp_connector.auth_credentials WHERE connection_id=$1',
    [connectionId]
  )

  const creds = credsRes.rowCount
    ? decode<AuthenticationState['creds']>(credsRes.rows[0].encrypted_payload)
    : initAuthCreds()

  const keys: AuthenticationState['keys'] = {
    get: async (type, ids) => {
      if (!ids.length) return {}
      const res = await db.query(
        `SELECT key_id, encrypted_payload
           FROM whatsapp_connector.auth_keys
          WHERE connection_id=$1 AND category=$2 AND key_id = ANY($3::text[])`,
        [connectionId, type, ids]
      )
      const out: Record<string, unknown> = {}
      for (const row of res.rows) out[row.key_id] = decode(row.encrypted_payload)
      return out as { [id: string]: SignalDataTypeMap[typeof type] }
    },
    set: async data => {
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await assertClaim(client)
        for (const [category, entries] of Object.entries(data)) {
          for (const [keyId, value] of Object.entries(entries ?? {})) {
            if (value == null) {
              await client.query(
                `DELETE FROM whatsapp_connector.auth_keys
                  WHERE connection_id=$1 AND category=$2 AND key_id=$3`,
                [connectionId, category, keyId]
              )
            } else {
              await client.query(
                `INSERT INTO whatsapp_connector.auth_keys(connection_id, category, key_id, encrypted_payload)
                 VALUES($1,$2,$3,$4)
                 ON CONFLICT(connection_id, category, key_id)
                 DO UPDATE SET encrypted_payload=EXCLUDED.encrypted_payload, updated_at=now()`,
                [connectionId, category, keyId, encrypt(encode(value))]
              )
            }
          }
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    }
  }

  const state: AuthenticationState = { creds, keys }

  const saveCreds = async () => {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await assertClaim(client)
      await client.query(
        `INSERT INTO whatsapp_connector.auth_credentials(connection_id, encrypted_payload)
         VALUES($1,$2)
         ON CONFLICT(connection_id)
         DO UPDATE SET encrypted_payload=EXCLUDED.encrypted_payload, updated_at=now()`,
        [connectionId, encrypt(encode(state.creds))]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  const clear = async () => {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await assertClaim(client)
      await client.query('DELETE FROM whatsapp_connector.auth_keys WHERE connection_id=$1', [connectionId])
      await client.query('DELETE FROM whatsapp_connector.auth_credentials WHERE connection_id=$1', [connectionId])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  return { state, saveCreds, clear }
}
