import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:4180';
if (!process.env.E2E_BASE_URL && !process.env.E2E_DATABASE_URL) throw new Error('Set E2E_DATABASE_URL to a seeded test database.');

export default defineConfig({
  testDir: './tests',
  timeout: 75000,
  expect: { timeout: 15000 },
  workers: 1,
  reporter: 'list',
  use: { baseURL, ...devices['Desktop Chrome'], trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'pnpm dev',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: baseURL + '/api/v1/health/ready',
    timeout: 120000,
    env: { DATABASE_URL: process.env.E2E_DATABASE_URL!, PORT: '4080', VITE_PORT: '4180', WEB_ORIGIN: baseURL,
      KONTUR_API_TARGET: 'http://127.0.0.1:4080', DEMO_MODE: 'true', GROQ_AI_ENABLED: 'false', STORAGE_DIR: '.storage/e2e' },
  },
});
