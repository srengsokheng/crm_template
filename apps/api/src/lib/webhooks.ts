/**
 * Outgoing webhooks for automation rules ("Call a webhook").
 *
 * Safety rules (SSRF protection):
 *   - the host must be on the workspace allow-list (exact host, or "*.example.com" for subdomains);
 *   - HTTPS only, no user:password in the URL;
 *   - every resolved address must be public (no loopback, private, link-local, CGNAT, multicast or reserved ranges);
 *   - no redirects, 10 s timeout.
 * Each request is signed: X-CRM-Signature = "sha256=" + HMAC-SHA256(workspace secret, raw body).
 * `policy` can relax HTTPS / private addresses for local development and tests only (env WEBHOOK_ALLOW_HTTP /
 * WEBHOOK_ALLOW_PRIVATE); never in production.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const policy = {
  allowHttp: process.env.WEBHOOK_ALLOW_HTTP === 'true' && process.env.NODE_ENV !== 'production',
  allowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE === 'true' && process.env.NODE_ENV !== 'production',
  timeoutMs: 10_000,
};

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/** Normalise an allow-list entry: lower-case host or *.host, no scheme/path/port. Returns null when invalid. */
export function normaliseHost(entry: string): string | null {
  const s = entry.trim().toLowerCase();
  if (s === 'localhost' && policy.allowPrivate) return s; // local development only
  const m = /^(\*\.)?([a-z0-9-]+(\.[a-z0-9-]+)+)$/.exec(s);
  return m ? s : null;
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a));
}

/** Checks done when a rule is saved and again before each call. Throws Error with a readable message. */
export function checkWebhookUrl(raw: string, allowed: string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Enter a full URL, like https://hooks.example.com/crm'); }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) throw new Error('Webhook URLs must use https://');
  if (url.username || url.password) throw new Error('Webhook URLs can’t contain a user name or password');
  if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Use a host name, not an IP address');
  if (!hostAllowed(url.hostname, allowed)) throw new Error(`${url.hostname} is not on the webhook allow-list (Settings → Automation)`);
  return url;
}

/** True for addresses a webhook must never reach. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9')
    || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff') || v6.startsWith('64:ff9b:') || v6.startsWith('2001:db8');
}

export const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** POST the payload. Resolves on 2xx; throws with a short reason otherwise (the job queue retries). */
export async function deliverWebhook(rawUrl: string, allowed: string[], secret: string, event: string, payload: unknown, deliveryId: string): Promise<number> {
  const url = checkWebhookUrl(rawUrl, allowed);
  if (!policy.allowPrivate) {
    const addrs = await lookup(url.hostname, { all: true }).catch(() => { throw new Error(`Can’t resolve ${url.hostname}`); });
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`${url.hostname} resolves to a private address; refusing to call it`);
  }
  const body = JSON.stringify(payload);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(policy.timeoutMs),
      headers: { 'content-type': 'application/json', 'user-agent': 'AcmeCRM-Webhook/1', 'x-crm-event': event, 'x-crm-delivery': deliveryId, 'x-crm-signature': sign(secret, body) },
    });
  } catch (e) {
    throw new Error(e instanceof Error && e.name === 'TimeoutError' ? 'The webhook did not answer within 10 seconds' : `Could not reach ${url.hostname}`, { cause: e });
  }
  await res.arrayBuffer().catch(() => undefined); // drain
  if (res.status >= 300 && res.status < 400) throw new Error(`The webhook answered with a redirect (HTTP ${res.status}); redirects are not followed`);
  if (!res.ok) throw new Error(`The webhook answered HTTP ${res.status}`);
  return res.status;
}
