import { describe, expect, it } from 'vitest'
import { LogRingBuffer } from '../src/observability/log-ring.js'

describe('log ring buffer', () => {
  it('parses JSON lines written through the pino stream', () => {
    const ring = new LogRingBuffer(10)
    const stream = ring.asPinoStream()

    stream.write(JSON.stringify({ level: 30, time: 1000, msg: 'connected to WA', connection_id: 'c1' }))
    stream.write('not json at all')
    stream.write(JSON.stringify({ level: 50, time: 2000 }))

    const drained = ring.drain(0)
    expect(drained).toEqual([
      { level: 30, time: 1000, msg: 'connected to WA', connection_id: 'c1' }
    ])
    expect(ring.size()).toBe(1)
  })

  it('drains only entries at or after the cursor', () => {
    const ring = new LogRingBuffer(10)
    ring.push({ level: 30, time: 1000, msg: 'old' })
    ring.push({ level: 30, time: 2000, msg: 'new' })

    expect(ring.drain(1500)).toEqual([{ level: 30, time: 2000, msg: 'new' }])
    expect(ring.drain(0)).toHaveLength(2)
  })

  it('drops the oldest entries at capacity', () => {
    const ring = new LogRingBuffer(2)
    ring.push({ level: 30, time: 1, msg: 'first' })
    ring.push({ level: 30, time: 2, msg: 'second' })
    ring.push({ level: 30, time: 3, msg: 'third' })

    expect(ring.size()).toBe(2)
    expect(ring.drain(0).map(entry => entry.msg)).toEqual(['second', 'third'])
  })
})
