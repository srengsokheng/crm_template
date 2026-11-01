/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';

let appPromise: Promise<FastifyInstance> | null = null;
export const getApp = () => (appPromise ??= buildApp({ logger: false }));

let seq = 0;
export const uniq = (p = 'u') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

type Res<T = any> = Promise<{ status: number; body: T }>;
export interface Client {
  get: <T = any>(url: string) => Res<T>;
  post: <T = any>(url: string, body?: unknown) => Res<T>;
  patch: <T = any>(url: string, body?: unknown) => Res<T>;
  put: <T = any>(url: string, body?: unknown) => Res<T>;
  del: <T = any>(url: string, body?: unknown) => Res<T>;
  raw: (method: string, url: string, opts?: { headers?: Record<string, string>; body?: unknown }) => Res<any>;
}

export function client(app: FastifyInstance): Client {
  let cookie = '';
  const send = async (method: string, url: string, body?: unknown, headers: Record<string, string> = { 'x-requested-with': 'crm' }) => {
    const res = await app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers: { ...(cookie ? { cookie } : {}), ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers['set-cookie'];
    if (sc) {
      const v = (Array.isArray(sc) ? sc : [sc]).map((s) => s.split(';')[0]).find((s) => s.startsWith('crm_session='));
      if (v !== undefined) cookie = v === 'crm_session=' ? '' : v;
    }
    let parsed: unknown = res.body;
    try { parsed = res.body ? JSON.parse(res.body) : undefined; } catch { /* non-JSON (csv) */ }
    return { status: res.statusCode, body: parsed as any };
  };
  return {
    get: (u) => send('GET', u),
    post: (u, b) => send('POST', u, b ?? {}),
    patch: (u, b) => send('PATCH', u, b ?? {}),
    put: (u, b) => send('PUT', u, b ?? {}),
    del: (u, b) => send('DELETE', u, b),
    raw: (m, u, o = {}) => send(m, u, o.body, o.headers ?? {}),
  };
}

/** Sign up a fresh workspace and return an admin client plus reference data. */
export async function signup(name = 'Admin') {
  const app = await getApp();
  const c = client(app);
  const email = `${uniq('admin')}@example.com`;
  const r = await c.post('/auth/signup', { workspaceName: `${name} Inc`, name, email, password: 'password123' });
  if (r.status !== 201) throw new Error(`signup failed ${JSON.stringify(r.body)}`);
  const meta = (await c.get('/meta')).body;
  const me = (await c.get('/auth/me')).body;
  const dealPipeline = meta.pipelines.find((p: any) => p.entityType === 'deal');
  const leadPipeline = meta.pipelines.find((p: any) => p.entityType === 'lead');
  const stage = (pl: any, n: string) => pl.stages.find((s: any) => s.name === n);
  const dict = (kind: string) => meta.dictionaries.filter((d: any) => d.kind === kind);
  return { app, c, email, meta, me, dealPipeline, leadPipeline, stage, dict };
}

/** Invite a user with the given role and return a signed-in client for them. */
export async function inviteUser(admin: Client, roleName: string, name = 'Rep') {
  const app = await getApp();
  const roles = (await admin.get('/roles')).body.data;
  const role = roles.find((r: any) => r.name === roleName);
  const email = `${uniq('user')}@example.com`;
  const inv = await admin.post('/users/invite', { email, name, roleId: role.id });
  if (inv.status !== 201) throw new Error(JSON.stringify(inv.body));
  const token = inv.body.inviteUrl.split('/invite/')[1];
  const u = client(app);
  const acc = await u.post('/auth/accept-invite', { token, name, password: 'password123' });
  if (acc.status !== 200) throw new Error(JSON.stringify(acc.body));
  const me = (await u.get('/auth/me')).body;
  return { c: u, id: me.user.id as number, email, token };
}
