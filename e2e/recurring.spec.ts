import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('recurring invoices: repeat an invoice monthly by email, see it on the invoice and in Recurring, pause and resume', async ({ page }) => {
  await signUp(page);
  const deal = await api(page, 'POST', '/deals', { title: 'Maintenance contract — Umbrella Foods' });
  await api(page, 'PUT', `/deals/${deal.id}/line-items`, { items: [{ name: 'Monthly maintenance', unitPrice: '450', quantity: 1, unit: 'month' }] });
  const inv = await api(page, 'POST', `/deals/${deal.id}/documents`, { kind: 'invoice' });
  await api(page, 'POST', `/documents/${inv.id}/status`, { status: 'sent' });

  await page.goto(`/documents/${inv.id}`);
  await page.getByRole('button', { name: 'Repeat…' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('How often').selectOption({ label: 'Every month' });
  await dlg.getByLabel('Ends').selectOption({ label: 'After a number of invoices' });
  await dlg.getByLabel('Number of invoices').fill('12');
  await dlg.getByLabel('Each new invoice').selectOption({ label: 'Is sent by email right away' });
  await dlg.getByLabel('Send to').fill('');
  await dlg.getByRole('button', { name: 'Set up' }).click();
  await expect(page.getByText('Add who receives the invoice').first()).toBeVisible();
  await dlg.getByLabel('Send to').fill('ap@umbrella.test');
  await dlg.getByRole('button', { name: 'Set up' }).click();
  await expect(page.getByText('Repeating invoice set up')).toBeVisible();

  const card = page.getByRole('region', { name: /Repeats/ }).or(page.locator('section', { hasText: 'Repeats' })).first();
  await expect(card).toContainText('Every month');
  await expect(card).toContainText('$450');
  await expect(card).toContainText('sent to ap@umbrella.test');
  await expect(card).toContainText('0 made of 12');
  await card.getByRole('button', { name: 'Pause' }).click();
  await expect(card.getByText('Paused', { exact: true }).first()).toBeVisible();

  await page.goto('/documents?view=recurring');
  await expect(page.getByRole('link', { name: 'Maintenance contract — Umbrella Foods' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('Resumed')).toBeVisible();
  await expect(page.getByText(/Next on /)).toBeVisible();
});
