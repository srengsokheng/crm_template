import { expect, test } from '@playwright/test';
import { api, meta, signUp } from './helpers.ts';

test('admin configures a field, a stage and an automation that fires', async ({ page }) => {
  await signUp(page);
  // Custom field
  await page.goto('/settings/fields');
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByLabel('Label').fill('Contract length');
  await page.getByLabel('Type').selectOption('number');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('contract_length')).toBeVisible();
  // New stage
  await page.goto('/settings/pipelines');
  await page.getByRole('button', { name: 'Add stage' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Demo booked');
  await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Stage added')).toBeVisible();
  // Automation: when entering Proposal → create a task
  await page.goto('/settings/automation');
  const proposal = page.locator('section').filter({ hasText: /enters\s*Proposal/ });
  await proposal.getByRole('button', { name: 'Add rule' }).click();
  await page.getByLabel('Subject').fill('Send proposal for {{title}}');
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(proposal.getByText('Send proposal for {{title}}')).toBeVisible();

  const m = await meta(page);
  const pipe = m.pipelines.find((p: any) => p.entityType === 'deal');
  const deal = await api(page, 'POST', '/deals', { title: 'Robots for Initech' });
  await page.goto(`/deals/${deal.id}`);
  await page.getByRole('listitem').filter({ hasText: 'Proposal' }).click();
  await expect(page.getByText('Moved to Proposal')).toBeVisible();
  // The inline worker runs every ~1.5s
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Complete Send proposal for Robots for Initech' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  // Custom field is editable on the record
  await page.getByRole('button', { name: 'Edit Contract length' }).click();
  await page.getByRole('spinbutton').fill('12');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('12', { exact: true })).toBeVisible();
  expect(pipe.stages.length).toBe(7);
});

test('roles: a sales rep cannot open admin settings or edit others’ deals', async ({ page, browser }) => {
  await signUp(page);
  const roles = await api(page, 'GET', '/roles');
  const rep = roles.data.find((r: any) => r.name === 'Sales rep');
  const inv = await api(page, 'POST', '/users/invite', { email: `rep${Date.now()}@example.com`, name: 'Rita Rep', roleId: rep.id });
  const adminDeal = await api(page, 'POST', '/deals', { title: 'Admin deal' });
  await api(page, 'POST', '/deals', { title: 'Secret deal', visibility: 'private' });
  const ctx = await browser.newContext();
  const rp = await ctx.newPage();
  await rp.goto(new URL(inv.inviteUrl).pathname);
  await rp.getByLabel('Choose a password').fill('password123');
  await rp.getByRole('button', { name: 'Join workspace' }).click();
  await expect(rp.getByRole('heading', { name: /Rita/ })).toBeVisible();
  await rp.goto('/settings/fields');
  await expect(rp.getByText('Admins only')).toBeVisible();
  await rp.goto(`/deals/${adminDeal.id}`);
  await expect(rp.getByText('do not have permission')).toBeVisible();
  await rp.goto('/deals?view=list');
  await expect(rp.getByText('No deals found')).toBeVisible();
  await ctx.close();
});
