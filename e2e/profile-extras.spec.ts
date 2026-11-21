import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('account: time zone for emails, and signing out other devices', async ({ page, browser }) => {
  const email = await signUp(page);
  await page.goto('/settings/account');
  await page.getByLabel('Time zone for your emails').selectOption('Asia/Phnom_Penh');
  await expect(page.getByText('Emails will use Asia/Phnom Penh time')).toBeVisible();
  expect((await api(page, 'GET', '/auth/me')).user.timezone).toBe('Asia/Phnom_Penh');
  await page.getByLabel('Time zone for your emails').selectOption('');
  await expect(page.getByText('Emails will use the workspace time zone')).toBeVisible();

  // A second browser signs in; this one sees it and signs it out.
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto('/login');
  await p2.getByLabel('Email').fill(email);
  await p2.getByLabel('Password').fill('password123');
  await p2.getByRole('button', { name: /Sign in/ }).click();
  await expect(p2).not.toHaveURL(/login/);
  await page.reload();
  const card = page.locator('section').filter({ hasText: /^Where you’re signed in/ });
  await expect(card).toContainText('This device');
  await card.getByRole('button', { name: 'Sign out on the other device' }).click();
  await expect(page.getByText('Signed out on 1 other device')).toBeVisible();
  await expect(card).toContainText('You’re only signed in here.');
  await p2.goto('/');
  await expect(p2).toHaveURL(/login/);
  await other.close();
});
