import { expect, test } from '@playwright/test';
import { api, signUp, uniq } from './helpers.ts';

test('round-robin booking page: two people share the link, bookings take turns', async ({ page, browser, baseURL }) => {
  await signUp(page);
  const roles = (await api(page, 'GET', '/roles')).data;
  const inv = await api(page, 'POST', '/users/invite', { email: `${uniq('rita')}@example.com`, name: 'Rita Rep', roleId: roles.find((r: any) => r.name === 'Sales rep').id });
  const other = await browser.newContext();
  const accept = await (await other.newPage()).request.post(`${baseURL}/api/v1/auth/accept-invite`,
    { data: { token: inv.inviteUrl.split('/invite/')[1], name: 'Rita Rep', password: 'password123' }, headers: { 'x-requested-with': 'crm' } });
  expect(accept.ok()).toBe(true);
  await other.close();

  await page.goto('/settings/booking');
  await page.getByRole('button', { name: 'New booking page' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New booking page' });
  const slug = uniq('sales');
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Sales call');
  await dialog.getByRole('textbox', { name: 'Link' }).fill(slug);
  await expect(dialog.getByText('Bookings become their meetings.')).toBeVisible();
  await dialog.getByLabel('Rita Rep').check();
  await expect(dialog.getByText(/^Shared: a time is offered when any of them is free/)).toBeVisible();
  await expect(dialog.getByText('Everyone gets about the same number of bookings.')).toBeVisible();
  await dialog.getByLabel('Rita Rep’s share').selectOption('2');
  await expect(dialog.getByText('Out of every 3 bookings, about: Ada Admin 1, Rita Rep 2.')).toBeVisible();
  for (const d of ['Sat', 'Sun']) await dialog.getByLabel(d, { exact: true }).check();
  await dialog.getByLabel('From').fill('00:00');
  await dialog.getByLabel('Until').fill('23:30');
  await dialog.getByLabel('Notice (hours)').fill('1');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Booking page created')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Booking pages' })).toContainText('Ada Admin, Rita Rep');

  const saved = (await api(page, 'GET', '/booking-pages')).data.find((x: any) => x.slug === slug);
  expect(saved.hostWeights).toEqual([1, 2]);

  // Two customers book; the bookings go to different people.
  const info = await (await page.request.get(`/api/v1/public/book/${slug}`)).json();
  expect(info.team).toBe(true);
  const slots = info.days.flatMap((d: any) => d.slots);
  for (const [i, n] of [[0, 1], [2, 2]] as const) {
    const r = await page.request.post(`/api/v1/public/book/${slug}`, { data: { start: slots[i], name: `Customer ${n}`, email: `${uniq('c')}@example-customer.test` } });
    expect(r.status()).toBe(201);
  }
  await page.reload();
  await page.getByRole('button', { name: '2 upcoming' }).click();
  const list = page.getByRole('list', { name: 'Bookings' });
  await expect(list.getByText('· with Ada Admin')).toBeVisible();
  await expect(list.getByText('· with Rita Rep')).toBeVisible();
});
