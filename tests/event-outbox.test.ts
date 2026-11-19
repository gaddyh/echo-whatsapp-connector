import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const insertEventUnfenced = vi.hoisted(() => vi.fn())

vi.mock('../src/events/sink.js', () => ({ insertEventUnfenced }))
vi.mock('../src/observability/logger.js', () => ({
  logger: { child: vi.fn(() => ({})), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
}))

const mockEnv = vi.hoisted(() => ({
  EVENT_OUTBOX_DIR: './data',
  EVENT_OUTBOX_MAX_EVENTS: 3,
  EVENT_OUTBOX_HARD_MAX_EVENTS: 5,
  EVENT_OUTBOX_DRAIN_MS: 30_000
}))
vi.mock('../src/config/env.js', () => ({ env: mockEnv }))

import { EventOutbox, runOutboxDrain, getOutbox, startOutboxDrainer, stopOutboxDrainer } from '../src/events/outbox.js'
import type { NormalizedMessageEvent } from '../src/events/types.js'

let dir: string

function event(n: number): NormalizedMessageEvent {
  return {
    schema_version: 1,
    event_type: 'message',
    event_id: `evt-${n}`,
    provider: 'baileys',
    connection_id: 'conn-1',
    chat_id: 'c@x',
    provider_message_id: `m-${n}`,
    direction: 'inbound',
    timestamp: new Date().toISOString(),
    kind: 'text',
    is_group: false
  } as unknown as NormalizedMessageEvent
}

function fresh(): EventOutbox {
  return new EventOutbox(dir, 3, 5)
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'))
  mockEnv.EVENT_OUTBOX_DIR = dir
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('event outbox', () => {
  it('appends, reads back and deletes (RC-1 mechanics)', () => {
    const outbox = fresh()
    outbox.append(event(1))
    outbox.append(event(2))

    const pending = outbox.pending(10)
    expect(pending).toHaveLength(2)
    expect(pending[0]!.event_id).toBe('evt-1')

    outbox.delete('conn-1', 'evt-1')
    expect(outbox.pending(10).map(r => r.event_id)).toEqual(['evt-2'])
  })

  it('is idempotent per (connection_id, event_id)', () => {
    const outbox = fresh()
    outbox.append(event(1))
    outbox.append(event(1))
    expect(outbox.count()).toBe(1)
  })

  it('survives a process restart on the same file (RC-1)', () => {
    const first = fresh()
    first.append(event(1))
    first.append(event(2))
    first.close()

    const second = fresh()
    expect(second.count()).toBe(2)
    expect(second.pending(10)[0]!.event_id).toBe('evt-1')
  })

  it('refuses appends at the hard limit without evicting (RC-7/RC-12)', () => {
    const outbox = fresh()
    for (let i = 1; i <= 5; i++) expect(outbox.append(event(i))).toBe(true)

    expect(outbox.append(event(6))).toBe(false)
    expect(outbox.count()).toBe(5)
    const ids = outbox.pending(10).map(r => r.event_id)
    expect(ids).not.toContain('evt-6')
  })

  it('drain replays and deletes on success, keeps on failure (RC-8)', async () => {
    const outbox = fresh()
    outbox.append(event(1))
    outbox.append(event(2))

    insertEventUnfenced.mockRejectedValueOnce(new Error('db down'))
    let result = await runOutboxDrain(outbox)
    expect(result.remaining).toBe(2)

    insertEventUnfenced.mockResolvedValue(undefined)
    result = await runOutboxDrain(outbox)
    expect(result.replayed).toBe(2)
    expect(result.remaining).toBe(0)
    expect(outbox.count()).toBe(0)
  })

  it('drain treats FK violation as an auditable terminal drop (RC-4)', async () => {
    const outbox = fresh()
    outbox.append(event(1))
    insertEventUnfenced.mockRejectedValue(
      Object.assign(new Error('fk'), { code: '23503' })
    )
    const result = await runOutboxDrain(outbox)
    expect(result.remaining).toBe(0)
    expect(insertEventUnfenced).toHaveBeenCalledTimes(1)
  })

  it('drain stops the batch on transient failure and retries next tick (RC-8)', async () => {
    const outbox = fresh()
    outbox.append(event(1))
    outbox.append(event(2))
    insertEventUnfenced.mockRejectedValue(new Error('connection refused'))

    const result = await runOutboxDrain(outbox)
    expect(result.remaining).toBe(2)
    expect(insertEventUnfenced).toHaveBeenCalledTimes(1)
  })

  it('replaying an already-published event is a no-op delete (RC-5/RC-2 mechanics)', async () => {
    const outbox = fresh()
    outbox.append(event(1))
    insertEventUnfenced.mockResolvedValue(undefined)
    await runOutboxDrain(outbox)
    expect(insertEventUnfenced).toHaveBeenCalledTimes(1)
    expect(outbox.count()).toBe(0)
  })

  it('exposes health metrics (pending, oldest age, disk bytes)', async () => {
    const outbox = fresh()
    outbox.append(event(1))
    expect(outbox.count()).toBe(1)
    expect(outbox.oldestAgeSeconds()).toBeGreaterThanOrEqual(0)
    expect(outbox.diskBytes()).toBeGreaterThan(0)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(outbox.oldestAgeSeconds()).toBeGreaterThanOrEqual(0)
  })

  it('getOutbox returns a process-wide singleton bound to the env dir', () => {
    expect(getOutbox()).toBe(getOutbox())
    expect(getOutbox().count()).toBe(0)
  })

  it('startOutboxDrainer drains at boot; stop halts the interval', async () => {
    const singleton = getOutbox()
    singleton.append(event(1))
    insertEventUnfenced.mockResolvedValue(undefined)

    startOutboxDrainer()
    await new Promise(resolve => setImmediate(resolve))
    expect(singleton.count()).toBe(0)

    stopOutboxDrainer()
    singleton.append(event(2))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(singleton.count()).toBe(1)
    singleton.delete('conn-1', 'evt-2')
  })

  it('handles a burst of 1000 appends well under a second', () => {
    const outbox = new EventOutbox(dir, 10_000, 20_000)
    const start = Date.now()
    for (let i = 0; i < 1000; i++) {
      outbox.append({
        ...event(i),
        event_id: `evt-burst-${i}`,
        provider_message_id: `m-burst-${i}`
      })
    }
    const elapsed = Date.now() - start
    expect(outbox.count()).toBe(1000)
    expect(elapsed).toBeLessThan(1000)
  })
})
