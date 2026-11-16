import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('admin locks the deal amount and hides a custom field for Sales reps; a rep sees a lock and no hidden field', async ({ page, browser }) => {
  await signUp(page);
  await api(page, 'POST', '/fields', { entityType: 'deal', label: 'Margin', type: 'number' });
  await api(page, 'POST', '/fields', { entityType: 'deal', label: 'Region', type: 'text' });
  const roles = await api(page, 'GET', '/roles');
  const inv = await api(page, 'POST', '/users/invite', { email: `rep${Date.now()}@example.com`, name: 'Rita Rep', roleId: roles.data.find((r: any) => r.name === 'Sales rep').id });

  // Admin: Settings → Roles → Sales rep → Field access.
  await page.goto('/settings/roles');
  await page.getByRole('button', { name: /^Sales rep/ }).click();
  await page.getByLabel('Amount (and products) access').selectOption('readonly');
  await page.getByLabel('Margin access').selectOption('hidden');
  await expect(page.getByRole('tab', { name: 'Deals (2)' })).toBeVisible();
  await page.getByRole('button', { name: 'Save role' }).click();
  await expect(page.getByText('Role saved')).toBeVisible();

  // Rep joins and opens a deal they own that has values in both fields.
  const ctx = await browser.newContext();
  const rp = await ctx.newPage();
  await rp.goto(new URL(inv.inviteUrl).pathname);
  await rp.getByLabel('Choose a password').fill('password123');
  await rp.getByRole('button', { name: 'Join workspace' }).click();
  await expect(rp.getByRole('heading', { name: /Rita/ })).toBeVisible();
  const repMe = await api(rp, 'GET', '/auth/me');
  const meta = await api(page, 'GET', '/meta');
  const key = (label: string) => meta.fields.find((f: any) => f.label === label).key;
  const deal = await api(page, 'POST', '/deals', { title: 'Locked deal', amount: '4200', ownerId: repMe.user.id, custom: { [key('Margin')]: 30, [key('Region')]: 'APAC' } });

  await rp.goto(`/deals/${deal.id}`);
  await expect(rp.getByRole('heading', { name: 'Locked deal' })).toBeVisible();
  await expect(rp.getByRole('img', { name: 'Amount is read-only for your role' })).toBeVisible();
  await expect(rp.getByRole('button', { name: 'Edit Amount' })).toHaveCount(0);
  await expect(rp.getByRole('button', { name: 'Edit Deal name' })).toBeVisible(); // other fields stay editable
  await expect(rp.getByText('APAC')).toBeVisible();
  await expect(rp.getByText('Margin')).toHaveCount(0);
  // Products follow the amount lock: no Add/Edit on the products card.
  const products = rp.locator('section').filter({ hasText: /^Products \(/ });
  await expect(products.getByRole('button', { name: /^(Add|Edit)$/ })).toHaveCount(0);

  // Editing a free field still works.
  await rp.getByRole('button', { name: 'Edit Deal name' }).click();
  await rp.getByRole('textbox').first().fill('Locked deal (renamed)');
  await rp.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rp.getByRole('heading', { name: 'Locked deal (renamed)' })).toBeVisible();
  await ctx.close();
});
