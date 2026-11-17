/* Starts the API (serving the built web app) on a fresh e2e database. Used by playwright.config.ts. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.E2E_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_e2e';
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
await c.end();
process.env.DATABASE_URL = url;
process.env.PORT = process.env.E2E_PORT ?? '3200';
process.env.NODE_ENV = 'test';
process.env.FILES_DIR ??= join(tmpdir(), 'crm-e2e-files');
// No real Telegram in tests: a fake user API that greets with a customer message after sign-in.
const { setTgUserDriver } = await import('../apps/api/src/inbox/telegramUser.ts');
const { fakeTelegramUser, incoming } = await import('../apps/api/test/fakes/telegramUser.ts');
setTgUserDriver(fakeTelegramUser({ greetAfterLogin: incoming({ messageId: '1', body: 'Hi! Is the X2 arm still available?' }) }).driver);
await import('../apps/api/src/server.ts');
