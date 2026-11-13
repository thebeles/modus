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
  webServer: process.env.E2E_BASE_URL ? undefined : [
    {
      name: 'API',
      command: 'pnpm exec tsx --env-file-if-exists=.env src/main.ts',
      cwd: fileURLToPath(new URL('../backend/', import.meta.url)),
      url: 'http://127.0.0.1:4080/api/v1/health/ready',
      timeout: 120000,
      env: { NODE_ENV: 'development', DATABASE_URL: process.env.E2E_DATABASE_URL!, PORT: '4080',
        WEB_ORIGIN: baseURL, DEMO_MODE: 'true', COOKIE_SECURE: 'false', GROQ_AI_ENABLED: 'false', STORAGE_DIR: '.storage/e2e',
        ANONYMOUS_DATA_KEY: '0123456789abcdef'.repeat(4), LEGACY_DEMO_FIXTURES: 'true' },
    },
    {
      name: 'Worker',
      command: 'pnpm worker',
      cwd: fileURLToPath(new URL('../backend/', import.meta.url)),
      wait: { stdout: /Worker started/ },
      timeout: 120000,
      env: { NODE_ENV: 'development', DATABASE_URL: process.env.E2E_DATABASE_URL!, GROQ_AI_ENABLED: 'false', STORAGE_DIR: '.storage/e2e',
        ANONYMOUS_DATA_KEY: '0123456789abcdef'.repeat(4) },
    },
    {
      name: 'Vite',
      command: 'pnpm dev',
      url: baseURL + '/api/v1/health/ready',
      timeout: 120000,
      env: { VITE_PORT: '4180', MODUS_API_TARGET: 'http://127.0.0.1:4080' },
    },
  ],
});
