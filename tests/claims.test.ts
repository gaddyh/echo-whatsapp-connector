import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const clientQuery = vi.fn()
const client = { query: clientQuery, release: vi.fn() }

vi.mock('../src/db/pool.js', () => ({
  pool: { query, connect: vi.fn(async () => client) }
}))

const {
  assignWorker,
  claimConnection,
  createConnection,
  deleteConnectionRow,
  findIdentityName,
  getConnection,
  getGroupSubject,
  getMediaBlob,
  listConnections,
  isRetryableDatabaseError,
  LostClaimError,
  releaseClaim,
  renewClaim,
  saveMediaBlob,
  updateConnectionPhone,
  updateConnectionSettings,
  updateConnectionStatus,
  updateConnectionStatusAndEvent,
  upsertGroup,
  upsertIdentity
} = await import('../src/db/repositories.js')

describe('connection claims', () => {
  beforeEach(() => {
    query.mockReset()
    clientQuery.mockReset()
    client.release.mockReset()
  })

  it('returns a new token when an expired claim is acquired', async () => {
    query.mockResolvedValueOnce({ rows: [{ claim_token: 'new-token' }] })

    await expect(claimConnection('connection-id', 'instance-a')).resolves.toBe('new-token')
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]![0]).toContain('claim_expires_at IS NULL OR claim_expires_at <= now()')
  })

  it('returns the existing token for the same live owner without replacing it', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ claim_token: 'existing-token' }] })

    await expect(claimConnection('connection-id', 'instance-a')).resolves.toBe('existing-token')
    expect(query.mock.calls[1]![0]).toContain('claim_owner=$2')
    expect(query.mock.calls[1]![0]).toContain('claim_expires_at > now()')
  })

  it('rotates a known stale token for recovery before its lease expires', async () => {
    query.mockResolvedValueOnce({ rows: [{ claim_token: 'fresh-token' }] })

    await expect(claimConnection('connection-id', 'instance-a', 'stale-token')).resolves.toBe('fresh-token')
    expect(query.mock.calls[0]![0]).toContain('claim_token=$5::uuid')
  })

  it('denies another live owner', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    await expect(claimConnection('connection-id', 'instance-b')).resolves.toBeNull()
  })

  it('renews and releases only the exact capability', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 })
    await expect(renewClaim('connection-id', 'instance-a', 'token')).resolves.toBe(true)
    expect(query.mock.calls[0]![0]).toContain('claim_token=$3::uuid')
    expect(query.mock.calls[0]![0]).toContain("set_config('statement_timeout'")
    expect(query.mock.calls[0]![1]?.[4]).toBe('5000ms')

    query.mockResolvedValueOnce({ rowCount: 0 })
    await expect(releaseClaim('connection-id', 'instance-a', 'token')).resolves.toBeUndefined()
    expect(query.mock.calls[1]![0]).toContain('claim_token=$3::uuid')
  })

  it('classifies database transport failures as retryable', () => {
    expect(isRetryableDatabaseError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRetryableDatabaseError({ code: '57P01' })).toBe(true)
    expect(isRetryableDatabaseError({ code: '23505' })).toBe(false)
    expect(isRetryableDatabaseError(new Error('unknown'))).toBe(false)
  })

  it('supports connection and administrative repository operations', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'id', status: 'provisioning', raw_status: null, phone_number: null, worker_id: null, settings: {} }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'id' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'id' }] })
      .mockResolvedValueOnce({ rows: [{ display_name: 'Alice' }] })
      .mockResolvedValueOnce({ rows: [{ subject: 'Family' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })

    await createConnection('123')
    await assignWorker('id', 'worker')
    expect(await getConnection('id')).toBeTruthy()
    expect(await listConnections()).toHaveLength(1)
    expect(await findIdentityName('id', 'alice')).toBe('Alice')
    expect(await getGroupSubject('id', 'group')).toBe('Family')
    await updateConnectionSettings('id', { webhook_url: 'https://example.test' })
    await deleteConnectionRow('id')
    await updateConnectionStatus('id', 'token', 'connected', 'open')

    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ state_version: '4' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
    const stateEvent = await updateConnectionStatusAndEvent('id', 'token', 'connected', 'open')
    expect(stateEvent).toMatchObject({
      event_type: 'connection_state',
      state_version: 4
    })
    expect(typeof stateEvent.state_version).toBe('number')
    clientQuery.mockReset()
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
    await upsertIdentity('id', 'token', { canonical_id: 'alice' })
    await upsertGroup('id', 'token', 'group', 'Family')

    query.mockReset()
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    await createConnection()
    await expect(getConnection('missing')).resolves.toBeNull()
    await expect(findIdentityName('id', 'missing')).resolves.toBeUndefined()
    await expect(getGroupSubject('id', 'missing')).resolves.toBeUndefined()
  })

  it('raises LostClaimError when a fenced write is rejected', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 })
    await expect(updateConnectionStatus('id', 'stale-token', 'connected')).rejects.toBeInstanceOf(LostClaimError)

    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
    await expect(updateConnectionStatusAndEvent('id', 'stale-token', 'connected')).rejects.toBeInstanceOf(LostClaimError)

    clientQuery.mockReset()
    clientQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({})
    await expect(upsertIdentity('id', 'stale-token', { canonical_id: 'alice' })).rejects.toBeInstanceOf(LostClaimError)
    query.mockResolvedValueOnce({ rowCount: 0 })
    await expect(upsertGroup('id', 'stale-token', 'group')).rejects.toBeInstanceOf(LostClaimError)
  })

  it('exposes a distinct lost-claim error', () => {
    const error = new LostClaimError('connection-id')
    expect(error.name).toBe('LostClaimError')
    expect(error.connectionId).toBe('connection-id')
  })

  it('saves and reads media blobs through the fenced write', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 })
    await saveMediaBlob('id', 'token', 'ref', Buffer.from('data'), 'image/png', 'a.png')
    expect(query.mock.calls[0]![0]).toContain('media_blobs')
    expect(query.mock.calls[0]![1]).toEqual(['id', 'ref', 'image/png', 'a.png', Buffer.from('data'), 4, 'token'])

    query.mockResolvedValueOnce({ rowCount: 0 })
    await expect(saveMediaBlob('id', 'stale-token', 'ref', Buffer.from('data')))
      .rejects.toBeInstanceOf(LostClaimError)

    query.mockResolvedValueOnce({
      rows: [{ content: Buffer.from('data'), mime_type: 'image/png', file_name: 'a.png', size_bytes: 4 }]
    })
    await expect(getMediaBlob('id', 'ref')).resolves.toEqual({
      content: Buffer.from('data'), mimeType: 'image/png', fileName: 'a.png', sizeBytes: 4
    })

    query.mockResolvedValueOnce({ rows: [{ content: Buffer.from('data'), mime_type: null, file_name: null, size_bytes: null }] })
    await expect(getMediaBlob('id', 'ref')).resolves.toEqual({ content: Buffer.from('data') })

    query.mockResolvedValueOnce({ rows: [] })
    await expect(getMediaBlob('id', 'missing')).resolves.toBeNull()
  })

  it('updates the account phone only for the claim owner', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 })
    await updateConnectionPhone('id', 'token', '972501234567')
    expect(query.mock.calls[0]![0]).toContain('account_phone_number')

    query.mockResolvedValueOnce({ rowCount: 0 })
    await expect(updateConnectionPhone('id', 'stale-token', '972501234567'))
      .rejects.toBeInstanceOf(LostClaimError)
  })

  it('repoints a row matched by LID to the new canonical id instead of inserting', async () => {
    clientQuery
      .mockResolvedValueOnce({})                    // BEGIN
      .mockResolvedValueOnce({ rowCount: 1 })       // claim check
      .mockResolvedValueOnce({                      // SELECT: lid-only match
        rows: [{ canonical_id: 'old-canonical', phone_jid: null, saved_name: 'Saved', push_name: 'Push' }]
      })
      .mockResolvedValueOnce({})                    // UPDATE
      .mockResolvedValueOnce({})                    // COMMIT

    await upsertIdentity('id', 'token', {
      canonical_id: 'new-canonical',
      lid: '1234@s.lid',
      display_name: 'Alice'
    })

    const updateCall = clientQuery.mock.calls[3]!
    expect(updateCall[0]).toContain('UPDATE whatsapp_connector.identities')
    expect(updateCall[1]).toEqual([
      'id',
      'new-canonical',
      '1234@s.lid',
      null,
      null,
      'Alice',
      'Saved',
      'old-canonical'
    ])
    expect(clientQuery).toHaveBeenLastCalledWith('COMMIT')
  })

  it('merges rows matched by canonical id and phone jid before updating', async () => {
    clientQuery
      .mockResolvedValueOnce({})                    // BEGIN
      .mockResolvedValueOnce({ rowCount: 1 })       // claim check
      .mockResolvedValueOnce({                      // SELECT: canonical + phone match distinct rows
        rows: [
          { canonical_id: 'alice', phone_jid: 'alice@s.whatsapp.net', saved_name: null, push_name: 'Alice' },
          { canonical_id: 'bob', phone_jid: 'bob@s.whatsapp.net', saved_name: null, push_name: 'Bob' }
        ]
      })
      .mockResolvedValueOnce({})                    // DELETE merged phone row
      .mockResolvedValueOnce({})                    // UPDATE
      .mockResolvedValueOnce({})                    // COMMIT

    await upsertIdentity('id', 'token', {
      canonical_id: 'alice',
      phone_jid: 'bob@s.whatsapp.net',
      phone_number: '972501234567'
    })

    const deleteCall = clientQuery.mock.calls[3]!
    expect(deleteCall[0]).toContain('DELETE FROM whatsapp_connector.identities')
    expect(deleteCall[1]).toEqual(['id', 'bob'])

    const updateCall = clientQuery.mock.calls[4]!
    expect(updateCall[0]).toContain('UPDATE whatsapp_connector.identities')
    expect(updateCall[1][7]).toBe('alice')
    expect(clientQuery).toHaveBeenLastCalledWith('COMMIT')
  })

  it('rolls back when the state version is not a safe integer', async () => {
    clientQuery
      .mockResolvedValueOnce({})                                        // BEGIN
      .mockResolvedValueOnce({ rows: [{ state_version: 'not-a-number' }] }) // UPDATE ... RETURNING
    await expect(updateConnectionStatusAndEvent('id', 'token', 'connected'))
      .rejects.toThrow('invalid state version for connection id')
    expect(clientQuery).toHaveBeenLastCalledWith('ROLLBACK')
  })
})
