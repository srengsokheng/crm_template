import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('admin restricts a pipeline to Managers; a Viewer (who sees all other deals) can no longer see it or its deals', async ({ page, browser }) => {
  await signUp(page);
  const vip = await api(page, 'POST', '/pipelines', { entityType: 'deal', name: 'VIP' });
  const deal = await api(page, 'POST', '/deals', { title: 'VIP mega deal', pipelineId: vip.id });
  await api(page, 'POST', '/deals', { title: 'Everyday deal' });
  const roles = await api(page, 'GET', '/roles');
  const inv = await api(page, 'POST', '/users/invite', { email: `rep${Date.now()}@example.com`, name: 'Vera Viewer', roleId: roles.data.find((r: any) => r.name === 'Viewer').id });

  await page.goto('/settings/pipelines');
  const card = page.locator('section').filter({ has: page.getByRole('textbox', { name: 'Pipeline name' }).and(page.locator('[value="VIP"]')) });
  await expect(card.getByText('Everyone')).toBeVisible();
  await card.getByRole('button', { name: 'Change' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Only these roles').check();
  await dlg.getByRole('group', { name: 'Roles with access' }).getByLabel('Manager').check();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Access updated')).toBeVisible();
  await expect(card.getByText('Only Manager')).toBeVisible();

  const ctx = await browser.newContext();
  const rp = await ctx.newPage();
  await rp.goto(new URL(inv.inviteUrl).pathname);
  await rp.getByLabel('Choose a password').fill('password123');
  await rp.getByRole('button', { name: 'Join workspace' }).click();
  await expect(rp.getByRole('heading', { name: /Vera/ })).toBeVisible();
  await rp.goto('/deals?view=list');
  await expect(rp.getByText('Everyday deal')).toBeVisible();
  await expect(rp.getByText('VIP mega deal')).toHaveCount(0);
  await expect(rp.getByRole('combobox', { name: 'Pipeline' }).locator('option', { hasText: 'VIP' })).toHaveCount(0);
  await rp.goto(`/deals/${deal.id}`);
  await expect(rp.getByText('do not have permission')).toBeVisible();
  await ctx.close();
});
