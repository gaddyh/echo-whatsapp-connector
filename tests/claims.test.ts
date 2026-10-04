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
  listConnections,
  LostClaimError,
  releaseClaim,
  renewClaim,
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

    query.mockResolvedValueOnce({ rowCount: 0 })
    await expect(releaseClaim('connection-id', 'instance-a', 'token')).resolves.toBeUndefined()
    expect(query.mock.calls[1]![0]).toContain('claim_token=$3::uuid')
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

    query.mockResolvedValueOnce({ rowCount: 0 })
    await expect(upsertIdentity('id', 'stale-token', { canonical_id: 'alice' })).rejects.toBeInstanceOf(LostClaimError)
    query.mockResolvedValueOnce({ rowCount: 0 })
    await expect(upsertGroup('id', 'stale-token', 'group')).rejects.toBeInstanceOf(LostClaimError)
  })

  it('exposes a distinct lost-claim error', () => {
    const error = new LostClaimError('connection-id')
    expect(error.name).toBe('LostClaimError')
    expect(error.connectionId).toBe('connection-id')
  })
})
