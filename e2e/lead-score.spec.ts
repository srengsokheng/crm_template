import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('lead score: badge on the list and board, filter by tier, breakdown on the lead', async ({ page }) => {
  await signUp(page);
  const rich = await api(page, 'POST', '/leads', { title: 'Umbrella arms', firstName: 'Dara', companyName: 'Umbrella', jobTitle: 'Buyer', amount: '5000',
    methods: [{ kind: 'email', value: 'dara@umbrella.test' }, { kind: 'phone', value: '+855 12 345 678' }] });
  await api(page, 'POST', '/leads', { title: 'Walk-in' });

  await page.goto('/leads');
  await expect(page.getByRole('region', { name: /stage$/ }).first().getByText('Warm 50')).toBeVisible(); // board card
  await page.getByRole('tab', { name: 'List' }).click();
  await expect(page.getByRole('row', { name: /Umbrella arms/ })).toContainText('Warm 50');
  await expect(page.getByRole('row', { name: /Walk-in/ })).toContainText('Cold 0');
  await page.getByLabel('Score').selectOption('warm');
  await expect(page.getByRole('row', { name: /Walk-in/ })).toHaveCount(0);
  await expect(page.getByText('1 total')).toBeVisible();

  await page.goto(`/leads/${rich.id}`);
  const card = page.locator('section').filter({ hasText: /^Lead score/ });
  await expect(card).toContainText('Warm 50');
  await expect(card.getByRole('listitem').filter({ hasText: 'Has an email address' })).toContainText('10/10');
  await expect(card.getByRole('listitem').filter({ hasText: 'A next step is scheduled' })).toContainText('0/10');
});
