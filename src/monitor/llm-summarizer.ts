import { env } from '../config/env.js'
import { logger } from '../observability/logger.js'

export interface DigestItem {
  title: string
  severity: string
  detail?: string
}

export interface OpenItem {
  id: string
  title: string
  severity: string
  since?: string
  note?: string
}

export interface DigestPayload {
  window: { from: string; to: string }
  deploy_context: { restarts: number; graceful_shutdowns: number; note: string }
  counters: Record<string, number>
  peak_recovery_per_min: number
  distinct_connections: number
  by_connection_anomalous: Record<string, Record<string, number>>
  warn_error_samples: Array<{ level: number; msg: string; count: number; connection?: string; kind?: string }>
  log_entries: number
  previous_digest: { one_liner: string; still_open: OpenItem[] } | null
}

export interface DigestOutput {
  attention: boolean
  happened: DigestItem[]
  resolved: Array<{ id: string; note: string }>
  still_open: OpenItem[]
  one_liner: string
}

export const DIGEST_SYSTEM_PROMPT = `You are the operations monitor of echo-whatsapp-connector, a Node.js service
that maintains WhatsApp linked-device connections (Baileys) for a family-safety
product. You receive ONE HOUR of aggregated, redacted, log-derived metrics and
produce the hourly digest for the operator's phone.

Domain knowledge:
- A "connection" is one child's WhatsApp account linked as a device; ids are
  opaque UUID prefixes.
- A "claim" is a lease letting exactly one worker process own a connection.
  Claim reacquisition and recovery retries around deploys/restarts are NORMAL.
  Sustained "ownership lost" or "claim renewal failed" is NOT.
- "publish dropped" = a WhatsApp message was permanently lost before reaching
  the analysis pipeline. This is the most serious data-loss signal.
- "auth_lost" = the child's phone removed the device; a human must re-pair.
- "qr_expired_dormant" = an unpaired connection went dormant by design.
- "media_no_reference" for @newsletter chats is known and expected.
- The connector keeps a local write-ahead outbox: publish failures leave
  events queued for replay (outbox_pending), and the drainer republishes
  them (outbox_replayed) once the database returns. Pending events
  persisting across digests, or an oldest pending age above 1 hour, means
  the database is unhealthy or replay is broken - open an item.
- outbox_write_failures above zero means local durability itself failed
  (disk) - high severity.
- "disconnect_bad_session" churn (WhatsApp's status-stanza rollout) is a
  known upstream issue: sessions drop and reconnect within seconds. Track
  it as an open item only if it grows sharply or message delivery slows.
- "disconnect_version_mismatch" (WhatsApp Web version rejected, 405) IS a
  version incident — many users failing together needs the
  WA_WEB_VERSION_OVERRIDE runbook.
- retention_sweeps delete old event_inbox/media_blobs rows - deleting rows is
  success, not data loss.

Your job:
1. "happened": noteworthy events of this hour. Normal pairing/recovery after a
   deploy is info, not a problem. Never invent numbers or events; use only the
   provided data. If a counter suggests something unusual but ambiguous, say so.
2. "resolved": previous open items whose signals stopped this hour (counters at
   zero / no new occurrences). Reference them by their exact id.
3. "still_open": previous open items that persist (update counts/severity), and
   NEW items worth tracking: publish drops, claim/ownership problems, recovery
   storms (peak_recovery_per_min > 5 outside deploys), repeated publish retries,
   repeated media failures, db_unreachable, auth_lost, retention failures.
4. "attention": true only if something needs the operator to act now.

Open an item ONLY for problems worth tracking; do not open items for normal
activity. severity: high = data loss or users offline; medium = degraded or
at-risk; low = cosmetic; info = noteworthy normal activity.

Human-readable fields (title, detail, note, one_liner): English, concise and
technical. title max 60 characters, detail max 200 characters.

Output STRICT JSON only, no markdown, matching:
{ "attention": boolean,
  "happened": [ { "title": string, "severity": "info|low|medium|high", "detail": string } ],
  "resolved": [ { "id": string, "note": string } ],
  "still_open": [ { "id": string, "title": string, "severity": string, "since": string, "note": string } ],
  "one_liner": string }`

const OPENAI_TIMEOUT_MS = 20_000

function parseDigest(content: string): DigestOutput {
  const parsed = JSON.parse(content)
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.one_liner !== 'string') {
    throw new Error('digest JSON is missing one_liner')
  }
  const arrays = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  return {
    attention: parsed.attention === true,
    happened: arrays(parsed.happened) as DigestItem[],
    resolved: arrays(parsed.resolved) as Array<{ id: string; note: string }>,
    still_open: arrays(parsed.still_open) as OpenItem[],
    one_liner: parsed.one_liner
  }
}

async function callOpenAI(payload: DigestPayload): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)
  timer.unref()
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: DIGEST_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      }),
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`openai returned HTTP ${response.status}`)
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.length === 0) throw new Error('openai returned no content')
    return content
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Locally rendered digest used when the LLM is unavailable or returns
 * unparseable output: the heartbeat must never go silent. Open items carry
 * forward untouched because resolution cannot be evaluated without the model.
 */
export function fallbackDigest(payload: DigestPayload, reason: string): DigestOutput {
  const c = payload.counters
  return {
    attention: (c.publish_dropped ?? 0) > 0 || (c.db_unreachable ?? 0) > 0 || (c.ownership_lost ?? 0) > 0,
    happened: [],
    resolved: [],
    still_open: payload.previous_digest?.still_open ?? [],
    one_liner: `LLM summarizer failed (${reason}); counters: publish_dropped=${c.publish_dropped ?? 0}, ` +
      `db_unreachable=${c.db_unreachable ?? 0}, auth_lost=${c.auth_lost ?? 0}, ` +
      `recovery_scheduled=${c.recovery_scheduled ?? 0}`
  }
}

/**
 * Generates the hourly digest: one call plus one retry on unparseable output;
 * any transport failure falls back to the locally rendered digest.
 */
export async function generateDigest(payload: DigestPayload): Promise<DigestOutput> {
  let lastError = 'unknown error'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return parseDigest(await callOpenAI(payload))
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  logger.warn({ component: 'log-monitor', err: lastError }, 'llm digest fell back to local rendering')
  return fallbackDigest(payload, lastError)
}
