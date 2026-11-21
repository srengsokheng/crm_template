import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('admins browse and filter the audit log', async ({ page }) => {
  await signUp(page);
  const c = await api(page, 'POST', '/contacts', { firstName: 'Audit', lastName: 'Target' });
  await api(page, 'PATCH', `/contacts/${c.id}`, { jobTitle: 'CFO' });
  await api(page, 'POST', '/companies', { name: 'Logged Co' });

  await page.goto('/settings');
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Logged Co' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Job title → CFO' })).toBeVisible();

  await page.getByRole('combobox', { name: 'Type' }).selectOption('contact');
  await expect(page.getByRole('row').filter({ hasText: 'Logged Co' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Action' }).selectOption('updated');
  await expect(page.getByText('1 total')).toBeVisible();
  await page.getByRole('link', { name: 'Audit Target' }).click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${c.id}$`));

  await page.goBack();
  await page.getByRole('combobox', { name: 'Who' }).selectOption('automation');
  await expect(page.getByText('No changes match these filters')).toBeVisible();
});
