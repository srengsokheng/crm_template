import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('quote from a deal → sent → accepted → invoice → paid, with PDF', async ({ page }) => {
  await signUp(page);
  const d = await api(page, 'POST', '/deals', { title: 'Warehouse robots' });
  await api(page, 'PUT', `/deals/${d.id}/line-items`, { items: [{ name: 'Picker robot', unitPrice: '1500', quantity: 2, unit: 'pcs', taxRate: 10 }] });
  await page.goto(`/deals/${d.id}`);
  const card = page.locator('section').filter({ hasText: /^Quotes & invoices \(/ });
  await expect(card.getByText('No quotes or invoices yet')).toBeVisible();

  await card.getByRole('button', { name: 'Quote', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Quote Draft' })).toBeVisible();
  await expect(page.getByText('Picker robot')).toBeVisible();
  await expect(page.getByText('$3,300').first()).toBeVisible();
  await page.getByLabel('Notes on the document').fill('Delivery within 3 weeks');
  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(page.getByText('Quote Q-0001 is ready to send')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Quote Q-0001/ })).toBeVisible();
  await expect(page.getByText('Sent quotes can’t be changed')).toBeVisible();
  await expect(page.getByText('Delivery within 3 weeks')).toBeVisible();

  await page.getByRole('button', { name: 'Accepted' }).click();
  await expect(page.getByText('Marked as accepted')).toBeVisible();
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await expect(page.getByRole('heading', { name: 'Invoice Draft' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(page.getByRole('heading', { name: /Invoice INV-0001/ })).toBeVisible();
  await page.getByRole('button', { name: 'Mark as paid' }).click();
  await expect(page.getByText('Marked as paid', { exact: true })).toBeVisible(); // the toast (the payment row also says it)

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'PDF', exact: true }).click()]);
  expect(download.suggestedFilename()).toBe('INV-0001.pdf');
  const pdf = await readFile(await download.path(), 'latin1');
  expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  expect(pdf).toContain('(INV-0001)');

  await page.getByRole('link', { name: 'Warehouse robots' }).click();
  await expect(card.getByText('Invoice INV-0001')).toBeVisible();
  await expect(card.getByText('Quote Q-0001')).toBeVisible();
  await expect(page.getByText('Invoice INV-0001 paid')).toBeVisible(); // history
});
