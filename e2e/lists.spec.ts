import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('contacts list: search, sort, paginate, bulk delete and restore', async ({ page }) => {
  await signUp(page);
  const names = Array.from({ length: 30 }, (_, i) => `Person${String(i).padStart(2, '0')}`);
  for (const n of names) await api(page, 'POST', '/contacts', { firstName: n, lastName: 'Bulk', methods: [{ kind: 'email', value: `${n.toLowerCase()}@example.com` }] });
  await page.goto('/contacts');
  await expect(page.getByText('30 total')).toBeVisible();
  await expect(page.getByText('1 / 2')).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('2 / 2')).toBeVisible();
  await page.getByRole('button', { name: 'Name' }).click(); // sort by name asc
  await expect(page.locator('tbody tr').first()).toContainText('Person00');
  await page.getByRole('button', { name: 'Name' }).click(); // desc
  await expect(page.locator('tbody tr').first()).toContainText('Person29');
  await page.getByRole('textbox', { name: 'Search' }).fill('person07@');
  await expect(page.getByText('1 total')).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  // URL keeps the state
  expect(page.url()).toContain('q=person07');
  await page.getByRole('textbox', { name: 'Search' }).fill('');
  await expect(page.getByText('30 total')).toBeVisible();
  // Bulk delete two rows
  await page.getByLabel('Select row').nth(0).check();
  await page.getByLabel('Select row').nth(1).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('28 total')).toBeVisible();
  // Restore from recycle bin keeps the record id
  await page.goto('/settings/recycle-bin');
  await page.getByRole('button', { name: 'Restore' }).first().click();
  await expect(page.getByText('Contact restored')).toBeVisible();
  await page.goto('/contacts');
  await expect(page.getByText('29 total')).toBeVisible();
});

test('global search and command palette navigate to records', async ({ page }) => {
  await signUp(page);
  await api(page, 'POST', '/companies', { name: 'Globex Corporation' });
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: 'Search' }).fill('globex');
  await page.getByRole('option').filter({ hasText: 'Globex Corporation' }).click();
  await expect(page.getByRole('heading', { name: 'Globex Corporation' })).toBeVisible();
});
