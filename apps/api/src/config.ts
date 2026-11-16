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
  /** Email delivery. console = print to the log (default), smtp = send via SMTP_*, memory = keep in memory (tests). */
  mail: {
    transport: (env.EMAIL_TRANSPORT ?? (env.NODE_ENV === 'test' ? 'memory' : env.SMTP_HOST ? 'smtp' : 'console')) as 'console' | 'smtp' | 'memory',
    from: env.EMAIL_FROM ?? 'Acme CRM <no-reply@localhost>',
    smtp: {
      host: env.SMTP_HOST ?? '',
      port: Number(env.SMTP_PORT ?? 587),
      /** true = TLS from the first byte (port 465); false = STARTTLS when the server offers it (port 587/25). */
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : Number(env.SMTP_PORT ?? 587) === 465,
      user: env.SMTP_USER || undefined,
      pass: env.SMTP_PASS || undefined,
    },
  },
  /** Attachments: stored on disk outside the web root. */
  files: {
    dir: env.FILES_DIR ?? fileURLToPath(new URL('../../../data/files/', import.meta.url)),
    maxBytes: Number(env.FILES_MAX_BYTES ?? 10 * 1024 * 1024),
    maxPerRecord: 100,
  },
  webDist: env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)),
};
