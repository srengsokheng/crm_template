import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.ts';
import { loadContext, SESSION_COOKIE } from './lib/auth.ts';
import { AppError } from './lib/errors.ts';
import { registerRoutes } from './routes/index.ts';

const PUBLIC_API = new Set(['/api/v1/auth/login', '/api/v1/auth/signup', '/api/v1/auth/accept-invite', '/api/v1/health']);

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? (config.isTest ? false : config.isProd ? true : { transport: { target: 'pino-pretty' } }),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
      },
    },
  });
  await app.register(rateLimit, { global: false });

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    // CSRF defence: mutating API calls must carry our custom header (not sendable cross-site without CORS).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'crm') {
      throw new AppError(403, 'CSRF', 'Missing X-Requested-With header');
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.ctx = (await loadContext(token)) ?? undefined;
    if (!req.ctx && !PUBLIC_API.has(path) && !path.startsWith('/api/v1/auth/invite/')) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, fields: err.fields, details: err.details } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many attempts, please wait a minute' } });
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message } });
    }
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505') return reply.code(409).send({ error: { code: 'CONFLICT', message: 'A record with this value already exists' } });
    if (pgErr.code === '23503') return reply.code(400).send({ error: { code: 'INVALID_REFERENCE', message: 'A linked record does not exist' } });
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
  });

  await app.register(registerRoutes, { prefix: '/api/v1' });

  // Serve the built SPA (production). Unknown non-API paths fall back to index.html.
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
  };
  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/') || req.method !== 'GET') {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    const root = normalize(config.webDist);
    let file = normalize(join(root, decodeURIComponent(path)));
    if (!file.startsWith(root)) return reply.code(404).send();
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) file = join(root, 'index.html');
    const body = await readFile(file).catch(() => null);
    if (!body) return reply.code(404).send('Web app not built. Run `npm run build`.');
    const ext = extname(file);
    reply.header('content-type', types[ext] ?? 'application/octet-stream');
    reply.header('cache-control', path.startsWith('/assets/') && s?.isFile() ? 'public, max-age=31536000, immutable' : 'no-cache');
    return reply.send(body);
  });

  return app;
}
