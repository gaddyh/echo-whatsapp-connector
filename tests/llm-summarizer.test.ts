import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnv: Record<string, unknown> = {
  OPENAI_API_KEY: 'test-key',
  OPENAI_MODEL: 'gpt-test'
}

vi.mock('../src/config/env.js', () => ({ env: mockEnv }))
vi.mock('../src/observability/logger.js', () => ({
  logger: { child: vi.fn(() => ({})), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  logRing: {}
}))

const fetchMock = vi.fn()

function openaiResponse(content: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
}

const VALID_DIGEST = JSON.stringify({
  attention: false,
  happened: [{ title: 'Quiet hour', severity: 'info', detail: 'All healthy' }],
  resolved: [],
  still_open: [],
  one_liner: 'Quiet hour: 7/7 connected, no data loss'
})

describe('llm digest generation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    mockEnv.OPENAI_API_KEY = 'test-key'
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function load() {
    return import('../src/monitor/llm-summarizer.js')
  }

  it('instructs the model to write human-readable fields in English', async () => {
    const { DIGEST_SYSTEM_PROMPT } = await load()
    expect(DIGEST_SYSTEM_PROMPT).toContain('English, concise')
    expect(DIGEST_SYSTEM_PROMPT).not.toContain('Hebrew')
  })

  it('parses a valid model response', async () => {
    fetchMock.mockResolvedValueOnce(openaiResponse(VALID_DIGEST))
    const { generateDigest } = await load()

    const digest = await generateDigest({
      window: { from: 'a', to: 'b' },
      deploy_context: { restarts: 0, graceful_shutdowns: 0, note: '' },
      counters: {},
      peak_recovery_per_min: 0,
      distinct_connections: 0,
      by_connection_anomalous: {},
      warn_error_samples: [],
      log_entries: 0,
      previous_digest: null
    })

    expect(digest.one_liner).toBe('Quiet hour: 7/7 connected, no data loss')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.model).toBe('gpt-test')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages[0].role).toBe('system')
  })

  it('retries once on unparseable output and succeeds on the second try', async () => {
    fetchMock
      .mockResolvedValueOnce(openaiResponse('not json at all'))
      .mockResolvedValueOnce(openaiResponse(VALID_DIGEST))
    const { generateDigest } = await load()

    const digest = await generateDigest({} as never)

    expect(digest.one_liner).toBe('Quiet hour: 7/7 connected, no data loss')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to local rendering when the model is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const { generateDigest } = await load()

    const digest = await generateDigest({
      counters: { publish_dropped: 2, db_unreachable: 0, ownership_lost: 0 },
      previous_digest: { one_liner: 'prev', still_open: [{ id: 'x', title: 't', severity: 'high' }] }
    } as never)

    expect(digest.one_liner).toContain('LLM summarizer failed')
    expect(digest.one_liner).toContain('publish_dropped=2')
    expect(digest.attention).toBe(true)
    expect(digest.still_open).toEqual([{ id: 'x', title: 't', severity: 'high' }])
  })

  it('falls back when openai returns an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    const { generateDigest } = await load()

    const digest = await generateDigest({ counters: {} } as never)

    expect(digest.one_liner).toContain('LLM summarizer failed')
  })

  it('fallback digest flags attention only for data loss or outage counters', async () => {
    const { fallbackDigest } = await load()
    const makePayload = (counters: Record<string, number>): never =>
      ({ counters, previous_digest: null }) as never

    expect(fallbackDigest(makePayload({ publish_dropped: 1 }), 'test').attention).toBe(true)
    expect(fallbackDigest(makePayload({ db_unreachable: 1 }), 'test').attention).toBe(true)
    expect(fallbackDigest(makePayload({ recovery_scheduled: 40 }), 'test').attention).toBe(false)
  })
})
