import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: [
        'src/auth/crypto.ts',
        'src/baileys/identity.ts',
        'src/db/repositories.ts',
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
