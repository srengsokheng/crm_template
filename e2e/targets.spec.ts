import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('sales targets: set them in Settings, win a deal, the dashboard shows progress', async ({ page }) => {
  await signUp(page);
  // Without targets, the admin is invited to set some.
  await page.goto('/');
  await page.getByRole('link', { name: 'Set targets' }).click();
  await expect(page).toHaveURL(/\/settings\/targets$/);

  const month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  await expect(page.getByText(month, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.getByLabel('Target for the whole team').fill('20000');
  await page.getByLabel('Target for Ada Admin').fill('8000');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Targets saved')).toBeVisible();

  // The next month starts empty; last month's targets can be copied into it.
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page.getByLabel('Target for Ada Admin')).toHaveValue('');
  await page.getByRole('button', { name: /^Copy .*’s targets$/ }).click();
  await expect(page.getByLabel('Target for Ada Admin')).toHaveValue('8000');
  await page.getByRole('button', { name: 'Previous month' }).click();

  // Win a deal this month: progress on the dashboard.
  const deal = await api(page, 'POST', '/deals', { title: 'Robot arms for Umbrella Foods', amount: '6000.50' });
  await api(page, 'POST', `/deals/${deal.id}/close`, { outcome: 'won' });
  await page.goto('/');
  await expect(page.getByText(`Targets — ${month}`)).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Ada Admin: 75% of target' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Whole team: 30% of target' })).toBeVisible();
  await expect(page.getByText('$6,000.50 of $8,000')).toBeVisible();
});
