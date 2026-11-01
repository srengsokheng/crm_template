import { expect, test } from '@playwright/test';
import { signUp } from './helpers.ts';

test('sign up, sign out, sign in, and protected routes', async ({ page }) => {
  const email = await signUp(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/deals');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('incorrect');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Ada/ })).toBeVisible();
});

test('sign-up validation shows field errors', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Work email').fill('not-an-email');
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByText('At least 8 characters', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Invalid email address')).toBeVisible();
});
