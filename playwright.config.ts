import { defineConfig, devices } from '@playwright/test'

// E2E harness. Tests drive the dev server you already run (`npm run dev`).
// The MarkdownReporter writes per-run sessions to testing/sessions/<timestamp>/
// with videos + JSON manifests; open testing/viewer.html to browse them.
//
// Override the port by setting E2E_BASE_URL.

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['./testing/MarkdownReporter.ts'], ['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    video: 'on',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
