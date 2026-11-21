import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('find duplicates: merge one pair, dismiss another', async ({ page }) => {
  await signUp(page);
  await api(page, 'POST', '/contacts', { firstName: 'Hank', lastName: 'Scorpio', jobTitle: 'CEO', methods: [{ kind: 'email', value: 'hank@globex.example.com' }] });
  await api(page, 'POST', '/contacts', { firstName: 'Hank', lastName: 'S.', methods: [{ kind: 'email', value: 'hank@globex.example.com' }] });
  await api(page, 'POST', '/contacts', { firstName: 'Sam', lastName: 'Smith' });
  await api(page, 'POST', '/contacts', { firstName: 'Sam', lastName: 'Smith' });

  await page.goto('/contacts');
  await page.getByRole('button', { name: 'Find duplicates' }).click();
  await expect(page.getByRole('heading', { name: 'Find duplicates' })).toBeVisible();
  await expect(page.getByText('2 possible pairs, strongest matches first.')).toBeVisible();

  const hank = page.getByRole('listitem').filter({ hasText: 'Same email: hank@globex.example.com' });
  await hank.getByRole('button', { name: 'Merge…' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText('Which contact do you keep?')).toBeVisible();
  await dlg.getByRole('button', { name: /^Merge into/ }).click();
  await expect(page.getByText('Contacts merged')).toBeVisible();
  await expect(page.getByText('1 possible pair, strongest matches first.')).toBeVisible();
  await expect(page).toHaveURL(/\/duplicates\/contact$/); // stays on the page

  const sam = page.getByRole('listitem').filter({ hasText: 'Same name' });
  await sam.getByRole('button', { name: 'Not a duplicate' }).click();
  await expect(page.getByText('No duplicate contacts found')).toBeVisible();

  await page.getByRole('tab', { name: 'Companies' }).click();
  await expect(page).toHaveURL(/\/duplicates\/company$/);
  await expect(page.getByText('No duplicate companies found')).toBeVisible();
});
