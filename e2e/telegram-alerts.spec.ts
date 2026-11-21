import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

/** A fake Telegram Bot API on the port the e2e server uses (TELEGRAM_API_URL in playwright.config.ts). */
const updates: any[] = [];
const sent: any[] = [];
let server: Server;
test.beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      const reply = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (!m) return reply(404, { ok: false });
      const p = raw ? JSON.parse(raw) : {};
      if (m[2] === 'getMe') return reply(200, { ok: true, result: { id: 7200001, is_bot: true, first_name: 'Acme Bot', username: 'acme_crm_bot' } });
      if (m[2] === 'deleteWebhook') return reply(200, { ok: true, result: true });
      if (m[2] === 'getUpdates') return reply(200, { ok: true, result: updates.filter((u) => u.update_id >= (p.offset ?? 0)) });
      if (m[2] === 'sendMessage') { sent.push(p); return reply(200, { ok: true, result: { message_id: sent.length, chat: { id: p.chat_id } } }); }
      reply(404, { ok: false, description: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(47125, '127.0.0.1', r));
});
test.afterAll(() => { server.close(); });

test('Telegram notifications: connect from Your account through the bot; a quote accepted online arrives in Telegram', async ({ page, browser, baseURL }) => {
  await signUp(page);
  await page.goto('/settings/account');
  await expect(page.getByText(/An admin first needs to connect a Telegram bot/)).toBeVisible();
  await api(page, 'POST', '/channels', { kind: 'telegram_bot', token: '7200001:AAFakeE2EAlertsToken_0123456789abc' });

  await page.reload();
  await page.getByRole('button', { name: 'Connect Telegram' }).click();
  await expect(page.getByRole('img', { name: 'QR code to open the CRM bot in Telegram' })).toBeVisible();
  const href = await page.getByRole('link', { name: 'Open Telegram' }).getAttribute('href');
  expect(href).toMatch(/^https:\/\/t\.me\/acme_crm_bot\?start=[A-Za-z0-9_-]{16}$/);

  // The person taps Start in Telegram: the bot receives "/start <code>".
  updates.push({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 9001, type: 'private', first_name: 'Ada' }, from: { id: 9001, first_name: 'Ada', last_name: 'Admin' }, text: `/start ${href!.split('start=')[1]}` } });
  await expect(page.getByText(/Notifications go to/)).toContainText('Ada Admin', { timeout: 15_000 });
  expect(sent.find((s) => s.chat_id === '9001')?.text).toMatch(/^✅ Connected to /);

  // A customer accepts a quote online: the notification also arrives in Telegram, with a link.
  const deal = await api(page, 'POST', '/deals', { title: 'Robot arms for Umbrella Foods' });
  await api(page, 'PUT', `/deals/${deal.id}/line-items`, { items: [{ name: 'Robot arm X2', unitPrice: '1250.50', quantity: 1, unit: 'pcs' }] });
  const q = await api(page, 'POST', `/deals/${deal.id}/documents`, { kind: 'quote' });
  const sentQuote = await api(page, 'POST', `/documents/${q.id}/status`, { status: 'sent' });
  const customer = await (await browser.newContext()).newPage();
  await customer.request.post(`${baseURL}/api/v1/public/documents/${sentQuote.customerUrl.split('/d/')[1]}/accept`, { data: { name: 'Carlos Oliveira' } });
  await expect.poll(() => sent.filter((s) => s.chat_id === '9001').map((s) => s.text).join('\n'), { timeout: 15_000 }).toMatch(/🔔 Carlos Oliveira accepted Quote Q-\d+/);
  expect(sent.at(-1).text).toContain(`/deals/${deal.id}`);

  // Turning it off.
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByText('Telegram notifications turned off')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Telegram' })).toBeVisible();
});
