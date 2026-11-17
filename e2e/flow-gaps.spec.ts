import { expect, test } from '@playwright/test';
import { api, meta, signUp } from './helpers.ts';

test('your account: change your name and password from the account menu', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Your account' }).click();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await page.getByLabel('Name').fill('Ada King');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Name saved')).toBeVisible();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menu').getByText('Ada King')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.locator('#acc-current').fill('wrong-password');
  await page.locator('#acc-new').fill('a-new-password');
  await page.locator('#acc-confirm').fill('a-new-password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Not correct', { exact: true })).toBeVisible();
  await page.locator('#acc-current').fill('password123');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed')).toBeVisible();
  await expect(page.locator('#acc-current')).toHaveValue('');
});

test('product categories: add one in Lists & options, then use it on a product', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings/lists');
  await page.getByRole('button', { name: 'Product categories' }).click();
  await expect(page.getByText('No categories yet.')).toBeVisible();
  await page.getByLabel('New category').fill('Robot arms');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Category added')).toBeVisible();
  await expect(page.getByLabel('Category name: Robot arms')).toBeVisible();
  await page.goto('/products');
  await page.getByRole('button', { name: /New product/ }).click();
  await expect(page.getByRole('dialog').getByLabel('Category').locator('option', { hasText: 'Robot arms' })).toHaveCount(1);
});

test('custom fields: move a field up', async ({ page }) => {
  await signUp(page);
  for (const label of ['Alpha', 'Beta']) await api(page, 'POST', '/fields', { entityType: 'deal', label, type: 'text' });
  await page.goto('/settings/fields');
  await expect(page.getByRole('button', { name: 'Move Alpha up' })).toBeDisabled();
  await page.getByRole('button', { name: 'Move Beta up' }).click();
  await expect(page.getByRole('button', { name: 'Move Beta up' })).toBeDisabled();
  const m = await meta(page);
  expect(m.fields.filter((f: any) => f.entityType === 'deal').map((f: any) => f.label)).toEqual(['Beta', 'Alpha']);
});

test('a deal shows what automation did on it', async ({ page }) => {
  await signUp(page);
  const m = await meta(page);
  const pipe = m.pipelines.find((p: any) => p.entityType === 'deal');
  await api(page, 'POST', '/automation-rules', { entityType: 'deal', pipelineId: pipe.id, trigger: 'created', action: 'add_note', config: { text: 'Thanks for the lead!' } });
  const deal = await api(page, 'POST', '/deals', { title: 'Automated deal' });
  // The rule runs in the background worker a moment after the deal is created.
  await expect.poll(async () => (await api(page, 'GET', `/automation-runs/deal/${deal.id}`)).data.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.goto(`/deals/${deal.id}`);
  const card = page.locator('section').filter({ hasText: /^Automation/ });
  await expect(card.getByText('Add a note')).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText('when created')).toBeVisible();
});
