import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('undo a merge from the kept contact: the other contact comes back with its deal', async ({ page }) => {
  await signUp(page);
  const a = await api(page, 'POST', '/contacts', { firstName: 'Ada', lastName: 'Lovelace', methods: [{ kind: 'email', value: 'ada@example.com' }] });
  const b = await api(page, 'POST', '/contacts', { firstName: 'Ada', lastName: 'L.', methods: [{ kind: 'email', value: 'ada@example.com' }] });
  await api(page, 'POST', '/deals', { title: 'Engines for Ada', contactIds: [b.id] });
  await api(page, 'POST', '/merge/contact', { survivorId: a.id, mergedId: b.id });

  await page.goto(`/contacts/${a.id}`);
  await expect(page.getByText(/Merged with “Ada L\.”/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Engines for Ada' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo merge' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Undo merge' }).click();
  await expect(page.getByText('Merge undone — “Ada L.” is back')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo merge' })).toHaveCount(0); // banner gone (history still mentions the merge)
  await expect(page.getByRole('link', { name: 'Engines for Ada' })).toHaveCount(0);

  await page.goto(`/contacts/${b.id}`);
  await expect(page.getByRole('heading', { name: 'Ada L.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Engines for Ada' })).toBeVisible();
  await expect(page.getByText(/the merge into Ada Lovelace was undone/)).toBeVisible();
});
