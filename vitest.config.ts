import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Server-side code (node:sqlite, ocpp-rpc, mqtt) — never jsdom.
    environment: 'node',
    // Explicit `import { test, expect } from 'vitest'`, matching the project's style.
    globals: false,
    // Only our own tests. The default `**/*.test.ts` would also collect the Playwright
    // e2e suite and the vendored .references/evcc tests, which use other runners.
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.references', 'e2e'],
  },
})
