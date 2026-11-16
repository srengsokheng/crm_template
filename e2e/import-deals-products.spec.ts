import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('import products with a new category (admin adds missing list values), then deals linked to a contact', async ({ page }) => {
  await signUp(page);

  // Products: the category "Spare parts" doesn't exist yet.
  await page.goto('/products');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('heading', { name: 'Import products' })).toBeVisible();
  const products = 'Product,SKU,Price,VAT %,Category\nPicker robot,PR-200,1500,10,Spare parts\nGripper,GR-1,89.90,10,Spare parts\n';
  await page.getByLabel('CSV file').setInputFiles({ name: 'catalog.csv', mimeType: 'text/csv', buffer: Buffer.from(products) });
  await expect(page.getByText('5 of 5 columns will be imported')).toBeVisible();
  await expect(page.getByLabel('Import column Price as')).toHaveValue('unitPrice');
  await page.getByLabel('Add values that aren’t in the lists yet').check();
  await page.getByRole('button', { name: 'Review import' }).click();
  await expect(page.getByText('1 new list value will be added')).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByText('Import finished')).toBeVisible({ timeout: 20_000 });
  await page.goto('/products');
  await expect(page.getByRole('cell', { name: 'Picker robot' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Spare parts' }).first()).toBeVisible();

  // Deals: linked to an existing contact by email, company created on the fly.
  await api(page, 'POST', '/contacts', { firstName: 'Ada', lastName: 'Lovelace', methods: [{ kind: 'email', value: 'ada@example.com' }] });
  await page.goto('/deals');
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByRole('menuitem', { name: 'Deals', exact: true }).click(); // Import is a menu on Deals (deals / products on deals)
  await expect(page.getByRole('heading', { name: 'Import deals' })).toBeVisible();
  const deals = 'Deal name,Value,Stage,Account,Contact\nRobots for Acme,12500,Proposal,Acme Robotics,ada@example.com\n';
  await page.getByLabel('CSV file').setInputFiles({ name: 'pipeline.csv', mimeType: 'text/csv', buffer: Buffer.from(deals) });
  await expect(page.getByLabel('Import column Account as')).toHaveValue('company');
  await page.getByRole('button', { name: 'Review import' }).click();
  await expect(page.getByText('1 new company will be created for the Company column.')).toBeVisible();
  await page.getByRole('button', { name: 'Import 1 row' }).click();
  await expect(page.getByText('Import finished')).toBeVisible({ timeout: 20_000 });

  const found = await api(page, 'GET', '/deals?q=Robots');
  await page.goto(`/deals/${found.data[0].id}`);
  await expect(page.getByRole('heading', { name: 'Robots for Acme' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Acme Robotics' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ada Lovelace' })).toBeVisible();
  await expect(page.getByText(/by import of pipeline\.csv/).first()).toBeVisible();
});
