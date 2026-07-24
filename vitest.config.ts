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
    // Globs, not bare names — bare 'node_modules' misses NESTED ones, so a subproject's
    // deps (e.g. src/ui2/node_modules) would otherwise be scanned. src/ui2 is a separate
    // WIP app with its own test runner; the root suite must not reach into it.
    exclude: ['**/node_modules/**', '**/dist/**', '.references/**', 'e2e/**', 'src/ui2/**'],
    coverage: {
      // Report against the whole backend source, not just test-imported files, so the
      // summary honestly shows what is NOT yet covered (e.g. the OCPP server handlers).
      // The React UI is covered by Playwright (test:e2e), so it's excluded here.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/ui/**'],
    },
  },
})
