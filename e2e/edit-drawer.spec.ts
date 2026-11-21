import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('deal: edit several fields at once in a drawer; only changes are saved; a conflicting save is refused', async ({ page }) => {
  await signUp(page);
  const co = await api(page, 'POST', '/companies', { name: 'Umbrella Foods' });
  const deal = await api(page, 'POST', '/deals', { title: 'Arms', amount: '1000', description: 'First note' });
  await page.goto(`/deals/${deal.id}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit deal' });
  await expect(dlg.getByLabel('Deal name')).toHaveValue('Arms');
  await expect(dlg.getByLabel('Stage')).toHaveCount(0); // stage moves stay on the stage bar
  await dlg.getByLabel('Deal name').fill('Arms for Umbrella');
  await dlg.getByLabel('Amount').fill('2500');
  await dlg.getByLabel('Expected close').fill('2027-01-31');
  await dlg.getByLabel('Company').click();
  await page.getByRole('textbox', { name: 'Search' }).fill('Umbrella');
  await page.getByRole('option', { name: /Umbrella Foods/ }).click();
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Deal saved')).toBeVisible();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Arms for Umbrella' })).toBeVisible();
  const saved = await api(page, 'GET', `/deals/${deal.id}`);
  expect(saved).toMatchObject({ title: 'Arms for Umbrella', amount: '2500.00', expectedCloseDate: '2027-01-31', companyId: co.id, description: 'First note' });
  // History: one change event with exactly the edited fields (the description wasn't touched).
  const ev = (await api(page, 'GET', `/timeline/deal/${deal.id}`)).items.find((i: any) => i.type === 'event' && i.data.action === 'updated');
  expect(Object.keys(ev.data.changes).sort()).toEqual(['amount', 'company_id', 'expected_close_date', 'title']);
  expect(ev.data.changes).not.toHaveProperty('description');

  // Someone else saves while the drawer is open: ours is refused, nothing is overwritten.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await dlg.getByLabel('Description').fill('My version');
  await api(page, 'PATCH', `/deals/${deal.id}`, { description: 'Their version' });
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('This record was changed by someone else')).toBeVisible();
  await expect(dlg).toBeVisible();
  expect((await api(page, 'GET', `/deals/${deal.id}`)).description).toBe('Their version');
});

test('contact: edit name, job title, phone and notes together', async ({ page }) => {
  await signUp(page);
  const c = await api(page, 'POST', '/contacts', { firstName: 'Dara', lastName: 'Sok', methods: [{ kind: 'email', value: 'dara@umbrella.test' }] });
  await page.goto(`/contacts/${c.id}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit contact' });
  await expect(dlg.getByLabel('First name')).toHaveValue('Dara');
  await dlg.getByLabel('Last name').fill('Chea');
  await dlg.getByLabel('Job title').fill('Buyer');
  await dlg.getByLabel('Notes').fill('Prefers Telegram');
  await dlg.getByRole('button', { name: 'Add phone' }).click();
  await dlg.getByRole('textbox', { name: 'Phone' }).last().fill('+855 12 345 678');
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Contact saved')).toBeVisible();
  const saved = await api(page, 'GET', `/contacts/${c.id}`);
  expect(saved).toMatchObject({ firstName: 'Dara', lastName: 'Chea', jobTitle: 'Buyer', description: 'Prefers Telegram' });
  expect(saved.methods.map((m: any) => m.kind).sort()).toEqual(['email', 'phone']);
  await expect(page.getByRole('heading', { name: 'Dara Chea' })).toBeVisible();
});

test('company and lead: edit drawers save only what changed', async ({ page }) => {
  await signUp(page);
  const co = await api(page, 'POST', '/companies', { name: 'Umbrella', methods: [{ kind: 'website', value: 'https://umbrella.test' }] });
  await page.goto(`/companies/${co.id}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  let dlg = page.getByRole('dialog', { name: 'Edit company' });
  await dlg.getByLabel('Company name').fill('Umbrella Foods');
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Company saved')).toBeVisible();
  const savedCo = await api(page, 'GET', `/companies/${co.id}`);
  expect(savedCo.name).toBe('Umbrella Foods');
  expect(savedCo.methods.map((m: any) => m.value)).toEqual(['https://umbrella.test']); // untouched

  const lead = await api(page, 'POST', '/leads', { firstName: 'Vanna', companyName: 'Acme', amount: '100' });
  await page.goto(`/leads/${lead.id}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  dlg = page.getByRole('dialog', { name: 'Edit lead' });
  await expect(dlg.getByLabel('Stage')).toHaveCount(0);
  await dlg.getByLabel('Estimated value').fill('900');
  await dlg.getByLabel('Job title').fill('Owner');
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Lead saved')).toBeVisible();
  expect(await api(page, 'GET', `/leads/${lead.id}`)).toMatchObject({ amount: '900.00', jobTitle: 'Owner', firstName: 'Vanna', stageId: lead.stageId });
});
