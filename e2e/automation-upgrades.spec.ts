import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('working hours in workspace settings and a "field changes" rule that runs', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings/workspace');
  await page.getByLabel('Time zone').selectOption('Asia/Phnom_Penh');
  await page.getByRole('group', { name: 'Working days' }).getByRole('button', { name: 'Sat' }).click();
  await page.getByLabel('Day starts').fill('08:00');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Workspace saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Phnom_Penh');
  await expect(page.getByRole('group', { name: 'Working days' }).getByRole('button', { name: 'Sat' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Day starts')).toHaveValue('08:00');

  await page.goto('/settings/automation');
  const card = page.locator('section', { hasText: 'When a field of a deal changes' });
  await card.getByRole('button', { name: 'Add rule' }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByLabel('Field', { exact: true }).selectOption('amount');
  await drawer.getByLabel('Then').selectOption('add_note');
  await drawer.getByLabel('Note', { exact: true }).fill('Amount changed to {{amount}}');
  await drawer.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByText('Rule saved')).toBeVisible();
  await expect(card.getByText(/Amount changes: immediately/i)).toBeVisible();

  // The rule really runs (the e2e server processes jobs inline).
  const d = await api(page, 'POST', '/deals', { title: 'Field rule deal', amount: '100' });
  await api(page, 'PATCH', `/deals/${d.id}`, { amount: '999' });
  // The background worker adds the note a moment later; the page doesn't poll, so reload until it shows.
  await expect(async () => {
    await page.goto(`/deals/${d.id}`);
    await expect(page.getByText('Amount changed to USD 999')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
});
