import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default('info'),
  WORKER_ID: z.string().min(1).default('local-1'),
  MAX_SESSIONS: z.coerce.number().int().positive().default(20),
  SESSION_START_STAGGER_MS: z.coerce.number().int().nonnegative().default(5000),
  RECONNECT_BASE_DELAY_MS: z.coerce.number().int().positive().default(2000),
  RECONNECT_MAX_DELAY_MS: z.coerce.number().int().positive().default(60000),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.coerce.boolean().default(false),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  AUTH_ENCRYPTION_KEY: z.string().min(1),
  INTERNAL_API_TOKEN: z.string().min(1),
  WA_WEB_VERSION_OVERRIDE: z.string().optional().default(''),
  BAILEYS_BROWSER_NAME: z.string().default('Echo Guard'),
  BAILEYS_BROWSER_PLATFORM: z.string().default('Chrome'),
  DOWNLOAD_MEDIA: z.coerce.boolean().default(true),
  MAX_MEDIA_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  EVENT_SINK: z.enum(['db', 'http']).default('db'),
  EVENT_WEBHOOK_URL: z.string().optional().default(''),
  EVENT_WEBHOOK_TOKEN: z.string().optional().default(''),
  MEDIA_BASE_URL: z.string().url().default('http://localhost:8080'),
  MEDIA_SIGNING_SECRET: z.string().optional().default(''),
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300)
})

export type Env = z.infer<typeof schema>
export const env: Env = schema.parse(process.env)
