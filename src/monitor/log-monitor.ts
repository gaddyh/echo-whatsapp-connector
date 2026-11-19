import { env } from '../config/env.js'
import { logger, logRing } from '../observability/logger.js'
import type { LogRingBuffer, RingEntry } from '../observability/log-ring.js'
import { sessionManager } from '../sessions/session-manager.js'
import { summarizeWindow, type WindowSummary } from './counters.js'
import { generateDigest, type DigestOutput, type DigestPayload } from './llm-summarizer.js'

export interface DigestContext {
  ring: LogRingBuffer
  runtimeSnapshot: () => Record<string, number>
  now: () => number
}

let digestTimer: NodeJS.Timeout | undefined
let lastDigestAt = 0
let previousDigest: DigestOutput | null = null

/** Builds the exact package handed to the LLM. Pure apart from the clock. */
export function buildDigestPayload(
  summary: WindowSummary,
  windowFrom: string,
  windowTo: string,
  previous: DigestOutput | null,
  runtimeSnapshot: Record<string, number>
): DigestPayload {
  return {
    window: { from: windowFrom, to: windowTo },
    deploy_context: {
      restarts: summary.counters.restarts,
      graceful_shutdowns: summary.counters.graceful_shutdowns,
      note: 'worker overlap during deploys is expected; claim contention during it is normal'
    },
    counters: summary.counters,
    peak_recovery_per_min: summary.peakRecoveryPerMin,
    distinct_connections: summary.distinctConnections,
    by_connection_anomalous: summary.byConnection,
    warn_error_samples: summary.samples,
    log_entries: summary.entries,
    previous_digest: previous
      ? { one_liner: previous.one_liner, still_open: previous.still_open }
      : null,
    ...(Object.keys(runtimeSnapshot).length > 0
      ? { live_snapshot: { sessions_by_state: runtimeSnapshot, taken_at: windowTo } }
      : {})
  } as DigestPayload
}

async function postDigest(digest: DigestOutput, payload: DigestPayload): Promise<void> {
  try {
    const response = await fetch(env.OPS_ALERT_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPS_ALERT_TOKEN}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        severity: digest.attention ? 'high' : 'info',
        title: digest.one_liner,
        body: JSON.stringify(digest),
        source: 'connector',
        worker_id: env.WORKER_ID,
        timestamp: payload.window.to,
        window: payload.window,
        metrics: {
          counters: payload.counters,
          peak_recovery_per_min: payload.peak_recovery_per_min,
          distinct_connections: payload.distinct_connections,
          by_connection_anomalous: payload.by_connection_anomalous,
          warn_error_samples: payload.warn_error_samples,
          log_entries: payload.log_entries
        }
      })
    })
    if (!response.ok) throw new Error(`ops alert endpoint returned HTTP ${response.status}`)
  } catch (err) {
    logger.warn({ component: 'log-monitor', err }, 'ops digest delivery failed; logged only')
  }
}

export async function runDigest(context: DigestContext): Promise<DigestOutput> {
  const now = context.now()
  const windowFrom = lastDigestAt
  const entries: RingEntry[] = context.ring.drain(windowFrom)
  lastDigestAt = now
  const summary = summarizeWindow(entries)
  const payload = buildDigestPayload(
    summary,
    new Date(windowFrom).toISOString(),
    new Date(now).toISOString(),
    previousDigest,
    context.runtimeSnapshot()
  )
  const digest = await generateDigest(payload)
  previousDigest = digest
  logger.info({ component: 'log-monitor', digest }, 'hourly log digest')
  if (env.OPS_ALERT_ENDPOINT) await postDigest(digest, payload)
  return digest
}

export function startLogMonitor(ring: LogRingBuffer = logRing): void {
  if (digestTimer) return
  if (!env.OPENAI_API_KEY) {
    logger.error({ component: 'log-monitor' }, 'log monitor enabled without OPENAI_API_KEY; not starting')
    return
  }
  const context: DigestContext = {
    ring,
    runtimeSnapshot: () => sessionManager.runtimeSnapshot(),
    now: () => Date.now()
  }
  lastDigestAt = Date.now()
  digestTimer = setInterval(() => {
    void runDigest(context).catch(err => {
      logger.warn({ component: 'log-monitor', err }, 'log digest tick failed; will retry next interval')
    })
  }, env.LOG_MONITOR_DIGEST_MS)
  digestTimer.unref()
  logger.info(
    { component: 'log-monitor', digest_interval_ms: env.LOG_MONITOR_DIGEST_MS, model: env.OPENAI_MODEL },
    'log monitor started'
  )
}

export function stopLogMonitor(): void {
  if (digestTimer) clearInterval(digestTimer)
  digestTimer = undefined
}

/** Test helper: resets carry-forward state between test cases. */
export function resetMonitorStateForTests(): void {
  previousDigest = null
  lastDigestAt = 0
}
