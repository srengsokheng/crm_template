import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/api/test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    globalSetup: ['apps/api/test/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_test',
      FILES_DIR: join(tmpdir(), 'crm-test-files'),
      SECRETS_KEY_FILE: join(tmpdir(), 'crm-test-secrets.key'),
    },
  },
});
