import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('export a filtered list to CSV', async ({ page }) => {
  await signUp(page);
  for (const [f, l] of [['Alpha', 'Buyer'], ['Beta', 'Buyer'], ['Gamma', 'Seller']]) await api(page, 'POST', '/contacts', { firstName: f, lastName: l });
  await page.goto('/contacts');
  await page.getByRole('textbox', { name: 'Search' }).fill('buyer');
  await expect(page.getByText('2 total')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await readFile(await download.path(), 'utf8');
  const lines = text.trim() /* trim() also drops the BOM */.split('\r\n');
  expect(lines[0]).toMatch(/^ID,First name,Last name,/);
  expect(lines.slice(1).map((l) => l.split(',')[1]).sort()).toEqual(['Alpha', 'Beta']);

  // The deals board offers the same.
  await page.goto('/deals');
  await expect(page.getByRole('link', { name: 'Export' })).toBeVisible();
});
