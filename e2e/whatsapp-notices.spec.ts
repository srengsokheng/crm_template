import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

/** A fake Meta Graph API on the port the e2e server uses (META_GRAPH_URL in playwright.config.ts). */
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
      if (req.method === 'GET' && req.url?.startsWith('/4444444?')) return reply(200, { id: '4444444' });
      if (req.method === 'GET' && req.url?.startsWith('/4444444/message_templates?')) {
        return reply(200, { data: [{ name: 'payment_due', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, {{2}} is due. Pay here: {{3}}' }] }] });
      }
      if (req.method === 'POST' && req.url === `/${WA}/messages`) { sent.push(JSON.parse(raw)); return reply(200, { messages: [{ id: `wamid.n.${sent.length}` }] }); }
      reply(404, { error: { code: 803, message: 'Unknown' } });
    });
  });
  await new Promise<void>((r) => server.listen(47123, '127.0.0.1', r));
});
test.afterAll(() => { server.close(); });

test('WhatsApp payment reminders: pick the template and blanks in settings, send one, the customer gets it', async ({ page }) => {
  await signUp(page);
  const ch = await api(page, 'POST', '/channels', { kind: 'whatsapp', accountId: WA, accessToken: 'GOOD_e2e_token_abcdefghijklmnopqrstu', appSecret: SECRET });
  await api(page, 'PATCH', `/channels/${ch.id}`, { businessAccountId: '4444444' });

  await page.goto('/settings/documents');
  await page.getByLabel('Remind customers automatically about sent invoices that aren’t paid yet').check();
  await page.getByLabel('Also on WhatsApp').selectOption(String(ch.id));
  await page.getByLabel('Approved template').selectOption('payment_due|en_US');
  await expect(page.getByLabel('Blank {{1}}')).toHaveValue('name');
  await page.getByLabel('Blank {{2}}').selectOption('amount');
  await page.getByLabel('Blank {{3}}').selectOption('link');
  await expect(page.getByLabel('WhatsApp preview')).toHaveText('Hi Umbrella Foods, $1,250.00 is due. Pay here: https://…/d/…');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Blank {{2}}')).toHaveValue('amount');

  // An invoice for a contact with only a phone number.
  const contact = await api(page, 'POST', '/contacts', { firstName: 'Dara', lastName: 'Sok', methods: [{ kind: 'phone', value: '+855 12 345 678' }] });
  const deal = await api(page, 'POST', '/deals', { title: 'Robot arms', contactIds: [contact.id] });
  await api(page, 'PUT', `/deals/${deal.id}/line-items`, { items: [{ name: 'Robot arm', unitPrice: '500', quantity: 1, unit: 'pcs' }] });
  const inv = await api(page, 'POST', `/deals/${deal.id}/documents`, { kind: 'invoice' });
  await api(page, 'PATCH', `/documents/${inv.id}`, { billToName: 'Dara Sok' });
  await api(page, 'POST', `/documents/${inv.id}/status`, { status: 'sent' });

  await page.goto(`/documents/${inv.id}`);
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Payment reminders' }) });
  await expect(card).toContainText('To 1 WhatsApp chat');
  await card.getByRole('button', { name: 'Send reminder now' }).click();
  await expect(page.getByText('Reminder sent')).toBeVisible();
  await expect(card.getByRole('list', { name: 'Reminders sent' })).toContainText('1 WhatsApp chat');
  // The worker delivers it to WhatsApp.
  await expect.poll(() => sent.find((m) => m.to === '85512345678')?.template?.name, { timeout: 15_000 }).toBe('payment_due');
  const values = sent.find((m) => m.to === '85512345678').template.components[0].parameters.map((p: any) => p.text);
  expect(values[0]).toBe('Dara Sok');
  expect(values[1]).toBe('$500.00');
  expect(values[2]).toMatch(/\/d\/[\w-]+$/);
  // It's in the Inbox, in a chat started with Dara.
  await page.goto('/inbox');
  await expect(page.getByText('Dara Sok').first()).toBeVisible();
});
