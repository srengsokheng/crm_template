import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('fields locked for a role are left out of the "New deal" form, and creating still works', async ({ page, browser }) => {
  await signUp(page);
  const region = await api(page, 'POST', '/fields', { entityType: 'deal', label: 'Region', type: 'text' });
  const roles = await api(page, 'GET', '/roles');
  const rep = roles.data.find((r: any) => r.name === 'Sales rep');
  await api(page, 'PATCH', `/roles/${rep.id}`, { fieldRules: { deal: { amount: 'readonly', ownerId: 'readonly', [`custom.${region.key}`]: 'readonly' } } });
  const inv = await api(page, 'POST', '/users/invite', { email: `rep${Date.now()}@example.com`, name: 'Rita Rep', roleId: rep.id });

  const ctx = await browser.newContext();
  const rp = await ctx.newPage();
  await rp.goto(new URL(inv.inviteUrl).pathname);
  await rp.getByLabel('Choose a password').fill('password123');
  await rp.getByRole('button', { name: 'Join workspace' }).click();
  await expect(rp.getByRole('heading', { name: /Rita/ })).toBeVisible();

  await rp.getByRole('button', { name: 'Create new' }).click();
  await rp.getByRole('menuitem', { name: 'Deal' }).click();
  const form = rp.getByRole('dialog');
  await expect(form.getByLabel('Deal name')).toBeVisible();
  await expect(form.getByLabel('Expected close')).toBeVisible(); // not locked
  await expect(form.getByLabel('Amount')).toHaveCount(0);
  await expect(form.getByLabel('Owner')).toHaveCount(0);
  await expect(form.getByLabel('Region')).toHaveCount(0);
  await form.getByLabel('Deal name').fill('Rep deal');
  await form.getByRole('button', { name: /^Create/ }).click();
  await expect(rp.getByRole('heading', { name: 'Rep deal' })).toBeVisible();
  await ctx.close();
});
