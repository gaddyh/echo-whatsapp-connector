import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchLatestWaWebVersion = vi.fn()
const warnLog = vi.fn()
const mockEnv = { WA_WEB_VERSION_OVERRIDE: '' }

vi.mock('@whiskeysockets/baileys', () => ({
  fetchLatestWaWebVersion: (...args: unknown[]) => fetchLatestWaWebVersion(...args)
}))
vi.mock('../src/config/env.js', () => ({ env: mockEnv }))
vi.mock('../src/observability/logger.js', () => ({
  logger: { child: vi.fn(() => ({})), warn: warnLog, error: vi.fn(), info: vi.fn(), debug: vi.fn() }
}))

describe('resolveWaVersion', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    fetchLatestWaWebVersion.mockReset()
    warnLog.mockReset()
    mockEnv.WA_WEB_VERSION_OVERRIDE = ''
    fetchLatestWaWebVersion.mockResolvedValue({ version: [2, 3000, 101], isLatest: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function load() {
    return (await import('../src/baileys/version-provider.js')).resolveWaVersion
  }

  it('returns the pinned override without fetching', async () => {
    mockEnv.WA_WEB_VERSION_OVERRIDE = '2.2500.77'
    const resolveWaVersion = await load()
    await expect(resolveWaVersion()).resolves.toEqual([2, 2500, 77])
    expect(fetchLatestWaWebVersion).not.toHaveBeenCalled()
  })

  it('rejects a malformed override', async () => {
    mockEnv.WA_WEB_VERSION_OVERRIDE = '2.2500'
    const resolveWaVersion = await load()
    await expect(resolveWaVersion()).rejects.toThrow('WA_WEB_VERSION_OVERRIDE')
    expect(fetchLatestWaWebVersion).not.toHaveBeenCalled()
  })

  it('caches a successful fetch across sequential calls', async () => {
    const resolveWaVersion = await load()
    await expect(resolveWaVersion()).resolves.toEqual([2, 3000, 101])
    await expect(resolveWaVersion()).resolves.toEqual([2, 3000, 101])
    expect(fetchLatestWaWebVersion).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent calls into a single fetch', async () => {
    let releaseFetch!: (value: { version: [number, number, number]; isLatest: boolean }) => void
    fetchLatestWaWebVersion.mockReturnValue(
      new Promise(resolve => { releaseFetch = resolve })
    )
    const resolveWaVersion = await load()
    const pending = Promise.all([
      resolveWaVersion(),
      resolveWaVersion(),
      resolveWaVersion()
    ])
    expect(fetchLatestWaWebVersion).toHaveBeenCalledTimes(1)
    releaseFetch({ version: [2, 3000, 202], isLatest: true })
    await expect(pending).resolves.toEqual([
      [2, 3000, 202],
      [2, 3000, 202],
      [2, 3000, 202]
    ])
  })

  it('refetches only after the cache TTL expires', async () => {
    const resolveWaVersion = await load()
    await expect(resolveWaVersion()).resolves.toEqual([2, 3000, 101])

    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
    await expect(resolveWaVersion()).resolves.toEqual([2, 3000, 101])
    expect(fetchLatestWaWebVersion).toHaveBeenCalledTimes(1)

    fetchLatestWaWebVersion.mockResolvedValue({ version: [2, 3000, 202], isLatest: true })
    await vi.advanceTimersByTimeAsync(1)
    await expect(resolveWaVersion()).resolves.toEqual([2, 3000, 202])
    expect(fetchLatestWaWebVersion).toHaveBeenCalledTimes(2)
  })

  it('prefers the last known good version when a refetch fails', async () => {
    const resolveWaVersion = await load()
    await expect(resolveWaVersion()).resolves.toEqual([2, 3000, 101])

    fetchLatestWaWebVersion.mockResolvedValue({
      version: [2, 2000, 1],
      isLatest: false,
      error: new Error('throttled')
    })
    await vi.advanceTimersByTimeAsync(10 * 60_001)
    await expect(resolveWaVersion()).resolves.toEqual([2, 3000, 101])
    expect(warnLog).toHaveBeenCalledOnce()
  })

  it('falls back to the packaged version on a cold fetch failure', async () => {
    fetchLatestWaWebVersion.mockResolvedValue({
      version: [2, 2000, 1],
      isLatest: false,
      error: new Error('network down')
    })
    const resolveWaVersion = await load()
    await expect(resolveWaVersion()).resolves.toEqual([2, 2000, 1])
    expect(warnLog).toHaveBeenCalledOnce()
  })
})
