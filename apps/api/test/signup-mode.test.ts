import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.ts';
import { pool } from '../src/db/pool.ts';
import { client, getApp, signup, uniq } from './helpers.ts';

afterEach(() => { config.signup = 'open'; });
afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const tryJoin = async () => client(await getApp()).post('/auth/signup', { workspaceName: 'Stranger Co', name: 'Stranger', email: `${uniq('s')}@example.com`, password: 'password123' });

describe('who may sign up (SIGNUP)', () => {
  it('open: anyone; closed: nobody; first: only while there is no workspace', async () => {
    await signup(); // the shared test database already has workspaces
    expect((await tryJoin()).status).toBe(201);
    config.signup = 'closed';
    const r = await tryJoin();
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'SIGNUP_CLOSED', message: expect.stringContaining('invite') });
    config.signup = 'first';
    expect((await tryJoin()).status).toBe(403);
  });

  it('first is the production default', async () => {
    const { execFileSync } = await import('node:child_process');
    const read = (extra: Record<string, string>) => execFileSync(process.execPath, ['-e', "import('./src/config.ts').then((m) => console.log(m.config.signup))"],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, SIGNUP: '', ...extra }, encoding: 'utf8' }).trim();
    expect(read({ NODE_ENV: 'production', SIGNUP: '' })).toBe('first');
    expect(read({ NODE_ENV: 'production', SIGNUP: 'open' })).toBe('open');
    expect(read({ NODE_ENV: 'development' })).toBe('open');
  });
});
