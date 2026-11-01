import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3200);
// Use a preinstalled Chromium when provided (e.g. PW_CHROMIUM_PATH=/opt/pw-browsers/chromium); CI installs its own.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /responsive/ },
    { name: 'responsive', use: { ...devices['Desktop Chrome'] }, testMatch: /responsive/ },
  ],
  webServer: {
    command: 'node scripts/e2e-server.ts',
    url: `http://localhost:${port}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(port), INLINE_WORKER: 'true' },
  },
});
