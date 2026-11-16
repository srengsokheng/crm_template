import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('admin sets the email sender name; members can turn the daily summary off', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings/workspace');
  const card = page.locator('section').filter({ has: page.getByText('Email delivery', { exact: true }) });
  await expect(card.getByLabel('Sender name')).toHaveValue('');
  await card.getByLabel('Sender name').fill('E2E Robotics Sales');
  await expect(card.getByText(/"E2E Robotics Sales" <.+>/)).toBeVisible(); // live preview of the From line
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Sender name saved')).toBeVisible();
  expect((await api(page, 'GET', '/settings/email')).senderName).toBe('E2E Robotics Sales');
  await page.reload();
  await expect(card.getByLabel('Sender name')).toHaveValue('E2E Robotics Sales');

  // Account menu: daily summary off and on again.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Turn off daily summary email' }).click();
  await expect(page.getByText('Daily summary turned off')).toBeVisible();
  expect((await api(page, 'GET', '/auth/me')).preferences.emailDigest).toBe(false);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Turn on daily summary email' })).toBeVisible();
});
