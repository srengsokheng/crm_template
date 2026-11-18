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
  /**
   * Which proxies may tell us the client's address (X-Forwarded-For), used for rate limits. Off by default: when the
   * app is reached directly, anyone could send the header and dodge the limits. Behind a reverse proxy / load balancer
   * set TRUST_PROXY to its address(es) ("127.0.0.1", "10.0.0.0/8,10.1.2.3"), to the number of proxy hops ("1"), or to
   * "true" only if every request is guaranteed to pass through a proxy that overwrites the header.
   */
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
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
    /** "disk" (default) or "s3" (any S3-compatible service). */
    storage: (env.FILES_STORAGE === 's3' ? 's3' : 'disk') as 'disk' | 's3',
    s3: {
      endpoint: env.S3_ENDPOINT ?? '', region: env.S3_REGION ?? 'us-east-1', bucket: env.S3_BUCKET ?? '',
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true', prefix: env.S3_PREFIX ?? '',
    },
    /** ClamAV daemon for scanning uploads (off when CLAMAV_HOST is empty). */
    clamav: { host: env.CLAMAV_HOST ?? '', port: Number(env.CLAMAV_PORT ?? 3310) },
  },
  webDist: env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)),
  /**
   * Key for credentials stored in the database (e.g. Telegram bot tokens): 32 bytes, base64 or hex. Required in
   * production; in development and tests a key is generated once into data/secrets.key (git-ignored).
   */
  secretsKey: env.SECRETS_KEY ?? '',
  secretsKeyFile: env.SECRETS_KEY_FILE ?? fileURLToPath(new URL('../../../data/secrets.key', import.meta.url)),
  /** Inbox channels. TELEGRAM_API_URL is only changed for tests. */
  telegram: { apiUrl: env.TELEGRAM_API_URL ?? 'https://api.telegram.org' },
  /** Meta Graph API (Messenger, Instagram, WhatsApp). META_GRAPH_URL is only changed for tests. */
  meta: { graphUrl: env.META_GRAPH_URL ?? 'https://graph.facebook.com/v21.0' },
  /**
   * Video calls: STUN/TURN servers the browsers use to find a way to each other, as JSON (RTCIceServer[]), e.g.
   * [{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}].
   * Default: Google's public STUN server. A TURN relay is needed when people are behind strict firewalls.
   */
  calls: { iceServers: parseIceServers(env.CALL_ICE_SERVERS) },
};

function parseIceServers(v: string | undefined): { urls: string | string[]; username?: string; credential?: string }[] {
  if (v === undefined || v.trim() === '') return [{ urls: 'stun:stun.l.google.com:19302' }];
  const parsed = JSON.parse(v) as unknown;
  if (!Array.isArray(parsed)) throw new Error('CALL_ICE_SERVERS must be a JSON array');
  return parsed as { urls: string | string[]; username?: string; credential?: string }[];
}

function parseTrustProxy(v: string | undefined): boolean | string[] | ((address: string, hop: number) => boolean) {
  const t = (v ?? '').trim();
  if (!t || t === 'false') return false;
  if (t === 'true') return true;
  if (/^\d+$/.test(t)) { const hops = Number(t); return (_address: string, hop: number) => hop < hops; } // the nearest N proxies
  return t.split(',').map((s) => s.trim()).filter(Boolean);
}
