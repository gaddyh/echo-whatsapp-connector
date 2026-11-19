import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: [
        'src/auth/crypto.ts',
        'src/baileys/identity.ts',
        'src/baileys/browser-fingerprint.ts',
        'src/baileys/version-provider.ts',
        'src/db/repositories.ts',
        'src/db/retention.ts',
        'src/monitor/counters.ts',
        'src/monitor/redact.ts',
        'src/monitor/llm-summarizer.ts',
        'src/monitor/log-monitor.ts',
        'src/observability/log-ring.ts',
        'src/events/types.ts'
      ],
      exclude: ['**/*.d.ts'],
      thresholds: {
        lines: 95,
        functions: 95,
        statements: 95
      },
      reporter: ['text', 'html']
    }
  }
})
