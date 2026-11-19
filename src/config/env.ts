import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default('info'),
  WORKER_ID: z.string().min(1).default('local-1'),
  MAX_SESSIONS: z.coerce.number().int().positive().default(100),
  SESSION_START_STAGGER_MS: z.coerce.number().int().nonnegative().default(2000),
  RECONNECT_BASE_DELAY_MS: z.coerce.number().int().positive().default(2000),
  RECONNECT_MAX_DELAY_MS: z.coerce.number().int().positive().default(60000),
  QR_TTL_MS: z.coerce.number().int().positive().default(120000),
  PAIRING_QR_RECOVERY_MS: z.coerce.number().int().positive().default(240000),
  CLAIM_RENEW_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  RECOVERY_BACKOFF_INITIAL_MS: z.coerce.number().int().positive().default(1000),
  RECOVERY_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(30000),
  DATABASE_URL: z.string().min(1),
  // z.stringbool(), not z.coerce.boolean(): Boolean('false') === true, so
  // coercion silently inverts every explicit "false" in the environment.
  DATABASE_SSL: z.stringbool().default(false),
  DB_POOL_MAX: z.coerce.number().int().positive().default(25),
  RETENTION_SWEEP_INTERVAL_MS: z.coerce.number().int().nonnegative().default(3_600_000),
  EVENT_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(7),
  UNPROCESSED_EVENT_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),
  MEDIA_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),
  AUTH_ENCRYPTION_KEY: z.string().min(1),
  INTERNAL_API_TOKEN: z.string().min(1),
  WA_WEB_VERSION_OVERRIDE: z.string().optional().default(''),
  // Fixed browser identity for all connections (legacy/rollback mode).
  // Empty by default: each connection gets a realistic fingerprint, chosen
  // once at pairing and persisted in connections.settings.
  BAILEYS_BROWSER_NAME: z.string().default(''),
  DOWNLOAD_MEDIA: z.stringbool().default(true),
  MAX_MEDIA_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  EVENT_SINK: z.enum(['db', 'http']).default('db'),
  EVENT_WEBHOOK_URL: z.string().optional().default(''),
  EVENT_WEBHOOK_TOKEN: z.string().optional().default(''),
  MEDIA_BASE_URL: z.string().url().default('http://localhost:8080'),
  MEDIA_SIGNING_SECRET: z.string().optional().default(''),
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Write-ahead event outbox: every message event is committed locally
  // before any publish attempt; a drainer replays leftovers to Postgres.
  EVENT_OUTBOX_DIR: z.string().default('./data'),
  EVENT_OUTBOX_MAX_EVENTS: z.coerce.number().int().positive().default(10_000),
  EVENT_OUTBOX_HARD_MAX_EVENTS: z.coerce.number().int().positive().default(20_000),
  EVENT_OUTBOX_DRAIN_MS: z.coerce.number().int().positive().default(30_000),
  PUBLISH_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  POST_PUBLISH_CONCURRENCY: z.coerce.number().int().positive().default(8),
  // Ops log monitor: hourly LLM-written digest of log-derived counters.
  // The digest is logged and optionally POSTed to OPS_ALERT_ENDPOINT.
  LOG_MONITOR_ENABLED: z.stringbool().default(false),
  LOG_MONITOR_DIGEST_MS: z.coerce.number().int().positive().default(3_600_000),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-5.6-luna'),
  OPS_ALERT_ENDPOINT: z.string().optional().default('').transform(
    url => (url && !url.includes('://') ? `https://${url}` : url)
  ),
  OPS_ALERT_TOKEN: z.string().optional().default('')
})

export type Env = z.infer<typeof schema>
export const env: Env = schema.parse(process.env)
