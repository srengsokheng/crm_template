import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('a deal in another currency is flagged until an admin adds a rate, then counted', async ({ page }) => {
  await signUp(page); // base USD
  await api(page, 'POST', '/deals', { title: 'Local deal', amount: '1000' });
  await api(page, 'POST', '/deals', { title: 'Euro deal', amount: '2000', currency: 'EUR' });

  const openPipeline = page.locator('div.surface').filter({ has: page.getByText('Open pipeline', { exact: true }) });
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'Amounts in EUR aren’t included' })).toBeVisible();
  await expect(openPipeline.getByText('$1K', { exact: true })).toBeVisible(); // only the USD deal

  await page.getByRole('link', { name: 'Add exchange rates' }).click();
  await expect(page.getByRole('heading', { name: 'Exchange rates', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'EUR' }).click(); // "Needed: EUR" pre-fills the form
  await expect(page.getByLabel('Currency')).toHaveValue('EUR');
  await page.getByLabel('1 EUR = ? USD').fill('1.5');
  await page.getByLabel('Valid from').fill('2020-01-01');
  await page.getByRole('button', { name: 'Add rate' }).click();
  await expect(page.getByText('Rate for EUR saved')).toBeVisible();
  await expect(page.getByText('1 EUR = 1.5 USD')).toBeVisible();
  await expect(page.getByText('In use')).toBeVisible();

  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'aren’t included' })).toHaveCount(0);
  await expect(openPipeline.getByText('$4K', { exact: true })).toBeVisible(); // 1000 + 2000 × 1.5
});
