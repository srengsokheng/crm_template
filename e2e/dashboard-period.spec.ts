import { expect, test } from '@playwright/test';
import { api, meta, signUp } from './helpers.ts';

test('dashboard period picker: named periods and a custom range', async ({ page }) => {
  await signUp(page);
  const m = await meta(page);
  const won = m.pipelines.find((p: any) => p.entityType === 'deal').stages.find((s: any) => s.kind === 'won');
  const d = await api(page, 'POST', '/deals', { title: 'Closed today', amount: '500' });
  await api(page, 'POST', `/deals/${d.id}/move`, { stageId: won.id });
  await page.goto('/');
  const kpi = (label: string) => page.locator('div.surface').filter({ hasText: label }).first();
  await expect(kpi('Won this month')).toContainText('$500');
  await page.getByLabel('Period').selectOption('last_year');
  await expect(kpi('Won last year')).toContainText('$0');
  await expect(kpi('Win rate')).toContainText('0 won · 0 lost last year');
  await page.getByLabel('Period').selectOption('custom');
  const y = new Date().getFullYear();
  await page.getByLabel('From').fill(`${y}-01-01`);
  await page.getByLabel('To').fill(`${y}-12-31`);
  await expect(kpi('Won in this period')).toContainText('$500');
  // An impossible range is explained and not sent.
  await page.getByLabel('From').fill(`${y + 1}-01-01`);
  await expect(page.getByRole('alert')).toContainText('Pick a start date on or before the end date');
  // Remembered on the next visit.
  await page.getByLabel('Period').selectOption('year');
  await page.reload();
  await expect(page.getByLabel('Period')).toHaveValue('year');
  await expect(kpi('Won this year')).toContainText('$500');
});
