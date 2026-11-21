import { expect, test } from '@playwright/test';
import { signUp } from './helpers.ts';

test('admin allow-lists a host and adds a "Call a webhook" rule', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings/automation');
  const hooks = page.locator('section').filter({ has: page.getByText('Webhooks', { exact: true }) });
  await expect(hooks.getByText('Signing secret')).toBeVisible();

  // A rule for a host that isn't allowed yet is refused with a clear message.
  const created = page.locator('section').filter({ hasText: /^When a deal is created/ });
  await created.getByRole('button', { name: 'Add rule' }).click();
  await page.getByLabel('Then').selectOption('webhook');
  await page.getByLabel('URL').fill('https://hooks.example.com/crm');
  await page.getByRole('button', { name: /^(Create|Save)/ }).click();
  await expect(page.getByText(/not on the webhook allow-list/).first()).toBeVisible();
  await page.keyboard.press('Escape');

  await hooks.getByLabel('Allowed hosts').fill('hooks.example.com');
  await hooks.getByRole('button', { name: 'Save allow-list' }).click();
  await expect(page.getByText('Allow-list saved')).toBeVisible();
  await hooks.getByRole('button', { name: 'Show secret' }).click();
  await expect(hooks.getByText(/^whsec_/)).toBeVisible();

  await created.getByRole('button', { name: 'Add rule' }).click();
  await page.getByLabel('Then').selectOption('webhook');
  await page.getByLabel('URL').fill('https://hooks.example.com/crm');
  await page.getByRole('button', { name: /^(Create|Save)/ }).click();
  await expect(created.getByText('call hooks.example.com/crm')).toBeVisible();
});
