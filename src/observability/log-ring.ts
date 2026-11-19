/**
 * Bounded in-memory ring of recent structured log entries, fed by a pino
 * tee. The ops log monitor reads from it; writing can never block or throw.
 * Capacity is chosen so a normal hour of logs fits; if a pathological hour
 * overflows, older entries drop and the digest undercounts rather than
 * invents numbers.
 */
export interface RingEntry {
  level: number
  time: number
  msg: string
  [key: string]: unknown
}

export class LogRingBuffer {
  private readonly entries: RingEntry[] = []

  constructor(private readonly capacity: number) {}

  push(entry: RingEntry): void {
    if (this.entries.length >= this.capacity) this.entries.shift()
    this.entries.push(entry)
  }

  /** A pino-compatible destination that parses each JSON line into the ring. */
  asPinoStream(): { write: (line: string) => void } {
    return {
      write: (line: string) => {
        try {
          const parsed = JSON.parse(line)
          if (parsed && typeof parsed === 'object' && typeof parsed.msg === 'string') {
            this.push(parsed as RingEntry)
          }
        } catch {
          // non-JSON output (plain console writes) is skipped
        }
      }
    }
  }

  /** Entries with time >= sinceMs, oldest first. */
  drain(sinceMs: number): RingEntry[] {
    return this.entries.filter(entry => entry.time >= sinceMs)
  }

  size(): number {
    return this.entries.length
  }
}
