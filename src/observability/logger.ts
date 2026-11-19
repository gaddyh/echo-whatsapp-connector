import pino from 'pino'
import { env } from '../config/env.js'
import { LogRingBuffer } from './log-ring.js'

export const logRing = new LogRingBuffer(5_000)

export const logger = pino(
  {
    level: env.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', '*.auth', '*.creds', '*.keys', '*.qr'],
      censor: '[redacted]'
    }
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: logRing.asPinoStream() }
  ])
)
