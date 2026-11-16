import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('import products onto existing deals from the Deals page: lines added, problems listed, amount recalculated', async ({ page }) => {
  await signUp(page);
  await api(page, 'POST', '/products', { name: 'Picker robot', sku: 'PR-200', unitPrice: '1500', unit: 'pcs' });
  const deal = await api(page, 'POST', '/deals', { title: 'Warehouse robots' });

  await page.goto('/deals');
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByRole('menuitem', { name: 'Products on existing deals' }).click();
  await expect(page.getByRole('heading', { name: 'Import products on deals' })).toBeVisible();
  await expect(page.getByText('Each row adds one product line to a deal that already exists')).toBeVisible();
  const csv = 'Deal,Product,Qty,Unit price\nWarehouse robots,PR-200,2,\nWarehouse robots,Installation,1,800\nNo such deal,PR-200,1,\n';
  await page.getByLabel('CSV file').setInputFiles({ name: 'lines.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByLabel('Import column Deal as')).toHaveValue('deal');
  await expect(page.getByLabel('Import column Qty as')).toHaveValue('quantity');
  await expect(page.getByText('When a row matches an existing')).toHaveCount(0); // no duplicates step for lines
  await page.getByRole('button', { name: 'Review import' }).click();
  await expect(page.getByText('Rows with problems (1)')).toBeVisible();
  await expect(page.getByText(/no deal called "No such deal"/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByText('Import finished')).toBeVisible({ timeout: 20_000 });

  await page.goto(`/deals/${deal.id}`);
  await expect(page.getByText('Products (2)')).toBeVisible();
  await expect(page.getByText('$3,800').first()).toBeVisible(); // 2 × 1,500 + 800
});
