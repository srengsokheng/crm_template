import { expect, test } from '@playwright/test';
import { api, signUp } from './helpers.ts';

test('invoice: record a partial payment, email it, find it on the Invoices page; then pay the rest', async ({ page }) => {
  await signUp(page);
  const contact = await api(page, 'POST', '/contacts', { firstName: 'Ada', methods: [{ kind: 'email', value: 'ada@customer.test' }] });
  const deal = await api(page, 'POST', '/deals', { title: 'Warehouse robots', contactIds: [contact.id] });
  await api(page, 'PUT', `/deals/${deal.id}/line-items`, { items: [{ name: 'Picker robot', unitPrice: '1000', quantity: 1, unit: 'pcs' }] });
  const inv = await api(page, 'POST', `/deals/${deal.id}/documents`, { kind: 'invoice' });

  // Email the draft: it is issued (numbered) and sent.
  await page.goto(`/documents/${inv.id}`);
  await page.getByRole('button', { name: 'Send by email' }).click();
  const mail = page.getByRole('dialog');
  await expect(mail.getByText('ada@customer.test')).toBeVisible(); // suggested from the deal's contact
  await expect(mail.getByLabel('Subject')).toHaveValue(/^Invoice from /);
  await mail.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByText('Invoice INV-0001 emailed to ada@customer.test')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Invoice INV-0001/ })).toBeVisible();
  await expect(page.getByText(/· emailed /)).toBeVisible();

  // Partial payment.
  await page.getByRole('button', { name: 'Record payment' }).first().click();
  const pay = page.getByRole('dialog');
  await expect(pay.getByLabel('Amount (USD)')).toHaveValue('1000.00');
  await pay.getByLabel('Amount (USD)').fill('400');
  await pay.getByLabel('Method').fill('Bank transfer');
  await pay.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText('Payment recorded — $600 still due')).toBeVisible();
  await expect(page.getByText('Partially paid')).toBeVisible();
  await expect(page.getByText('Payments (1)')).toBeVisible();

  // The Invoices page lists it as unpaid with the outstanding balance.
  await page.getByRole('link', { name: 'Invoices' }).first().click();
  await expect(page.getByRole('heading', { name: 'Quotes & invoices' })).toBeVisible();
  await expect(page.getByText('Outstanding')).toBeVisible();
  await expect(page.getByText('$600').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Unpaid' }).click();
  await expect(page.getByRole('cell', { name: /Invoice INV-0001/ })).toBeVisible();
  await page.getByRole('cell', { name: /Invoice INV-0001/ }).click();

  // Pay the rest.
  await page.getByRole('button', { name: 'Record payment' }).first().click();
  await expect(page.getByRole('dialog').getByLabel('Amount (USD)')).toHaveValue('600.00');
  await page.getByRole('dialog').getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText('Invoice INV-0001 is paid in full')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Invoice INV-0001/ }).getByText('Paid')).toBeVisible();
});
