import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('activities open on the first tab that has something to do', async ({ page }) => {
  await signUp(page);
  // Nothing yet → Today.
  await page.goto('/activities');
  await expect(page.getByRole('tab', { name: /Today/ })).toHaveAttribute('aria-selected', 'true');
  // Only an upcoming task → Upcoming.
  await api(page, 'POST', '/activities', { kind: 'task', subject: 'Next week task', dueAt: new Date(Date.now() + 5 * 86400_000).toISOString() });
  await page.goto('/activities');
  await expect(page.getByRole('tab', { name: /Upcoming/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Next week task')).toBeVisible();
  // An overdue task wins.
  await api(page, 'POST', '/activities', { kind: 'call', subject: 'Late call', dueAt: new Date(Date.now() - 2 * 86400_000).toISOString() });
  await page.goto('/activities');
  await expect(page.getByRole('tab', { name: /Overdue/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Late call')).toBeVisible();
  // Choosing a tab is kept in the URL and respected on reload.
  await page.getByRole('tab', { name: /Today/ }).click();
  await expect(page).toHaveURL(/bucket=today/);
  await page.reload();
  await expect(page.getByRole('tab', { name: /Today/ })).toHaveAttribute('aria-selected', 'true');
});
