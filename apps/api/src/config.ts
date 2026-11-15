import { fileURLToPath } from 'node:url';

const env = process.env;

export const config = {
  env: env.NODE_ENV ?? 'development',
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_dev',
  appUrl: env.APP_URL ?? 'http://localhost:5173',
  sessionDays: 30,
  webDist: env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)),
};
