import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { api, signUp } from './helpers.ts';

/** A fake Meta Graph API on the port the e2e server is configured with (META_GRAPH_URL in playwright.config.ts). */
const WA = '3333333';
const SECRET = '0123456789abcdef0123456789abcdef';
const sent: any[] = [];
let server: Server;
test.beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const reply = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (!String(req.headers.authorization).startsWith('Bearer GOOD')) return reply(400, { error: { code: 190, message: 'Invalid token' } });
      if (req.method === 'GET' && req.url?.startsWith(`/${WA}?`)) return reply(200, { verified_name: 'E2E Robotics', display_phone_number: '+855 23 999 000' });
      if (req.method === 'POST' && req.url === `/${WA}/messages`) { sent.push(JSON.parse(raw)); return reply(200, { messages: [{ id: `wamid.out.${sent.length}` }] }); }
      reply(404, { error: { code: 803, message: 'Unknown' } });
    });
  });
  await new Promise<void>((r) => server.listen(47123, '127.0.0.1', r));
});
test.afterAll(() => { server.close(); });

test('WhatsApp: connect in Settings, receive a message through the webhook, reply from the Inbox', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings/channels');
  await page.getByRole('button', { name: 'WhatsApp' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Phone number ID of the number customers write to', { exact: false })).toBeVisible();
  await dialog.getByLabel('Phone number ID').fill(WA);
  await dialog.getByLabel('Access token').fill('GOOD_e2e_token_abcdefghijklmnopqrstu');
  await dialog.getByLabel('App secret').fill('not-a-secret');
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByText(/The app secret is 32 letters and digits/)).toBeVisible(); // explained, dialog stays open
  await dialog.getByLabel('App secret').fill(SECRET);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByText('WhatsApp connected — finish the webhook setup on the channel')).toBeVisible();

  // The channel card: account, the webhook values to paste into Meta, and the https warning (e2e runs on http).
  await expect(page.getByText('E2E Robotics · +855 23 999 000').first()).toBeVisible();
  const callback = await page.getByLabel('Callback URL').inputValue();
  expect(callback).toMatch(/\/api\/v1\/hooks\/meta\/[0-9a-f]{32}$/);
  const verifyToken = await page.getByLabel('Verify token').inputValue();
  await expect(page.getByText(/Meta only sends messages to an https address/)).toBeVisible();
  await expect(page.getByText('GOOD_e2e_token')).toHaveCount(0); // never shown back

  // Meta verifies the webhook, then delivers a signed message.
  const key = callback.split('/').pop()!;
  const check = await page.request.get(`/api/v1/hooks/meta/${key}?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=987`);
  expect(await check.text()).toBe('987');
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: WA }, contacts: [{ wa_id: '85512345678', profile: { name: 'Sok Dara' } }],
    messages: [{ from: '85512345678', id: 'wamid.e2e.1', type: 'text', text: { body: 'Do you have the X2 arm?' } }] } }] }] });
  const sig = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  const hook = await page.request.post(`/api/v1/hooks/meta/${key}`, { data: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
  expect(hook.status()).toBe(200);

  // The team sees it in the Inbox, marked as WhatsApp, and replies.
  await page.goto('/inbox');
  const list = page.getByRole('complementary', { name: 'Conversations' });
  await expect(list.getByRole('link', { name: /Sok Dara/ })).toBeVisible();
  await expect(list.getByLabel('WhatsApp')).toBeVisible();
  await list.getByRole('link', { name: /Sok Dara/ }).click();
  await expect(page.locator('ol').getByText('Do you have the X2 arm?')).toBeVisible();
  await expect(page.getByText(/only delivers replies within 24 hours/)).toHaveCount(0);
  await page.getByLabel('Reply').fill('Yes, in stock.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('ol').getByText('Yes, in stock.')).toBeVisible();
  await expect.poll(() => sent.at(-1)?.text?.body, { timeout: 10_000 }).toBe('Yes, in stock.');
  expect(sent.at(-1)).toMatchObject({ messaging_product: 'whatsapp', to: '85512345678', type: 'text' });

  // When the customer's last message is over 24 hours old, the reply box warns first.
  const convs = await api(page, 'GET', '/inbox/conversations');
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_e2e' });
  await db.connect();
  await db.query(`UPDATE messages SET created_at = now() - interval '2 days' WHERE conversation_id = $1 AND direction = 'in'`, [convs.data[0].id]);
  await db.end();
  await page.reload();
  await expect(page.getByText(/Their last message was more than 24 hours ago\. WhatsApp only delivers replies within 24 hours/)).toBeVisible();
});
