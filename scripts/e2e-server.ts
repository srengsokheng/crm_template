/* Starts the API (serving the built web app) on a fresh e2e database. Used by playwright.config.ts. */
import pg from 'pg';

const url = process.env.E2E_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_e2e';
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
await c.end();
process.env.DATABASE_URL = url;
process.env.PORT = process.env.E2E_PORT ?? '3200';
process.env.NODE_ENV = 'test';
await import('../apps/api/src/server.ts');
