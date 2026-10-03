import { describe, expect, it } from 'vitest'
import { connectionStateEventId } from '../src/events/types.js'

describe('connection state event identity', () => {
  it('uses the connection state version', () => {
    expect(connectionStateEventId('connection-id', 42)).toBe('state:connection-id:42')
    expect(connectionStateEventId('connection-id', 43)).not.toBe('state:connection-id:42')
  })
})
