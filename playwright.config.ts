import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Start vite preview before tests (serves the production build)
  webServer: {
    command: 'npx vite preview --config src/ui/vite.config.ts --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 15_000,
  },
})
