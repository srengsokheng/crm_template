import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('team performance report: deals won, target reached, activities, per person, with CSV export', async ({ page }) => {
  await signUp(page);
  const me = await api(page, 'GET', '/auth/me');
  const month = new Date().toISOString().slice(0, 7);
  await api(page, 'PUT', '/targets', { month, targets: [{ userId: me.user.id, amount: '10000' }] });
  for (const amount of ['3000', '2000']) {
    const d = await api(page, 'POST', '/deals', { title: `Arms ${amount}`, amount });
    await api(page, 'POST', `/deals/${d.id}/close`, { outcome: 'won' });
  }
  await api(page, 'POST', '/activities', { kind: 'call', subject: 'Follow-up call', status: 'done', dueAt: new Date().toISOString() });

  await page.goto('/reports');
  await page.getByRole('navigation', { name: 'Reports' }).getByRole('button', { name: 'Team performance' }).click();
  await expect(page.getByRole('heading', { name: 'Team performance' })).toBeVisible();
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader', { name: 'Reply time' })).toBeVisible();
  const row = table.getByRole('row', { name: new RegExp(me.user.name) });
  await expect(row).toContainText('$5,000');
  await expect(row).toContainText('$10,000');
  await expect(row).toContainText('50%'); // of target
  await expect(row).toContainText('100%'); // win rate
  await expect(page.locator('div.text-xs', { hasText: /^Deals won$/ })).toBeVisible(); // totals
  const csv = page.getByRole('link', { name: 'Export CSV' });
  await expect(csv).toHaveAttribute('href', /\/api\/v1\/reports\/team-performance\?.*format=csv/);
});
