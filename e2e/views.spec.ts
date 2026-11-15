import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('save, apply, rename and delete a list view', async ({ page }) => {
  await signUp(page);
  for (const n of ['Alpha Buyer', 'Beta Buyer', 'Gamma Seller']) {
    const [f, l] = n.split(' ');
    await api(page, 'POST', '/contacts', { firstName: f, lastName: l });
  }
  await page.goto('/contacts');
  const bar = page.getByRole('toolbar', { name: 'Saved views' });
  await expect(bar.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.getByRole('button', { name: 'Save view' })).toHaveCount(0); // nothing to save yet

  await page.getByRole('textbox', { name: 'Search' }).fill('buyer');
  await expect(page.getByText('2 total')).toBeVisible();
  await bar.getByRole('button', { name: 'Save view' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Buyers');
  await page.getByRole('dialog').getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByText('View saved')).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Buyers', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Back to everything, then one click restores the view.
  await bar.getByRole('button', { name: 'All' }).click();
  await expect(page.getByText('3 total')).toBeVisible();
  await bar.getByRole('button', { name: 'Buyers', exact: true }).click();
  await expect(page.getByText('2 total')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search' })).toHaveValue('buyer');

  // It survives a reload (stored on the server).
  await page.reload();
  await expect(bar.getByRole('button', { name: 'Buyers', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await bar.getByRole('button', { name: 'Options for Buyers' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Buyers only');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(bar.getByRole('button', { name: 'Buyers only', exact: true })).toBeVisible();

  await bar.getByRole('button', { name: 'Options for Buyers only' }).click();
  await page.getByRole('menuitem', { name: 'Delete view' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete view' }).click();
  await expect(bar.getByRole('button', { name: 'Buyers only', exact: true })).toHaveCount(0);
  await expect(page.getByText('3 total')).toBeVisible();
});
