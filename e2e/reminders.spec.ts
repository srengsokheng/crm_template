import { expect, test } from '@playwright/test';
import pg from 'pg';
import { api, signUp, uniq } from './helpers.ts';

async function queuedSubjects(to: string): Promise<string[]> {
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_e2e' });
  await c.connect();
  try {
    return (await c.query(`SELECT payload->>'subject' AS subject FROM jobs WHERE type = 'email.send' AND payload->>'to' = $1 ORDER BY id`, [to])).rows.map((r) => r.subject);
  } finally { await c.end(); }
}

test('payment reminders: turn them on, see the next one on the invoice, send one now, turn off for one invoice', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings/documents');
  await page.getByLabel('Remind customers automatically about sent invoices that aren’t paid yet').check();
  await page.getByLabel('Before the due date').selectOption('3');
  await page.getByLabel('After the due date (days)').fill('7, 14');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('After the due date (days)')).toHaveValue('7, 14');

  const to = `${uniq('ap')}@umbrella.test`;
  const deal = await api(page, 'POST', '/deals', { title: 'Robot arms' });
  await api(page, 'PUT', `/deals/${deal.id}/line-items`, { items: [{ name: 'Robot arm', unitPrice: '250', quantity: 2, unit: 'pcs' }] });
  const inv = await api(page, 'POST', `/deals/${deal.id}/documents`, { kind: 'invoice' });
  await api(page, 'POST', `/documents/${inv.id}/email`, { to: [to], subject: 'Invoice', message: 'Hello' });

  await page.goto(`/documents/${inv.id}`);
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Payment reminders' }) });
  await expect(card.getByText(/^Next:/)).toContainText('3 days before the due date');
  await expect(card.getByText(`To ${to}`)).toBeVisible();

  await card.getByRole('button', { name: 'Send reminder now' }).click();
  await expect(page.getByText('Reminder sent')).toBeVisible();
  await expect(card.getByRole('list', { name: 'Reminders sent' })).toContainText('Sent by hand by Ada Admin');
  await expect(card.getByRole('list', { name: 'Reminders sent' })).toContainText('$500 due');
  expect((await queuedSubjects(to)).filter((s) => s.startsWith('Payment reminder: invoice'))).toHaveLength(1);

  await card.getByLabel('Don’t remind for this invoice').check();
  await expect(card.getByText('No automatic reminders for this invoice.')).toBeVisible();
  await page.reload();
  await expect(card.getByLabel('Don’t remind for this invoice')).toBeChecked();

  // The deal's history shows both.
  await page.goto(`/deals/${deal.id}`);
  await expect(page.getByText(/^Payment reminder for INV-\d+ to /)).toBeVisible();
  await expect(page.getByText(/^Turned off payment reminders for INV-\d+/)).toBeVisible();
});
